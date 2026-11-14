/**
 * Regression test: — spurious relay-conflict-copy on a normal
 * remote edit, and its sibling (same underlying mechanism).
 *
 * Root cause (traced live against the self-hosted stand, see task
 * comments): `TransferQueue.reconcileRelayContent()` treated ANY divergence
 * between the synced Y.Doc text and the on-disk vault file as a potential
 * conflict and always preserved a copy before overwriting. But a plain text
 * diff can't tell "only THIS client edited since we last agreed with the
 * relay" (safe to apply directly — e.g. `app.vault.modify()` with no live
 * editor binding, which writes straight to disk without going through the
 * Y.Doc first) apart from "the relay moved too" (a genuine conflict). Every
 * no-live-editor local edit was hitting the first case and being treated
 * like the second, producing a `(relay conflict …).md` file nobody asked
 * for even though nothing actually diverged from another client.
 *
 * Fix: `Document.getSyncBase()/setSyncBase()` record what this client's
 * Y.Doc last agreed with the relay on. `reconcileRelayContent()` now only
 * preserves a conflict copy when the synced text no longer matches that
 * base — i.e. when the relay has genuinely moved since we last synced.
 *
 * These tests exercise the real `TransferQueue.uploadDocumentViaSocket()`
 * against a minimal duck-typed Document (real `Document.prototype` in its
 * chain, real `Y.Doc` for the CRDT operations applyDiffToYText/
 * reconcileWithConflictCopy actually touch) — same pattern as
 * uploadDocumentViaSocketOrdering.test.ts.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { createHash } from "crypto";
import * as Y from "yjs";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { SystemClock } from "../src/Clock";

interface FakeDocOptions {
	/** What `doc.content` reads as when uploadDocumentViaSocket starts (post-connect synced content). */
	syncedText: string;
	/** What's currently on disk. */
	vaultContents: string;
	/** The last text this client recorded as agreeing with the relay on, or undefined if never set. */
	initialBase: string | undefined;
	/** Successive disk reads after the first; the last one repeats. Defaults to `vaultContents`. */
	laterVaultReads?: string[];
	/** Whether the note is being deleted. */
	deletePending?: boolean;
	/** Makes writeConflictCopy() reject, like a failed vault create. */
	conflictCopyFails?: boolean;
}

function makeFakeDoc(opts: FakeDocOptions) {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, opts.syncedText);

	let base = opts.initialBase;
	const writeConflictCopy = jest.fn<(doc: unknown, content: string, label: string) => Promise<string>>();
	if (opts.conflictCopyFails) {
		writeConflictCopy.mockRejectedValue(new Error("vault create failed"));
	} else {
		writeConflictCopy.mockResolvedValue("note (relay conflict TIMESTAMP).md");
	}
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockResolvedValue(undefined);
	const reads = [opts.vaultContents, ...(opts.laterVaultReads ?? [])];
	let readCount = 0;

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "path", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: ydoc });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", {
		get: () => ydoc.getText("contents").toJSON(),
	});
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			readContents: async () => reads[Math.min(readCount++, reads.length - 1)],
			writeConflictCopy,
			writeContents,
			isDeletePending: () => opts.deletePending ?? false,
		},
	});
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "connected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "_liveProvider", { value: { ws: null } });
	Object.defineProperty(fakeDoc, "getSyncBase", {
		value: async () => base,
	});
	Object.defineProperty(fakeDoc, "setSyncBase", {
		value: async (text: string) => {
			base = text;
		},
	});

	return { fakeDoc, ydoc, writeConflictCopy, writeContents, getBase: () => base };
}

function makeQueue(): TransferQueue {
	return new TransferQueue({} as never, new SystemClock(), {} as never);
}

