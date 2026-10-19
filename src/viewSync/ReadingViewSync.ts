import { MarkdownView } from "obsidian";
import { Document } from "../Document";
import { Loggable } from "../logging";
import { currentToggles } from "../featureToggleState";
import type { DocumentSurfaceSync } from "./DocumentSurfaceSync";

/** Obsidian's Reading-view internals we poke directly — not part of its public API. */
interface ReadingViewInternal {
	text?: string;
	previewMode?: { renderer?: { set: (text: string) => void } };
	onInternalDataChange?: () => void;
}

/** Keeps Reading view's rendered text in sync with the CRDT doc. */
export class ReadingViewSync extends Loggable implements DocumentSurfaceSync {
	private markdownView: MarkdownView;
	private destroyed = false;

	constructor(view: MarkdownView) {
		super();
		this.markdownView = view;
		this.setLoggers(`[ReadingViewSync][${view.file?.path}]`);
		this.debug("created");
	}

	render(doc: Document, viewMode: string): void {
		if (this.destroyed) {
			this.debug("Skipping render - renderer destroyed");
			return;
		}
		if (!currentToggles().enablePreviewViewHooks) {
			this.debug("Preview view hooks disabled via flags");
			return;
		}
		if (viewMode !== "preview") {
			this.debug("Skipping render - not in preview mode");
			return;
		}

		try {
			this.debug("Rendering preview from document");
			const internal = this.markdownView as unknown as ReadingViewInternal;

			internal.text = doc.content;
			internal.previewMode?.renderer?.set(doc.content);
			internal.onInternalDataChange?.();

			this.debug("Preview render completed");
		} catch (error: unknown) {
			this.error("Error rendering preview:", error);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.debug("destroyed");
		this.markdownView = null as unknown as MarkdownView;
	}
}
