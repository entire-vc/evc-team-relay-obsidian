import { MarkdownView, type TextFileView } from "obsidian";
import { getPatchRegistry } from "./PatchRegistry";
import { Loggable } from "src/logging";
import { Document } from "./Document";
import { ViewSurfaceBridge } from "./viewSync/ViewSurfaceBridge";

import { isBoundText, type DocumentViewBinding } from "./ViewBindings";
import type { Text as YText, YTextEvent, Transaction } from "yjs";
import { applyDiffToYText } from "./ytextDiff";
import { firstDifference, excerptAround } from "./textMismatch";

type PatchTarget = Record<string, (...args: unknown[]) => unknown>;

/**
 * Resolve the Document instance that actually corresponds to the view's
 * current TFile. `view.boundDocument` can go stale (e.g. after a file rename swaps
 * which VaultShare owns a path) — this re-derives it from the live file
 * whenever the cached one no longer matches.
 */
function resolveDocumentForView(
	view: DocumentViewBinding<TextFileView>,
	cached: Document | undefined,
	log: (msg: string, extra?: unknown) => void,
): Document | undefined {
	const file = view.hostView.file;
	if (file) {
		if (cached?._obsidianFile === file) {
			return cached;
		}
		log("[TextViewPatch] resolveDocument() lookup:", {
			filePath: file.path,
			currentDocPath: cached?.entryPath,
			currentDocTFile: cached?._obsidianFile?.path,
		});
		const folder = view.registry.shareRegistry.shareFor(file.path);
		if (folder) {
			const resolved = folder.rootRelative.docAt(file.path);
			log("[TextViewPatch] resolveDocument() found:", {
				newDocPath: resolved.entryPath,
				newDocGuid: resolved.entityGuid,
				newDocTFile: resolved._obsidianFile?.path,
			});
			return resolved;
		}
	}
	// Nothing resolved above; fall back to whatever document the DocumentViewBinding already has
	if (view.boundDocument) {
		log("[TextViewPatch] resolveDocument() using fallback:", {
			fallbackDocPath: view.boundDocument.entryPath,
			fallbackDocGuid: view.boundDocument.entityGuid,
		});
		return view.boundDocument;
	}
	return undefined;
}

export class TextViewPatch extends Loggable {
	boundView: DocumentViewBinding<TextFileView>;
	boundDoc: Document | undefined;
	_crdtTextRef?: YText;
	textObserver?: (event: YTextEvent, tr: Transaction) => void;
	unsubscribeFns: Array<() => void>;
	private isDestroyed = false;
	private isSaving = false;
	surfaceBridge?: ViewSurfaceBridge;

	resolveDocument(): Document | undefined {
		this.boundDoc = resolveDocumentForView(this.boundView, this.boundDoc, (msg, extra) =>
			this.warn(msg, extra),
		);
		return this.boundDoc;
	}

	constructor(view: DocumentViewBinding<TextFileView>) {
		super();
		this.boundView = view;
		this.boundDoc = view.boundDocument;
		this.unsubscribeFns = [];
		this.isSaving = false;

		this.reconcileDocumentWithView();

		if (this.boundView.hostView instanceof MarkdownView) {
			this.surfaceBridge = new ViewSurfaceBridge(this.boundView.hostView, this.boundDoc);
		}

		this.installPatches();
	}

	/** Validate that document TFile matches view file and swap to the correct document if not. */
	private reconcileDocumentWithView(): void {
		const documentTFile = this.boundDoc?._obsidianFile;
		const viewFile = this.boundView.hostView?.file;
		if (documentTFile === viewFile) {
			return;
		}
		this.error("[TextViewPatch] fatal: view is bound to the wrong TFile!", {
			documentPath: this.boundDoc?.entryPath,
			documentTFilePath: documentTFile?.path,
			viewFilePath: viewFile?.path,
			viewType: this.boundView.hostView?.getViewType?.(),
			documentGuid: this.boundDoc?.entityGuid,
			tFilesSame: documentTFile === viewFile,
		});
		const correctDoc = this.resolveDocument();
		if (correctDoc) {
			this.boundDoc = correctDoc;
			this.warn("[TextViewPatch] rebound to the correct document:", {
				newDocPath: this.boundDoc.entryPath,
				newDocGuid: this.boundDoc.entityGuid,
			});
		}
	}

	private canResync(): boolean {
		return (
			isBoundText(this.boundView) &&
			!this.boundView.isTracking &&
			!this.isDestroyed &&
			!!this.boundView.hostView.file
		);
	}