describe("uploadDocumentViaSocket — sync-base gates the conflict-copy preserve step", () => {
	test("own not-yet-pushed edit, relay unchanged since last sync: reconciles WITHOUT a conflict copy", async () => {
		// This is the exact trace: base/syncedText = pre-edit content
		// (what we last agreed on with the relay), vaultContents = this
		// client's own edit, written straight to disk with no live editor
		// binding (app.vault.modify()'s !file.connected path).
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "verify272f initial content",
			vaultContents: "verify272f EDITED-FROM-B content",
			initialBase: "verify272f initial content",
		});

		const queue = makeQueue();
		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("verify272f EDITED-FROM-B content");
		// The new agreement point is recorded for the next sync.
		expect(getBase()).toBe("verify272f EDITED-FROM-B content");
	});

	test("REGRESSION: relay moved since our last sync and the file diverged: local text kept in full as a conflict copy, relay text lands on disk", async () => {
		// Our recorded base is the ORIGINAL pre-conflict text, but the synced
		// text we just read (post-connect) already includes another client's
		// edit -- a real divergence. Pushing the file over the relay would
		// revert that edit for every peer; instead the file's text is kept
		// as a copy and the relay's text is delivered, as pullIfUnchanged() does.
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "base content [edit from client A]",
			vaultContents: "base content [edit from client B]",
			initialBase: "base content",
		});

		const queue = makeQueue();
		const result = await queue.uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy).toHaveBeenCalledWith(
			fakeDoc,
			"base content [edit from client B]",
			expect.stringMatching(/^relay conflict /),
		);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "base content [edit from client A]");
		expect(fakeDoc.content).toBe("base content [edit from client A]");
		expect(getBase()).toBe("base content [edit from client A]");
	});

	test("no recorded base yet (first divergence ever seen for this doc): defaults to the safe, preserving path", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			syncedText: "old synced text",
			vaultContents: "new vault text",
			initialBase: undefined,
		});

		const queue = makeQueue();
		await queue.uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
	});

	test("content already in sync: no conflict copy, and the base is (re)recorded", async () => {
		const { fakeDoc, writeConflictCopy, getBase } = makeFakeDoc({
			syncedText: "same everywhere",
			vaultContents: "same everywhere",
			initialBase: undefined,
		});

		const queue = makeQueue();
		await queue.uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(getBase()).toBe("same everywhere");
	});
});

describe("uploadDocumentViaSocket — relay moved, file still holds the agreed text", () => {
	test("delivers the relay's text to disk instead of reverting the peer's edit", async () => {
		// The receiver's echo upload of its own delivered write: the file
		// holds the last agreed text, a peer's edit arrived while connecting.
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
		});

		const result = await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "a1-1 by A");
		expect(getBase()).toBe("a1-1 by A");
	});

	test("a local edit made while connecting is never lost: kept in full as a copy before the relay text lands", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			laterVaultReads: ["a1-0", "a1-0 typed on B"],
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		// The relay moved too: the edit typed meanwhile is the copy, the peer's text the note.
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy.mock.calls[0][1]).toBe("a1-0 typed on B");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "a1-1 by A");
		expect(fakeDoc.content).toBe("a1-1 by A");
		expect(getBase()).toBe("a1-1 by A");
	});

	test("REGRESSION: a file off the base is never written over before its text is kept as a copy", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			syncedText: "base [peer edit]",
			vaultContents: "base [my edit]",
			initialBase: "base",
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy.mock.calls[0][1]).toBe("base [my edit]");
		expect(writeConflictCopy.mock.invocationCallOrder[0]).toBeLessThan(
			writeContents.mock.invocationCallOrder[0],
		);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "base [peer edit]");
		expect(fakeDoc.content).toBe("base [peer edit]");
	});

	test("a failed final read writes nothing and keeps the base at the disk text", async () => {
		// readVaultContents() reads a failed read as "".
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			laterVaultReads: ["a1-0", ""],
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		// A base ahead of the disk would push the stale file over the peer next time.
		expect(getBase()).toBe("a1-0");
	});

	test("a note being deleted is not written and its base stays", async () => {
		const { fakeDoc, writeContents, getBase } = makeFakeDoc({
			syncedText: "a1-1 by A",
			vaultContents: "a1-0",
			initialBase: "a1-0",
			deletePending: true,
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("a1-1 by A");
		expect(getBase()).toBe("a1-0");
	});
});

