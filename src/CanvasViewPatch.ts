import { getPatchRegistry } from "./PatchRegistry";
import { CanvasDocument } from "src/CanvasDocument";
import type {
	HostCanvasEdge,
	CanvasEdgeData,
	HostCanvasNode,
	CanvasNodeData,
	HostCanvasView,
	HostCanvas,
} from "src/HostCanvasView";
import type { CanvasViewBinding, ViewBindingRegistry } from "src/ViewBindings";
import { Loggable } from "src/logging";
import type { TextFileView } from "obsidian";

import * as Y from "yjs";
import { ViewSurfaceBridge } from "./viewSync/ViewSurfaceBridge";
import { currentToggles } from "./featureToggleState";

type PatchTarget = Record<string, (...args: unknown[]) => unknown>;
type EmbedView = { file?: { path: string } } & import("obsidian").MarkdownView;

export class CanvasViewPatch extends Loggable {
	hostView: HostCanvasView;
	canvasDocument: CanvasDocument;
	hostCanvas: HostCanvas;
	unsubscribeFns: Array<() => void>;
	viewBinding: CanvasViewBinding;
	watchedTextNodeIds: Set<string>;
	trackedEmbeds: Set<unknown>;

	constructor(
		private registry: ViewBindingRegistry,
		viewBinding: CanvasViewBinding,
	) {
		super();
		this.hostView = viewBinding.hostView;
		this.hostCanvas = viewBinding.hostView.canvas;
		this.canvasDocument = viewBinding.canvasDocument;
		this.unsubscribeFns = [];
		this.viewBinding = viewBinding;
		this.watchedTextNodeIds = new Set();
		this.trackedEmbeds = new Set();
		this.installPatches();
		this.connectExistingEmbedViews();
	}

	teardown() {
		if (this.hostCanvas) {
			this.unsubscribeFns.forEach((unsubscribe) => unsubscribe());
			this.unsubscribeFns = [];
		}
		this.viewBinding.isTracking = false;
		this.hostCanvas = null as unknown as HostCanvas;
		this.canvasDocument = null as unknown as CanvasDocument;
		this.viewBinding = null as unknown as CanvasViewBinding;
		this.unsubscribeFns.length = 0;
	}

	observeCanvasNode(node: CanvasNodeData) {
		if (this.watchedTextNodeIds.has(node.id) || node.type !== "text") {
			return;
		}
		const ytext = this.canvasDocument.nodeText(node);
		const nodeId = node.id;
		const onTextChange = (_event: Y.YTextEvent) => {
			const liveNode = this.hostCanvas.nodes.get(nodeId);
			if (liveNode) {
				liveNode.setText(ytext.toJSON());
				this.hostCanvas.markDirty(liveNode);
			}
		};
		ytext.observe(onTextChange);
		this.unsubscribeFns.push(() => {
			this.canvasDocument.nodeText(node).unobserve(onTextChange);
			this.watchedTextNodeIds.delete(nodeId);
		});
	}

	public collectEmbedViews(): TextFileView[] {
		const views: TextFileView[] = [];
		for (const nodeData of this.hostCanvas.nodes.values()) {
			const child = (nodeData as HostCanvasNode & { child?: TextFileView }).child;
			if (child) {
				views.push(child);
			}
		}
		return views;
	}

	public markNodeDirty(node: CanvasNodeData) {
		const fullNode = this.hostCanvas.nodes.get(node.id);
		if (fullNode) {
			this.hostCanvas.markDirty(fullNode);
		}
	}

	/** Enable embedded-view sync (featureKey-gated) for every embed already on the canvas at construction time. */
	private connectExistingEmbedViews(): void {
		if (!currentToggles().enableLiveEmbeds) {
			return;
		}
		for (const node of this.collectEmbedViews()) {
			if (node.file) {
				this.wireEmbedView(node);
			}
		}
	}

	private isEmbedTracked(embedView: unknown): boolean {
		return this.trackedEmbeds.has(embedView);
	}

	private wireEmbedView(embedView: unknown): void {
		const typed = embedView as EmbedView;
		if (!typed.file) {
			return;
		}

		this.trackedEmbeds.add(embedView);
		const hookPlugin = new ViewSurfaceBridge(
			typed,
			this.canvasDocument.vaultShare.rootRelative.docAt(typed.file.path),
		);
		hookPlugin.initializeSync().catch((error: unknown) => {
			this.error("Error initializing ViewSurfaceBridge for canvas embed:", error);
		});
		this.unsubscribeFns.push(() => {
			this.trackedEmbeds.delete(embedView);
			hookPlugin.teardown();
		});
	}

