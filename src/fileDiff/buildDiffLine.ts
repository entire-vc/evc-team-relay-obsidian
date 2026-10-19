import { diffWordsWithSpace } from "diff";
import { ensureVisibleRowText } from "./lineSpanUtils";

/**
 * Builds the word-diff DOM for one rendered line in the differences view.
 *
 * Split out of FileDiffView (which pulls in Document.ts -> AuthSession ->
 * pocketbase, an ESM-only chain Jest cannot statically import) so this pure
 * DOM-building logic can be unit tested directly — see
 * __tests__/buildDiffLine.test.ts.
 */
export function buildDiffLine(line1: string, line2: string, charClass: string) {
	const fragment = createDiv();

	if (line1 != undefined && line1.length === 0) {
		fragment.textContent = ensureVisibleRowText(line1);
	} else if (line1 != undefined && line2 != undefined) {
		// Plain diffWords() ignores whitespace as of diff@9 and silently merges
		// a whitespace-only addition/removal into the adjacent unchanged token,
		// producing zero highlighted spans for changes like unchecking a
		// checkbox ("[x]" -> "[ ]") or adding indentation. On a conflict-
		// resolution screen that reads as "these lines are identical" and the
		// user picks a side blind. See task bccff52f.
		//
		// diffWordsWithSpace treats whitespace as its own token instead of
		// merging it away, which fixes this. It's equivalent to
		// diffWords(a, b, { ignoreWhitespace: false }) — verified byte-for-byte
		// identical output across all scenarios below — but diffWordsWithSpace
		// is the properly-typed public API for this, whereas the ignoreWhitespace
		// option isn't in @types' DiffWordsOptions at all; diff's own source
		// comment on that branch says it's "never been documented and never
		// will be", kept only for backwards compatibility.
		const differences = diffWordsWithSpace(line2, line1);

		for (const difference of differences) {
			if (difference.removed) {
				continue;
			}

			// Necessary to give the line a height when it's empty.
			const span = createSpan({
				text: ensureVisibleRowText(difference.value),
				cls: difference.added ? charClass : undefined,
			});
			fragment.appendChild(span);
		}
	} else if (line1 != undefined && line2 == undefined) {
		// Necessary to give the line a height when it's empty.
		const span = createSpan({ text: ensureVisibleRowText(line1), cls: charClass });
		fragment.appendChild(span);
	} else {
		fragment.textContent = ensureVisibleRowText(line1);
	}

	return fragment;
}
