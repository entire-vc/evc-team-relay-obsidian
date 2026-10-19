/**
 * @jest-environment jsdom
 *
 * Regression tests for buildDiffLine (differences-view word-diff rendering).
 *
 * Bug (task bccff52f): diff@9's plain diffWords() ignores whitespace-only
 * changes by default and silently merges them into the adjacent unchanged
 * token. When the ONLY change on a line is whitespace — unchecking a
 * checkbox ("- [x]" -> "- [ ]"), or adding indentation — buildDiffLine ends
 * up building zero highlighted spans. The differences-view is a conflict-
 * resolution screen: a line rendered with no highlight reads as "identical",
 * and the user picks a side blind.
 *
 * These tests exercise exactly what buildDiffLine() puts in the DOM — the
 * ordered list of (text, highlighted?) spans it builds from diff's
 * `.removed`/`.value`/`.added` fields, nothing else. buildDiffLine is
 * imported directly (not via FileDiffView, which transitively imports
 * Document.ts -> AuthSession -> pocketbase, an ESM-only chain Jest cannot
 * statically import in this repo).
 */

import { describe, test, expect } from "@jest/globals";
import { buildDiffLine } from "../src/fileDiff/buildDiffLine";

const HL = "hl";

function renderedSpans(after: string, before: string): { text: string; highlighted: boolean }[] {
	// Mirrors the real call shape in differencesView.ts's "bottom diff" loop:
	// buildDiffLine(newText, oldText, charClass).
	const fragment = buildDiffLine(after, before, HL);
	const spans: { text: string; highlighted: boolean }[] = [];
	fragment.childNodes.forEach((node) => {
		if (node.nodeType === 1) {
			const el = node as Element;
			spans.push({ text: el.textContent ?? "", highlighted: el.classList.contains(HL) });
		} else {
			spans.push({ text: node.textContent ?? "", highlighted: false });
		}
	});
	return spans;
}

describe("buildDiffLine — whitespace-only changes stay visible (bccff52f)", () => {
	test("unchecking a checkbox highlights the removed space (the regression)", () => {
		const spans = renderedSpans("- [ ] buy milk", "- [x] buy milk");
		expect(spans.some((s) => s.highlighted)).toBe(true);
	});

	test("checking a checkbox highlights the added 'x' (already worked pre-fix, stays working)", () => {
		const spans = renderedSpans("- [x] buy milk", "- [ ] buy milk");
		expect(spans.some((s) => s.highlighted)).toBe(true);
		expect(spans.some((s) => s.highlighted && s.text.includes("x"))).toBe(true);
	});

	test("added indentation highlights the inserted whitespace (the regression)", () => {
		const spans = renderedSpans("   indented", "indented");
		expect(spans.some((s) => s.highlighted)).toBe(true);
	});

	test("trailing whitespace addition is highlighted", () => {
		const spans = renderedSpans("trailing  ", "trailing");
		expect(spans.some((s) => s.highlighted)).toBe(true);
	});

	// Positive control: a change is NOT whitespace-only, so it must be
	// highlighted regardless of the whitespace fix — proves the assertion
	// style above actually distinguishes "highlighted" from "not", rather
	// than trivially passing either way.
	test("positive control — an ordinary word replacement is highlighted", () => {
		const spans = renderedSpans("the slow fox", "the quick fox");
		expect(spans.some((s) => s.highlighted && s.text === "slow")).toBe(true);
	});

	// Negative control: truly identical lines must never be highlighted —
	// guards against a fix that over-corrects into flagging non-changes.
	test("negative control — identical lines produce no highlighted spans", () => {
		const spans = renderedSpans("identical text", "identical text");
		expect(spans.some((s) => s.highlighted)).toBe(false);
	});
});
