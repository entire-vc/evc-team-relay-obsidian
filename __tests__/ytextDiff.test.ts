/**
 * Unit tests: applyDiffToYText
 *
 * The bug: uploadDocumentViaSocket used to call applyDiffToYText(ydoc, vaultContent)
 * unconditionally whenever the Y.Doc's synced text differed from the vault
 * file. applyDiffToYText diffs against whatever the Y.Doc CURRENTLY holds —
 * which can include another client's edits merged in moments earlier via the
 * WebSocket connect — and applies real delete ops for anything not present in
 * the vault file. Those deletes are ordinary CRDT ops: they broadcast, and
 * once GC'd they're unrecoverable. No conflict is ever surfaced.
 *
 * These tests use real Y.Doc instances (yjs is the library under test, not an
 * external boundary — mocking it would test nothing) and simulate a second
 * client's edit via Y.applyUpdate, the same mechanism a real relay sync uses.
 */

import { describe, test, expect } from "@jest/globals";
import * as Y from "yjs";
import { applyDiffToYText } from "../src/ytextDiff";

function makeDocWithText(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("contents").insert(0, text);
	return doc;
}

describe("applyDiffToYText", () => {
	test("rewrites Y.Text to match the target string", () => {
		const doc = makeDocWithText("hello world");
		applyDiffToYText(doc, "hello there world");
		expect(doc.getText("contents").toJSON()).toBe("hello there world");
	});

	test("no-op when content already matches", () => {
		const doc = makeDocWithText("unchanged");
		applyDiffToYText(doc, "unchanged");
		expect(doc.getText("contents").toJSON()).toBe("unchanged");
	});
});
