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
