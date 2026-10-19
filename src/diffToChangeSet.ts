"use strict";

/**
 * Pure text-diff-to-CodeMirror-ChangeSet conversion, extracted from
 * ShareLinkPlugin.ts so it can be unit-tested directly -- ShareLinkPlugin.ts
 * transitively imports src/components/EditorStatusActions.svelte (via ViewBindings.ts),
 * which Jest cannot parse.
 *
 * CodeMirror ChangeSet positions are UTF-16 code units. `diff`'s diffChars
 * (>=6.0.0) counts Unicode code points, not UTF-16 code units, so a part's
 * `count` diverges from the UTF-16 length of `part.value` by one for every
 * non-BMP character (emoji, CJK extension-B, etc.) preceding the edit.
 * Always derive offsets from part.value.length (a JS string's .length is
 * UTF-16 code units), never from part.count.
 *
 * changesFromDiffParts is exported separately from diffToChangeSet so it can
 * be exercised directly with hand-built parts that simulate diff@6+'s
 * code-point counting -- this makes the regression test meaningful
 * regardless of which `diff` major version happens to be installed.
 */
import { ChangeSet } from "@codemirror/state";
import { diffChars, type Change } from "diff";

export function changesFromDiffParts(
	diffResult: Change[],
	originalLength: number,
): ChangeSet {
	const changes: { from: number; to?: number; insert?: string }[] = [];

	let index = 0;
	for (const part of diffResult) {
		if (!part.count) {
			continue;
		}
		if (part.added) {
			changes.push({ from: index, insert: part.value });
		} else if (part.removed) {
			changes.push({ from: index, to: index + part.value.length });
			index += part.value.length;
		} else {
			index += part.value.length;
		}
	}
	return ChangeSet.of(changes, originalLength);
}

export function diffToChangeSet(originalText: string, newText: string): ChangeSet {
	return changesFromDiffParts(diffChars(originalText, newText), originalText.length);
}