describe("uploadDocumentViaSocket — relay moved and the file holds a local edit", () => {
	test("character loss: a remote edit removed text still in the local file -- the copy holds the full original local text, the note gets the remote text", async () => {
		const original = "line one\nline two to be deleted remotely\nline three";
		const local = original + "\nlocal tail";
		const remote = "line one\nline three";
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: remote,
			vaultContents: local,
			initialBase: original,
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy.mock.calls[0][1]).toBe(local);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, remote);
		// The CRDT keeps the remote deletion: nothing is pushed back over it.
		expect(fakeDoc.content).toBe(remote);
		expect(getBase()).toBe(remote);
	});

	test("the next sync after the delivery makes no second copy", async () => {
		const original = "line one\nline two\nline three";
		const remote = "line one\nline three";
		const first = makeFakeDoc({
			syncedText: remote,
			vaultContents: original + " local",
			initialBase: original,
		});
		await makeQueue().uploadDocumentViaSocket(first.fakeDoc);
		expect(first.writeConflictCopy).toHaveBeenCalledTimes(1);

		// The restart: the disk holds what was delivered, the base was recorded.
		const second = makeFakeDoc({
			syncedText: remote,
			vaultContents: remote,
			initialBase: first.getBase(),
		});
		await makeQueue().uploadDocumentViaSocket(second.fakeDoc);

		expect(second.writeConflictCopy).not.toHaveBeenCalled();
		expect(second.writeContents).not.toHaveBeenCalled();
		expect(second.fakeDoc.content).toBe(remote);
	});

	test("a failed conflict copy leaves the file and the base alone, so the next sync preserves it again", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "line one\nline three",
			vaultContents: "line one\nline two\nline three local",
			initialBase: "line one\nline two\nline three",
			conflictCopyFails: true,
		});

		const result = await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(result).toBe(true);
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeContents).not.toHaveBeenCalled();
		// Neither the file text pushed over the relay nor the relay text recorded as agreed.
		expect(fakeDoc.content).toBe("line one\nline three");
		expect(getBase()).toBe("line one\nline two\nline three");
	});

	test("an edit typed while the copy was written is not overwritten", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "base [peer edit]",
			vaultContents: "base [my edit]",
			initialBase: "base",
			laterVaultReads: ["base [my edit]", "base [my edit]", "base [my edit] more"],
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeContents).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("base [peer edit]");
		expect(getBase()).toBe("base");
	});

	test("a note being deleted gets no copy and no write", async () => {
		const { fakeDoc, writeConflictCopy, writeContents, getBase } = makeFakeDoc({
			syncedText: "base [peer edit]",
			vaultContents: "base [my edit]",
			initialBase: "base",
			deletePending: true,
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
		expect(fakeDoc.content).toBe("base [peer edit]");
		expect(getBase()).toBe("base");
	});

	test("control: an empty relay text (room not loaded) keeps the old reconcile path", async () => {
		const { fakeDoc, writeContents } = makeFakeDoc({
			syncedText: "",
			vaultContents: "local text",
			initialBase: "base",
		});

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
	});
});

/**
 * Replay of a live two-peer run on 0.1.33 (Entire relay, peer B reconnects
 * after an offline edit). The texts are the run's own: the base hashes to the
 * recorded sha256 prefixes (k1 aa83f8529d171b57, k2 bab1089c4fb9a892). Peer A
 * deleted "ABC" while B was offline; B appended a line to k1 and left k2 alone.
 * Recorded on 0.1.33: B's copy held A's text, the note kept "ABC" and the
 * deletion was reverted on A too; k2 (control) took A's text with no copy.
 */
describe("live replay: reconnect after an offline edit while a peer deleted text", () => {
	const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
	const base = (k: string) => `KEEP ABC ${k} entire-1793841371\nUnicode: café, заметка, 日本語\n`;
	const remote = (k: string) => `KEEP  ${k} entire-1793841371\nUnicode: café, заметка, 日本語\n`;
	const localK1 = base("k1") + "LOCAL EDIT MADE OFFLINE ON B\n";

	test("the replayed texts are the recorded ones", () => {
		expect(sha256(base("k1")).slice(0, 16)).toBe("aa83f8529d171b57");
		expect(sha256(base("k2")).slice(0, 16)).toBe("bab1089c4fb9a892");
	});

	test("k1: the copy keeps the full local text, the note takes the remote deletion, a restart adds no copy", async () => {
		const b = makeFakeDoc({ syncedText: remote("k1"), vaultContents: localK1, initialBase: base("k1") });

		await makeQueue().uploadDocumentViaSocket(b.fakeDoc);

		expect(b.writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(sha256(b.writeConflictCopy.mock.calls[0][1])).toBe(sha256(localK1));
		expect(b.writeContents).toHaveBeenCalledWith(b.fakeDoc, remote("k1"));
		// Nothing is pushed back: peer A keeps its deletion.
		expect(b.fakeDoc.content).toBe(remote("k1"));

		const restarted = makeFakeDoc({
			syncedText: remote("k1"),
			vaultContents: remote("k1"),
			initialBase: b.getBase(),
		});
		await makeQueue().uploadDocumentViaSocket(restarted.fakeDoc);
		expect(restarted.writeConflictCopy).not.toHaveBeenCalled();
		expect(restarted.writeContents).not.toHaveBeenCalled();
	});

	test("k2 control: an unmodified note takes the remote text with no copy", async () => {
		const b = makeFakeDoc({ syncedText: remote("k2"), vaultContents: base("k2"), initialBase: base("k2") });

		await makeQueue().uploadDocumentViaSocket(b.fakeDoc);

		expect(b.writeConflictCopy).not.toHaveBeenCalled();
		expect(b.writeContents).toHaveBeenCalledWith(b.fakeDoc, remote("k2"));
		expect(b.fakeDoc.content).toBe(remote("k2"));
	});
});
