import { StateEffect } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	type DecorationSet,
} from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import { TextFileView, setIcon } from "obsidian";
import type { App, CachedMetadata, ReferenceCache } from "obsidian";
import { namedLogger } from "src/logging";
import {
	DocumentViewBinding,
	ViewBindingRegistry,
	ViewBindingStateField,
} from "../ViewBindings";

/** Icon shown after a link that points outside the current shared folder. */
class ExternalLinkWarningWidget extends WidgetType {
	toDOM() {
		const span = createSpan({
			cls: ["evc-inline-flex", "evc-invalid-link"],
			title: "This link points outside the shared folder and may not be accessible to other users.",
		});
		// Obsidian's setIcon API renders the SVG safely — no innerHTML involved.
		setIcon(span, "file-warning");
		return span;
	}
}

/** A link/embed's cached position, re-mapped as the document is edited. */
interface TrackedLink {
	startOffset: number;
	endOffset: number;
	linkTarget: string;
	rawText: string;
}

const metadataChangeEffect = StateEffect.define();

/**
 * CodeMirror ViewPlugin value that decorates links pointing outside the
 * active shared folder with a warning icon. It has two inputs that need to
 * stay reconciled: Obsidian's metadata cache (authoritative for *which*
 * links exist and where they point, but updates asynchronously) and
 * CodeMirror's own edit stream (authoritative for *where* those links
 * currently sit in the document, updated synchronously on every keystroke).
 */
export class ExternalLinkPluginValue {
	obsidianApp?: App;
	editorView: EditorView;
	viewBinding?: DocumentViewBinding<TextFileView>;
	viewRegistry?: ViewBindingRegistry;
	linkDecorations: DecorationSet;

	/** Links from the metadata cache, keyed by their start offset at the time they were cached. */
	private trackedLinks: Map<number, TrackedLink>;
	/** Offsets (in the CURRENT document) of links currently known to be invalid. */
	private invalidLinkOffsets: number[];
	private readonly onMetaChanged: (data: string, cache: CachedMetadata) => void;
	logger: (message: string) => void = () => {};

	constructor(editor: EditorView) {
		this.editorView = editor;
		this.viewRegistry = this.editorView.state.field(ViewBindingStateField);
		this.linkDecorations = Decoration.none;
		this.invalidLinkOffsets = [];
		this.trackedLinks = new Map();
		this.onMetaChanged = (_data, cache) => {
			this.reindexFromMetadata(cache);
			this.editorView.dispatch({ effects: metadataChangeEffect.of(null) });
		};

		if (!this.viewRegistry) {
			namedLogger("[ExternalLinkPluginValue]", "warn")(
				"ConnectionManager not found in ExternalLinkPlugin",
			);
			return;
		}
		this.obsidianApp = this.viewRegistry.obsidianApp;
		this.viewBinding = this.viewRegistry.locateMarkdownView(editor);
		if (!this.viewBinding) {
			return;
		}

		this.logger = namedLogger(`[ExternalLinkPluginValue][${this.viewBinding.hostView.file?.path}]`, "debug");
		this.logger("created");

		void this.viewBinding.boundDocument?.awaitFirstSync().then(() => this.subscribeToMetadata());
	}

	private subscribeToMetadata(): void {
		const tfile = this.viewBinding?.boundDocument?.getObsidianFile();
		if (!this.viewRegistry || !this.obsidianApp || !tfile) {
			this.logger("unable to subscribe to metadata updates");
			return;
		}
		this.viewRegistry.subscribeMetadata(tfile, this.onMetaChanged);
		const fileCache = this.obsidianApp.metadataCache.getFileCache(tfile);
		if (fileCache) {
			this.reindexFromMetadata(fileCache);
			this.editorView.dispatch({ effects: metadataChangeEffect.of(null) });
		}
	}

	/** Refreshes `this.viewBinding` and reports whether we have everything needed to do link checks. */
	private hasSyncedContext(): boolean {
		if (this.viewRegistry) {
			this.viewBinding = this.viewRegistry.locateMarkdownView(this.editorView);
		}
		const boundDoc = this.viewBinding?.boundDocument;
		return !!(this.obsidianApp && boundDoc && boundDoc.vaultShare && boundDoc.obsidianFile);
	}

	private isOutsideVaultShare(linkPath: string, sourcePath: string): boolean {
		const boundDoc = this.viewBinding?.boundDocument;
		if (!this.obsidianApp || !boundDoc?.vaultShare) {
			return false;
		}
		const target = this.obsidianApp.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
		return !!target && !boundDoc.vaultShare.containsPath(target.path);
	}

