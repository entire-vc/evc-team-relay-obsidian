/**
 * Unit tests: applyDiffToYText + reconcileWithConflictCopy
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

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	applyDiffToYText,
	reconcileWithConflictCopy,
} from "../src/ytextDiff";

function makeDocWithText(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("contents").insert(0, text);
	return doc;
}

/** Simulate a second client concurrently appending `addition` and merge it in,
 * the same way a relay WebSocket sync merges a remote update. */
function mergeRemoteAppend(doc: Y.Doc, addition: string): void {
	const remote = new Y.Doc();
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
	remote.getText("contents").insert(
		remote.getText("contents").length,
		addition,
	);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
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

describe("reconcileWithConflictCopy", () => {
	test("does nothing and writes no conflict copy when content already matches", async () => {
		const doc = makeDocWithText("same content");
		const writer = jest.fn<() => Promise<string>>().mockResolvedValue("x");

		const result = await reconcileWithConflictCopy(doc, "same content", writer);

		expect(result.reconciled).toBe(false);
		expect(result.conflictPath).toBeUndefined();
		expect(writer).not.toHaveBeenCalled();
		expect(doc.getText("contents").toJSON()).toBe("same content");
	});

	test("on plain divergence: preserves old content via writer, then reconciles to vault content", async () => {
		const doc = makeDocWithText("device A's local edit");
		const writer = jest
			.fn<(content: string) => Promise<string>>()
			.mockResolvedValue("notes/file (conflict).md");

		const result = await reconcileWithConflictCopy(
			doc,
			"vault file content",
			writer,
		);

		expect(writer).toHaveBeenCalledTimes(1);
		expect(writer).toHaveBeenCalledWith("device A's local edit");
		expect(result.reconciled).toBe(true);
		expect(result.conflictPath).toBe("notes/file (conflict).md");
		expect(doc.getText("contents").toJSON()).toBe("vault file content");
	});

	test("REGRESSION: another client's merged edit is captured by the conflict copy before being overwritten, never silently discarded", async () => {
		// Simulates: doc starts with base content, a second client concurrently
		// appends " [edit from client B]" and it merges in via the relay
		// WebSocket sync — exactly what happens right before the destructive
		// reconciliation used to run in uploadDocumentViaSocket.
		const doc = makeDocWithText("shared base content");
		mergeRemoteAppend(doc, " [edit from client B]");
		expect(doc.getText("contents").toJSON()).toBe(
			"shared base content [edit from client B]",
		);

		// The LOCAL vault file is stale — it never saw client B's edit.
		const staleVaultContent = "shared base content";

		let capturedBeforeOverwrite = "";
		const writer = jest
			.fn<(content: string) => Promise<string>>()
			.mockImplementation(async (content) => {
				capturedBeforeOverwrite = content;
				return "shared base content (relay conflict).md";
			});

		const result = await reconcileWithConflictCopy(
			doc,
			staleVaultContent,
			writer,
		);

		// Client B's edit is GONE from the live doc (existing vault-wins
		// behavior is preserved) — but it was captured first, not lost.
		expect(doc.getText("contents").toJSON()).toBe(staleVaultContent);
		expect(capturedBeforeOverwrite).toBe(
			"shared base content [edit from client B]",
		);
		expect(capturedBeforeOverwrite).toContain("[edit from client B]");
		expect(result.reconciled).toBe(true);
		expect(result.conflictPath).toBe(
			"shared base content (relay conflict).md",
		);
	});

	test("fails closed: if the conflict-copy write throws, the Y.Doc is left untouched", async () => {
		const doc = makeDocWithText("content that must not vanish");
		const writer = jest
			.fn<() => Promise<string>>()
			.mockRejectedValue(new Error("disk full"));
		const log = jest.fn();

		const result = await reconcileWithConflictCopy(
			doc,
			"different vault content",
			writer,
			undefined,
			log,
		);

		expect(result.reconciled).toBe(false);
		expect(result.conflictPath).toBeUndefined();
		// The Y.Doc must be UNCHANGED — this is the fail-closed guarantee.
		expect(doc.getText("contents").toJSON()).toBe(
			"content that must not vanish",
		);
		expect(log).toHaveBeenCalled();
	});

	test("passes origin through to the underlying transact (so it's attributable, same as before)", async () => {
		const doc = makeDocWithText("old");
		const origins: unknown[] = [];
		doc.on("afterTransaction", (tr: Y.Transaction) => {
			origins.push(tr.origin);
		});
		const writer = jest.fn<() => Promise<string>>().mockResolvedValue("path");
		const marker = Symbol("test-origin");

		await reconcileWithConflictCopy(doc, "new", writer, marker);

		expect(origins).toContain(marker);
	});
});
