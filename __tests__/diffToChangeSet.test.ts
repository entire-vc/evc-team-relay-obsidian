/**
 * Regression test for diffToChangeSet's offset computation (TR·plugin,
 * PR #114 hold).
 *
 * diffChars (from the `diff` package, >=6.0.0) counts Unicode CODE POINTS,
 * but CodeMirror's ChangeSet positions are UTF-16 CODE UNITS. Deriving an
 * offset from part.count instead of part.value.length silently drifts by
 * one for every non-BMP character (emoji, CJK extension-B, ...) preceding
 * an edit, producing a ChangeSet that corrupts the document when applied.
 * Pure-ASCII input can never exercise this -- code point count and UTF-16
 * length coincide there -- which is why no existing test or fixture caught
 * it.
 *
 * `changesFromDiffParts` is tested directly with hand-built parts whose
 * `count` is the Unicode CODE POINT count (i.e. what diff@6+ actually
 * produces), independent of whichever `diff` major version happens to be
 * installed right now (still 5.x at the time this test was written --
 * see PR #114/task e748521c). That keeps the test meaningful both before
 * and after the diff@9 bump lands.
 */

import { describe, test, expect } from "@jest/globals";
import { Text } from "@codemirror/state";
import type { Change } from "diff";
import { changesFromDiffParts, diffToChangeSet } from "../src/diffToChangeSet";

function codePointCount(s: string): number {
	return Array.from(s).length;
}

function applyParts(originalText: string, parts: Change[]): string {
	const changeSet = changesFromDiffParts(parts, originalText.length);
	return changeSet.apply(Text.of([originalText])).toString();
}

function applyDiff(originalText: string, newText: string): string {
	return diffToChangeSet(originalText, newText).apply(Text.of([originalText])).toString();
}

describe("changesFromDiffParts (diff@6+ code-point-counted parts)", () => {
	test("single emoji (non-BMP, UTF-16 surrogate pair) before the edit", () => {
		// "hello 👋 " -> unchanged, "world" -> "WORLD"
		const original = "hello 👋 world";
		const unchanged = "hello 👋 ";
		const parts: Change[] = [
			{ count: codePointCount(unchanged), value: unchanged },
			{ count: codePointCount("world"), value: "world", removed: true },
			{ count: codePointCount("WORLD"), value: "WORLD", added: true },
		];
		expect(applyParts(original, parts)).toBe("hello 👋 WORLD");
	});

	test("two emoji before the edit", () => {
		const original = "👋👋 world";
		const unchanged = "👋👋 ";
		const parts: Change[] = [
			{ count: codePointCount(unchanged), value: unchanged },
			{ count: codePointCount("world"), value: "world", removed: true },
			{ count: codePointCount("WORLD"), value: "WORLD", added: true },
		];
		expect(applyParts(original, parts)).toBe("👋👋 WORLD");
	});

	test("CJK extension-B character (non-BMP) before the edit", () => {
		const original = "a 𠀋 world";
		const unchanged = "a 𠀋 ";
		const parts: Change[] = [
			{ count: codePointCount(unchanged), value: unchanged },
			{ count: codePointCount("world"), value: "world", removed: true },
			{ count: codePointCount("WORLD"), value: "WORLD", added: true },
		];
		expect(applyParts(original, parts)).toBe("a 𠀋 WORLD");
	});
});

describe("diffToChangeSet (end-to-end via the real installed diff package)", () => {
	test("positive control: pure ASCII edit", () => {
		const updated = "hello WORLD";
		expect(applyDiff("hello world", updated)).toBe(updated);
	});

	test("single emoji before the edit", () => {
		const updated = "hello 👋 WORLD";
		expect(applyDiff("hello 👋 world", updated)).toBe(updated);
	});

	test("non-BMP character inside the removed/added span itself", () => {
		const updated = "hello 🎉 there";
		expect(applyDiff("hello 👋 there", updated)).toBe(updated);
	});
});
