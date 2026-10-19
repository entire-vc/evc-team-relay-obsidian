/**
 * Comparisons used before deciding that a vault file and a Y.Text diverge.
 *
 * Vault files are read raw, so a note saved with CRLF on one machine and LF
 * on another compares unequal with === although nothing a user can see
 * differs. Treating that as a conflict produced copies whose only difference
 * was line endings.
 */

/** CRLF / lone CR -> LF. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Equal once line endings are normalized. */
export function sameTextContent(a: string, b: string): boolean {
	return a === b || normalizeLineEndings(a) === normalizeLineEndings(b);
}

/**
 * Whether `text` is worth writing out as a conflict copy. An empty side
 * preserves nothing: readVaultContents() returns "" for a file that is not
 * on disk yet as well as for a genuinely empty one.
 */
export function hasPreservableContent(text: string): boolean {
	return text.length > 0;
}
