import { MarkdownView, getFrontMatterInfo, parseYaml } from "obsidian";
import { Document } from "../Document";
import { Loggable } from "../logging";
import { currentToggles } from "../featureToggleState";
import type { DocumentSurfaceSync } from "./DocumentSurfaceSync";

interface RenderedProperty {
	entry: unknown;
	renderProperty(entry: unknown, force?: boolean): void;
}

/** Obsidian's metadata (Properties) editor internals — not part of its public API. */
interface MetadataEditorInternal {
	synchronize(data: unknown): void;
	rendered: RenderedProperty[];
}

/** Keeps the Properties editor's fields in sync with the document's frontmatter. */
export class PropertiesEditorSync extends Loggable implements DocumentSurfaceSync {
	private markdownView: MarkdownView;
	private destroyed = false;

	constructor(view: MarkdownView) {
		super();
		this.markdownView = view;
		this.setLoggers(`[PropertiesEditorSync][${view.file?.path}]`);
		this.debug("created");
	}

	render(doc: Document): void {
		if (this.destroyed) {
			this.debug("Skipping render - renderer destroyed");
			return;
		}
		if (!currentToggles().enableMetadataViewHooks) {
			this.debug("Metadata view hooks disabled via flags");
			return;
		}

		try {
			this.debug("Rendering metadata from document");
			const metadataEditor = (this.markdownView as unknown as { metadataEditor?: MetadataEditorInternal })
				.metadataEditor;
			if (!metadataEditor) {
				this.debug("No metadata editor available");
				return;
			}

			const frontmatterText = getFrontMatterInfo(doc.content).frontmatter;
			if (!frontmatterText) {
				this.debug("No frontmatter found in doc");
				return;
			}

			metadataEditor.synchronize(parseYaml(frontmatterText));
			for (const property of metadataEditor.rendered) {
				const forceRerender = true;
				property.renderProperty(property.entry, forceRerender);
			}
		} catch (error: unknown) {
			this.error("Error rendering metadata:", error);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.debug("destroyed");
		this.markdownView = null as unknown as MarkdownView;
	}
}