	async resyncView() {
		if (!this.canResync() || !isBoundText(this.boundView)) {
			return;
		}

		this.boundDoc = this.resolveDocument();
		if (!this.boundDoc) {
			this.warn("resyncView(): no document to sync against, bailing");
			return;
		}

		await this.boundDoc.awaitFirstSync();

		if (this.boundDoc.content === this.boundView.hostView.getViewData()) {
			// Contents already agree, so mark it tracked and skip the merge dance
			this.boundView.isTracking = true;
			this.warn("resyncView(): already in sync, flipping tracking on");
			return;
		}
		this.logResyncMismatch();

		if (!this.boundDoc.hasLocalPersistence() && this.boundDoc.content === "") {
			this.warn("no local DB and doc is empty, leaving the buffer alone");
			return;
		}

		let stale: boolean;
		try {
			stale = await this.boundDoc.refreshIfStale();
		} catch (e: unknown) {
			// HTTP download failed (e.g., 401 with CWT tokens on relay-server).
			// Skip pushCRDTToView — rely on WS sync for CRDT state.
			this.warn("[resyncView] refreshStaleState failed, relying on WS sync:", (e as Error).message);
			return;
		}

		if (stale) {
			this.warn("view is stale relative to the CRDT doc, surfacing the merge banner");
			// This will show the merge banner
			void this.boundView.refreshStaleState().then((stillStale) => {
				if (!stillStale) {
					this.pushCRDTToView();
				}
			});
		} else {
			// The CRDT doc wins; push its content into the view (mirrors getKeyFrame in LiveEditPlugin)
			this.warn("CRDT doc is authoritative, pushing its content into the view");
			this.pushCRDTToView();
		}
	}

	/**
	 * resyncView() found the CRDT document and the open editor holding different
	 * content. Report WHERE they part company rather than dumping both bodies:
	 * the offset of the first difference plus a short window either side is
	 * what identifies the cause, and it stays a bounded size. Whether the two
	 * sides even refer to the same TFile is the other half of the answer — a
	 * mismatch is usually either a genuine divergence or a stale view pointed
	 * at the wrong doc.
	 *
	 * Note these lines reach the user's log file, which "Include Logs" attaches
	 * to a bug report headed for a public issue — so note bodies do not belong
	 * here in full.
	 */
	private logResyncMismatch(): void {
		const doc = this.boundDoc;
		if (!doc) return;

		const inDoc = doc.content ?? "";
		const inView = this.boundView.hostView.getViewData() ?? "";
		const at = firstDifference(inDoc, inView);

		this.warn(
			`resync: document and view disagree from offset ${at} ` +
				`(document ${inDoc.length} chars, view ${inView.length})`,
			{
				guid: doc.entityGuid,
				documentPath: doc.entryPath,
				viewPath: this.boundView.hostView.file?.path,
				boundTFilePath: doc._obsidianFile?.path,
				sameTFile: doc._obsidianFile === this.boundView.hostView.file,
				documentNear: excerptAround(inDoc, at),
				viewNear: excerptAround(inView, at),
			},
		);
	}

	pushCRDTToView() {
		// Push the CRDT doc's content into the editor view (equivalent to getKeyFrame in LiveEditPlugin)
		if (!isBoundText(this.boundView) || this.isDestroyed || !this.boundDoc || !this.boundView.hostView.file) {
			return;
		}
		this.warn("pushing CRDT content into the view via setViewData");
		this.isSaving = true;
		this.boundView.hostView.setViewData(this.boundDoc.content, false);
		this.boundDoc.syncToVault();
		this.isSaving = false;
		this.boundView.isTracking = true;
	}

	/**
	 * Build the monkey-patched `setViewData` handler. A `static` method
	 * (rather than one that captures `this` in a closure variable) so the
	 * returned function keeps its own dynamic `this` — bound to whichever
	 * `TextFileView` instance it's actually invoked on — while `plugin` is
	 * threaded through as an ordinary parameter, not an alias.
	 */
	private static buildSetViewDataHandler(
		plugin: TextViewPatch,
		original: (...args: unknown[]) => unknown,
	) {
		return function (this: PatchTarget, ...args: unknown[]) {
			const data = args[0] as string;
			const clear = args[1] as boolean;
			plugin.warn(
				"instance hook: setViewData",
				(this as unknown as TextFileView).getViewType(),
			);

			if (!plugin.boundView.hostView.file) {
				plugin.warn("setViewData called before file loaded, deferring to original");
				return original.call(this, data, clear);
			}

			if (
				clear &&
				isBoundText(plugin.boundView) &&
				plugin.boundDoc &&
				plugin.boundView.hostView.file === plugin.boundDoc.obsidianFile &&
				plugin.boundView.boundDocument.content === data
			) {
				plugin.boundView.isTracking = true;
			}

			const result = original.call(this, data, clear);

			// Only kick off resync once the original setViewData has actually returned
			if (clear) {
				void plugin.resyncView();
			}
			return result;
		};
	}

