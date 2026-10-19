/**
 * Pure helpers for the resync() mismatch report in TextViewPatch.ts, split
 * out so they can be exercised without loading the whole plugin graph.
 *
 * When the CRDT document and the open editor disagree, what identifies the
 * cause is WHERE they part company — not both note bodies in full. Those logs
 * are attached to bug reports, so the report has to stay bounded.
 */

/** Characters of context reported either side of a document/view divergence. */
const MISMATCH_CONTEXT = 40;

/**
 * Offset of the first character at which two strings differ. When one is a
 * prefix of the other, that is their common length — i.e. where the shorter
 * one ran out.
 */
export function firstDifference(a: string, b: string): number {
	const shared = Math.min(a.length, b.length);
	let i = 0;
	while (i < shared && a[i] === b[i]) {
		i += 1;
	}
	return i;
}

/** A bounded slice of `text` centred on `index`, for logging. */
export function excerptAround(text: string, index: number): string {
	return text.slice(Math.max(0, index - MISMATCH_CONTEXT), index + MISMATCH_CONTEXT);
}