	/** Rebuilds `trackedLinks` from a fresh metadata-cache snapshot (links + embeds alike). */
	private reindexFromMetadata(cache: CachedMetadata): void {
		if (!this.hasSyncedContext()) {
			return;
		}
		const sourcePath = this.viewBinding!.boundDocument.entryPath;

		const next = new Map<number, TrackedLink>();
		const references: ReferenceCache[] = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
		for (const ref of references) {
			if (this.isOutsideVaultShare(ref.link, sourcePath)) {
				next.set(ref.position.start.offset, {
					startOffset: ref.position.start.offset,
					endOffset: ref.position.end.offset,
					linkTarget: ref.link,
					rawText: ref.original,
				});
			}
		}
		this.trackedLinks = next;
	}

	/** Re-maps every tracked link's offsets through an editor change, dropping any that no longer resolve. */
	private remapTrackedLinks(update: ViewUpdate): void {
		for (const [originalFrom, tracked] of this.trackedLinks) {
			try {
				this.trackedLinks.set(originalFrom, {
					...tracked,
					startOffset: update.changes.mapPos(tracked.startOffset),
					endOffset: update.changes.mapPos(tracked.endOffset),
				});
			} catch {
				this.trackedLinks.delete(originalFrom);
			}
		}
	}

	/** Finds every `cm-formatting-link-end` decoration span currently rendered by the editor. */
	private findRenderedLinkEnds(view: EditorView): { from: number; to: number }[] {
		const linkEnds: { from: number; to: number }[] = [];
		for (const decoSetOrFn of view.state.facet(EditorView.decorations)) {
			const decoSet = typeof decoSetOrFn === "function" ? decoSetOrFn(view) : decoSetOrFn;
			decoSet.between(0, view.state.doc.length, (from, to, deco: Decoration) => {
				const specClass = (deco.spec as Record<string, unknown> | undefined)?.class;
				const classNames = typeof specClass === "string" ? specClass : "";
				if (classNames.contains("cm-formatting-link-end")) {
					linkEnds.push({ from, to });
				}
			});
		}
		return linkEnds;
	}

	/** Recomputes which currently-rendered links are invalid, using cache data for link targets. */
	private updateInvalidOffsets(update: ViewUpdate): void {
		if (!this.hasSyncedContext()) {
			return;
		}
		const sourcePath = this.viewBinding!.boundDocument.entryPath;

		// The metadata cache is slower to update than the shared doc, so we use
		// it only to resolve *where a link points*; its positions may already
		// be stale, so we match it against the editor's own current link spans.
		const remainingTracked = new Map(this.trackedLinks);
		const offsets: number[] = [];

		for (const { from, to } of this.findRenderedLinkEnds(this.editorView)) {
			const overlapping = [...remainingTracked].find(
				([, tracked]) => from <= tracked.endOffset && to >= tracked.startOffset,
			);
			if (!overlapping) {
				continue;
			}
			const [key, tracked] = overlapping;
			remainingTracked.delete(key);

			if (this.isOutsideVaultShare(tracked.linkTarget, sourcePath)) {
				offsets.push(from);
			}
		}

		this.invalidLinkOffsets = offsets.filter((offset) => offset <= update.state.doc.length);
	}

	private rebuildDecorations(): void {
		const sorted = [...this.invalidLinkOffsets].sort((a, b) => a - b);
		const decorations = sorted.map((offset) =>
			Decoration.widget({ widget: new ExternalLinkWarningWidget(), side: 1 }).range(offset),
		);
		this.linkDecorations = decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none;
	}

	update(update: ViewUpdate): DecorationSet {
		const metadataChanged = update.transactions.some((tr) =>
			tr.effects.some((e) => e.is(metadataChangeEffect)),
		);

		if (update.docChanged || update.viewportChanged || metadataChanged) {
			if (!metadataChanged) {
				this.remapTrackedLinks(update);
			}
			this.updateInvalidOffsets(update);
			this.rebuildDecorations();
		}
		return this.linkDecorations;
	}

	destroy(): void {
		const tfile = this.viewBinding?.boundDocument?.obsidianFile;
		if (this.viewRegistry && tfile) {
			this.viewRegistry.unsubscribeMetadata(tfile);
		}
		this.viewRegistry = undefined;
		this.viewBinding = undefined;
		this.trackedLinks.clear();
		this.trackedLinks = null as unknown as Map<number, TrackedLink>;
		this.editorView = null as unknown as EditorView;
	}
}

export const ExternalLinkPlugin = ViewPlugin.fromClass(ExternalLinkPluginValue, {
	decorations: (v) => v.linkDecorations,
});