	private static buildRequestSaveHandler(
		plugin: TextViewPatch,
		original: (...args: unknown[]) => unknown,
	) {
		return function (this: PatchTarget, ...args: unknown[]) {
			plugin.warn(
				"instance hook: requestSave called",
				(this as unknown as TextFileView).getViewType(),
			);
			if (isBoundText(plugin.boundView) && !plugin.isSaving && plugin.boundDoc) {
				if (plugin.boundView.isTracking) {
					plugin.warn("tracking - applying diff");
					applyDiffToYText(plugin.boundDoc.crdtDoc, plugin.boundView.hostView.getViewData(), plugin.boundDoc);
					plugin.boundDoc.syncToVault();
					return;
				}
				plugin.warn("not tracking - resync");
				void plugin.resyncView();
			}
			return original.call(this, ...args);
		};
	}

	private handleSetViewData(original: (...args: unknown[]) => unknown) {
		return TextViewPatch.buildSetViewDataHandler(this, original);
	}

	private handleRequestSave(original: (...args: unknown[]) => unknown) {
		return TextViewPatch.buildRequestSaveHandler(this, original);
	}

	private observeDocumentChanges(): void {
		this.textObserver = (event, tr) => {
			this.boundDoc = this.resolveDocument();
			if (!this.boundDoc) {
				this.debug("yjs observer fired with no document bound, ignoring");
				return;
			}
			if (!isBoundText(this.boundView)) {
				this.debug("yjs update arrived for a view that's no longer live, ignoring");
				return;
			}
			if (this.isDestroyed) {
				this.debug("yjs update arrived after this plugin was destroyed, ignoring");
				return;
			}
			// This fires on every yjs text-change event and drives the editor view update
			if (tr.origin === this.boundDoc) {
				return;
			}
			if (!this.boundView.isTracking) {
				this.warn("update came in while untracked, triggering a resync");
				void this.resyncView();
			}
			this.warn("applying the CRDT update to the view buffer");
			this.isSaving = true;
			this.boundView.hostView.setViewData(this.boundDoc.content, false);
			this.boundView.hostView.requestSave();
			this.isSaving = false;
			this.boundView.isTracking = true;
		};

		this.boundDoc = this.resolveDocument();
		if (this.boundDoc) {
			this._crdtTextRef = this.boundDoc.crdtText;
			this._crdtTextRef.observe(this.textObserver);
		}
	}

	private installPatches() {
		if (!this.boundView) return;

		if (!this.boundView.hostView.file) {
			this.warn("underlying view file isn't ready yet, postponing install");
			// Give the view a moment to settle, then try installing again
			window.setTimeout(() => {
				if (!this.isDestroyed && this.boundView?.hostView?.file) {
					this.installPatches();
				}
			}, 100);
			return;
		}

		this.warn("connecting textfile view", this.boundView.hostView.file?.path, this.boundView.boundDocument.entryPath);

		this.unsubscribeFns.push(
			getPatchRegistry().install(this.boundView.hostView as unknown as PatchTarget, {
				setViewData: (old: (...args: unknown[]) => unknown) => this.handleSetViewData(old),
				requestSave: (old: (...args: unknown[]) => unknown) => this.handleRequestSave(old),
			}),
		);

		void this.resyncView();
		this.observeDocumentChanges();

		// Bring up ViewSurfaceBridge only once sync state has settled
		if (this.surfaceBridge) {
			this.surfaceBridge.initializeSync().catch((error: unknown) => {
				this.error("ViewSurfaceBridge.initializeSync() rejected:", error);
			});
		}
	}

	teardown() {
		this.warn("tearing down TextViewPatch");
		this.isDestroyed = true;
		if (this.textObserver) {
			this._crdtTextRef?.unobserve(this.textObserver);
		}
		this.unsubscribeFns.forEach((unsubscribe) => unsubscribe());
		this.unsubscribeFns.length = 0;

		this.surfaceBridge?.teardown();

		this.textObserver = null as unknown as ((event: YTextEvent, tr: Transaction) => void) | undefined;
		this._crdtTextRef = null as unknown as YText | undefined;
		this.boundView = null as unknown as DocumentViewBinding<TextFileView>;
		this.boundDoc = null as unknown as Document | undefined;
	}
}
