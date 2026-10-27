/**
 * Whether a vault "modify" of a shared note has to be pushed by an upload.
 *
 * Only a note bound to an open editor pushes its own edits (the editor
 * writes the Y.Doc, and the provider sends it). Being connected is not
 * enough: a background pull or upload connects a closed note for a few
 * seconds, and an edit that landed in that window was skipped as if an
 * editor would send it. Nothing did until the next background pass reached
 * the note, 43-73 s later under load.
 */
export function needsUploadOnModify(doc: { editLock: boolean }): boolean {
	return !doc.editLock;
}
