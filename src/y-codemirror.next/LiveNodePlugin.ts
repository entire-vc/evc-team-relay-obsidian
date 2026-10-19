// Code in this file has been adapted from y-codemirror.next
// LicenseRecord
// [The MIT LicenseRecord](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import {
	ViewBindingRegistry,
	ViewBindingStateField,
	CanvasViewBinding,
} from "../ViewBindings";
import type { Text as YText, YTextEvent, Transaction } from "yjs";
import { namedLogger } from "src/logging";
import type { CanvasNodeData } from "src/HostCanvasView";

export const connectionManagerFacet: Facet<ViewBindingRegistry, ViewBindingRegistry> =
	Facet.define({
		combine(inputs) {
			return inputs[inputs.length - 1];
		},
	});

export const ySyncAnnotation = Annotation.define();

export class LiveNodePluginValue implements PluginValue {
	editor: EditorView;
	view?: CanvasViewBinding;
	connectionManager?: ViewBindingRegistry;
	initialSet = false;
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};
	embed = false;
	node?: CanvasNodeData;

	private getNode() {
		const editorStateValues = (this.editor.state as unknown as { values: unknown[] }).values;
		const state = editorStateValues.find((s: unknown) => {
			return s != null && (s as Record<string, unknown>).node != null;
		}) as { node: CanvasNodeData } | undefined;
		if (!state) return;
		this.node = state.node;
		return this.node;
	}

	private getYText(): YText | undefined {
		this.view = this.connectionManager?.locateCanvasView(this.editor);

		const editorStateValues = (this.editor.state as unknown as { values: unknown[] }).values;
		const state = editorStateValues.find((s: unknown) => {
			return s != null && (s as Record<string, unknown>).node != null;
		}) as { node: CanvasNodeData } | undefined;
		if (!state) {
			if (this.observer) this._ytext?.unobserve(this.observer);
			return;
		}
		if (state.node.id !== this.node?.id && this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.node = state.node;
		// This CodeMirror extension is registered globally (ViewBindings.ts
		// ViewBindingRegistry.load()) whenever any view is open, independent of any
		// single CanvasViewBinding's own readiness -- so it can run before
		// CanvasViewBinding.mountView() has gated CanvasViewPatch/mergeCanvasData() on
		// awaitFirstSync(). Use the sync-safe accessor rather than calling
		// canvas.nodeText() directly here (see CanvasDocument.textNodeSafe() for why:
		// /).
		return this.view?.canvasDocument.textNodeSafe(state.node);
	}

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.field(
			ViewBindingStateField,
		);
		this.view = this.connectionManager?.locateCanvasView(this.editor);
		this.node = this.getNode();
		this._ytext = this.getYText();
		if (!this._ytext) {
			return;
		}
		if (!this.view) {
			return;
		}
		this.log = namedLogger(
			`[LiveNodePluginValue][${this.view.canvasDocument.entryPath}#${this.node?.id}]`,
			"log",
		);
		this.warn = namedLogger(
			`[LiveNodePluginValue][${this.view.canvasDocument.entryPath}#${this.node?.id}]`,
			"warn",
		);
		this.debug = namedLogger(
			`[LiveNodePluginValue][${this.view.canvasDocument.entryPath}#${this.node?.id}]`,
			"debug",
		);
		this.debug("created");

		this._observer = (event, tr) => {
			this._ytext = this.getYText();

			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

			// Called when a yjs event is received. Results in updates to codemirror.
			if (tr.origin !== this) {
				const delta = event.delta;
				const changes: ChangeSpec[] = [];
				let pos = 0;
				for (let i = 0; i < delta.length; i++) {
					const d = delta[i];
					if (d.insert != null) {
						changes.push({
							from: pos,
							to: pos,
							insert: d.insert as string,
						});
					} else if (d.delete != null) {
						changes.push({
							from: pos,
							to: pos + d.delete,
							insert: "",
						});
						pos += d.delete;
					} else if (d.retain != null) {
						pos += d.retain;
					}
				}
				if (this.view?.canvasDocument) {
					editor.dispatch({
						changes,
						annotations: [ySyncAnnotation.of(this.editor)],
					});
				}
			}
		};

		this.observer = (event, tr) => {
			try {
				this._observer?.(event, tr);
			} catch (e: unknown) {
				if (e instanceof RangeError) {
					console.warn("range errors!");
				}
			}
		};
		this._ytext.observe(this.observer);
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor)
		) {
			return;
		}
		const ytext = this.getYText();
		if (!ytext) {
			return;
		}
		ytext.doc?.transact(() => {
			/**
			 * This variable adjusts the fromA position to the current position in the Y.Text type.
			 */
			let adj = 0;
			update.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
				const insertText = insert.sliceString(0, insert.length, "\n");
				if (fromA !== toA) {
					ytext.delete(fromA + adj, toA - fromA);
				}
				if (insertText.length > 0) {
					ytext.insert(fromA + adj, insertText);
				}
				adj += insertText.length - (toA - fromA);
			});
		}, this);
	}

	destroy() {
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.connectionManager = null as unknown as ViewBindingRegistry | undefined;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as unknown as EditorView;
	}
}

export const LiveNode = ViewPlugin.fromClass(LiveNodePluginValue);
