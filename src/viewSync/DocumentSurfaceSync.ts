import { Document } from "../Document";

/**
 * A read-only projection of the CRDT `Document` onto one of Obsidian's view
 * surfaces (Reading view, the metadata editor, ...). Implementations must be
 * idempotent and side-effect-free beyond the DOM they own — `render()` may be
 * called any number of times for the same state.
 */
export interface DocumentSurfaceSync {
	/** Paint `document`'s current state into whichever surface this renderer owns. */
	render(document: Document, viewMode: string): void;

	/** Detach from the view and release any references, permanently. */
	destroy(): void;
}