	private patchCanvasSaveHooks(): void {
		this.unsubscribeFns.push(
			getPatchRegistry().install(this.hostCanvas as unknown as PatchTarget, {
				requestSave: (old: (...args: unknown[]) => unknown) =>
					CanvasViewPatch.buildImportOnSaveHandler(this, old),
				applyHistory: (old: (...args: unknown[]) => unknown) =>
					CanvasViewPatch.buildImportOnSaveHandler(this, old),
			}),
		);
	}

	/**
	 * Both `requestSave` and `applyHistory` need the same reaction: let the
	 * original Obsidian canvas method run, then re-import the view's data
	 * back into our CRDT. Built as a `static` factory (plugin passed as a
	 * parameter) so the returned function keeps its own `this`, bound to
	 * whichever canvas method it's patched onto.
	 */
	private static buildImportOnSaveHandler(
		plugin: CanvasViewPatch,
		old: (...args: unknown[]) => unknown,
	) {
		return function (this: unknown, ...args: unknown[]) {
			const result: unknown = old.apply(this, args);
			try {
				plugin.canvasDocument.syncFromView(plugin.hostView);
			} catch (e: unknown) {
				plugin.log(e);
			}
			return result;
		};
	}

	private onYNodesOrEdgesChanged<T extends CanvasNodeData | CanvasEdgeData>(
		event: Y.YMapEvent<T>,
		store: Map<string, HostCanvasNode> | Map<string, HostCanvasEdge>,
	): void {
		if (!this.canvasDocument) {
			this.log("skipping: canvasDocument has already been torn down");
		}
		if (!this.hostCanvas) {
			this.log("skipping: obsidian canvas has already been torn down");
			return;
		}
		if (!this.hostView.file?.path.endsWith(this.canvasDocument.entryPath)) {
			this.log("skipping: change belongs to a different canvas file");
			return;
		}
		if (event.transaction.origin === this.canvasDocument) {
			return;
		}

		const txOrigin = event.transaction.origin as
			| { constructor?: { name?: string } }
			| null
			| undefined;
		let log = `Transaction origin: ${String(event.transaction.origin)} ${txOrigin?.constructor?.name ?? ""}\n`;
		for (const [key, delta] of event.changes.keys) {
			log += `  ${key} => ${delta.action}\n\n`;
		}
		this.debug(log);

		const exported = CanvasDocument.exportData(this.canvasDocument.crdtDoc);
		this.debug("importing data", this.hostView.file?.path, this.canvasDocument.entryPath, exported);
		this.hostCanvas.importData(exported, true);
		this.hostCanvas.requestSave();

		for (const key of event.keysChanged) {
			const node = store.get(key as string);
			if (!node) continue;

			if (this.hostCanvas.nodes.has(node.id)) {
				this.observeCanvasNode((node as HostCanvasNode).getData());
				if (currentToggles().enableLiveEmbeds) {
					const embedView = (node as HostCanvasNode & { child?: TextFileView }).child;
					if (embedView?.file && !this.isEmbedTracked(embedView)) {
						this.wireEmbedView(embedView);
					}
				}
			}
			this.hostCanvas.markMoved(node);
			this.hostCanvas.markDirty(node);
		}
	}

	private watchYCanvasEntities(): void {
		const onNodesChanged = (event: Y.YMapEvent<CanvasNodeData>) =>
			this.onYNodesOrEdgesChanged<CanvasNodeData>(event, this.hostCanvas.nodes);
		this.canvasDocument.crdtNodes.observe(onNodesChanged);
		this.unsubscribeFns.push(() => this.canvasDocument.crdtNodes.unobserve(onNodesChanged));

		for (const [, node] of this.canvasDocument.crdtNodes) {
			this.observeCanvasNode(node);
		}

		const onEdgesChanged = (event: Y.YMapEvent<CanvasEdgeData>) =>
			this.onYNodesOrEdgesChanged<CanvasEdgeData>(event, this.hostCanvas.edges);
		this.canvasDocument.crdtEdges.observe(onEdgesChanged);
		this.unsubscribeFns.push(() => this.canvasDocument.crdtEdges.unobserve(onEdgesChanged));
	}

	private importInitialCanvasData(): void {
		const exported = CanvasDocument.exportData(this.canvasDocument.crdtDoc);
		const hasCanvasData = exported.nodes.length > 0 || exported.edges.length > 0;
		if (this.canvasDocument.hasLocalPersistence() && hasCanvasData) {
			this.hostCanvas.importData(exported, true);
		}
	}

	private installPatches() {
		if (!this.hostCanvas) return;

		this.debug("connecting canvas view to canvas", this.hostView.file?.path, this.canvasDocument.entryPath);

		this.importInitialCanvasData();
		this.patchCanvasSaveHooks();
		this.watchYCanvasEntities();

		this.viewBinding.isTracking = true;
	}
}
