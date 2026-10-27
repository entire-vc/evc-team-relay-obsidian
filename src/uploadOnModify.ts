import { sameTextContent } from "./textEquivalence";

/**
 * Whether a vault "modify" of a shared document must be pushed through the
 * upload lane. Only an editor bound to the document (editLock) writes its
 * edits into the Y.Doc itself; a document that is merely connected -- by a
 * background pull, an upload, or the relay probe -- does not. Before 0.1.24
 * this checked `isOnline` alone, so an edit landing while a background pull
 * held the note connected waited for the next sweep: 43-80 s on the 0.1.23
 * stand under an 800+ document import.
 */
export function uploadsOnModify(doc: { isOnline: boolean; editLock: boolean }): boolean {
	return !doc.isOnline || !doc.editLock;
}

/**
 * For a document connected without an editor: whether the file only holds
 * what the Y.Doc already has -- typically a background pull's own write
 * landing as a "modify" -- so there is nothing to upload.
 */
export async function holdsOnlySyncedText(doc: { content: string }, read: () => Promise<string>): Promise<boolean> {
	try {
		return sameTextContent(await read(), doc.content);
	} catch {
		return false;
	}
}
