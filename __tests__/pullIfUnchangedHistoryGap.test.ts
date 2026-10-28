/**
 * Regression test: after a restart the author of a closed note found it
 * empty on disk, while its CRDT and the peer's disk held the full text.
 *
 * The author's local store can replay updates that start past clocks it
 * never stored (the provider seeds state before the store attaches). Yjs
 * keeps those updates pending, so until the relay sends the missing part
 * the text reads as "" (or a fragment). A background pull that ran in that
 * window compared "" against the full file, found the base equal to the
 * file (no local edit) and overwrote the file with "". Nothing rewrote it
 * once the relay filled the gap: the file stayed empty.
 *
 * A doc with a history gap does not show what was last synced: no pull,
 * fetch or upload may write that text to disk, seed the file into it or
 * record it as the sync base, however long the gap lasts. Nor may a pull
 * write anything before its connection has completed a sync: until then
 * the text is only what the local store held.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";

/** Fires every timer on the next macrotask; `now()` only moves when a test moves it. */
class InstantClock implements Clock {
	time = Date.now();
	/** Scheduled timeouts are dropped when false, e.g. a fetch's next retry. */
	fireTimeouts = true;
	now(): number {
		return this.time;
	}
	scheduleTimeout(callback: () => void): number {
		if (this.fireTimeouts) setImmediate(callback);
		return 0;
	}
	scheduleInterval(callback: () => void): number {
		setImmediate(callback);
		return 0;
	}
	cancelTimeout(): void {}
	cancelInterval(): void {}
	teardown(): void {}
	debounced<T extends (...args: unknown[]) => void>(func: T): (...args: Parameters<T>) => void {
		return (...args: Parameters<T>) => func(...args);
	}
}

const FULL_TEXT = "TR persistent note\nUnicode: café, заметка, 日本語\nReverse edit from client B\n";
const PATIENCE_MS = 10 * 60 * 1000;

/** The author's doc and the updates its store kept: they start past the seeded clocks. */
function authorHistory(text = FULL_TEXT) {
	const author = new Y.Doc();
	author.getMap("users").set("author", "seeded before the store attached");
	const seeded = Y.encodeStateVector(author);
	author.getText("contents").insert(0, text);
	return { stored: Y.encodeStateAsUpdate(author, seeded), full: Y.encodeStateAsUpdate(author) };
}

/** The author's doc after a restart, before the relay has sent anything. */
function docWithHistoryGap(history = authorHistory()): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, history.stored);
	return doc;
}

/** A doc whose text a peer genuinely cleared: complete history, empty text. */
function docClearedByPeer(): Y.Doc {
	const doc = new Y.Doc();
	const text = doc.getText("contents");
	text.insert(0, FULL_TEXT);
	text.delete(0, text.length);
	return doc;
}

function makeFakeDoc(crdtDoc: Y.Doc, vaultContents: string, syncBase: string | undefined) {
	const state = { vault: vaultContents, syncBase };
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockImplementation(async (_doc, content) => {
			state.vault = content;
		});
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict TIMESTAMP).md");
	const setSyncBase = jest.fn<(text: string) => Promise<void>>().mockImplementation(async (text) => {
		state.syncBase = text;
	});

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "nested/note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: crdtDoc });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {}, writable: true });
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "_liveProvider", { value: { ws: null, awareness: null } });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => state.syncBase });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: setSyncBase });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			readContents: async () => state.vault,
			hasFile: async () => true,
			writeConflictCopy,
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { fakeDoc, writeContents, writeConflictCopy, setSyncBase, state };
}

function makeQueue(clock = new InstantClock()): TransferQueue {
	const queue = new TransferQueue({} as never, clock, {} as never);
	jest.spyOn(queue, "enqueueUpload").mockResolvedValue(undefined);
	return queue;
}

describe("pullIfUnchanged — a doc with a history gap is never flushed to disk", () => {
	test("the restarted author's doc reads empty while its updates are pending", () => {
		const doc = docWithHistoryGap();
		expect(doc.getText("contents").toString()).toBe("");
		expect(doc.store.pendingStructs).not.toBeNull();
	});

	test("REGRESSION: the full file stays on disk while the CRDT has a history gap", async () => {
		const { fakeDoc, writeContents, writeConflictCopy, setSyncBase, state } = makeFakeDoc(
			docWithHistoryGap(),
			FULL_TEXT,
			FULL_TEXT,
		);

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(state.vault).toBe(FULL_TEXT);
		expect(state.syncBase).toBe(FULL_TEXT);
		expect(result.outcome).toBe("history-gap");
		// Not reported as delivered content, so an announced change is re-checked.
		expect(result.remoteText).toBeUndefined();
	});

	test("the relay's sync on the pull's connection closes the gap: the file is left alone", async () => {
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeContents } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);
		// The relay holds the whole history and sends it once the socket syncs.
		fakeDoc.onceFreshlySynced = async () => Y.applyUpdate(crdtDoc, history.full);

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(crdtDoc.store.pendingStructs).toBeNull();
		expect(writeContents).not.toHaveBeenCalled();
		expect(result.outcome).toBe("unchanged");
		expect(result.remoteText).toBe(FULL_TEXT);
	});

	test.each([
		["empty", authorHistory(), ""],
		["shorter", authorHistory(), "PEER EDIT\n"],
	])(
		"a gap that outlasts any wait never overwrites the file with %s text",
		async (_label, history, peerText) => {
			// The relay syncs, but never sends the missing part.
			const crdtDoc = docWithHistoryGap(history);
			if (peerText) {
				const peer = new Y.Doc();
				peer.getText("contents").insert(0, peerText);
				Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
			}
			expect(crdtDoc.getText("contents").toString()).toBe(peerText);
			const { fakeDoc, writeContents, writeConflictCopy, setSyncBase, state } = makeFakeDoc(
				crdtDoc,
				FULL_TEXT,
				FULL_TEXT,
			);
			const clock = new InstantClock();
			const queue = makeQueue(clock);

			for (const step of [0, PATIENCE_MS, PATIENCE_MS * 10]) {
				clock.time += step;
				expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");
			}

			expect(writeContents).not.toHaveBeenCalled();
			expect(writeConflictCopy).not.toHaveBeenCalled();
			expect(setSyncBase).not.toHaveBeenCalled();
			expect(state.vault).toBe(FULL_TEXT);
		},
	);

	test("without a completed sync an empty doc with no gap does not blank the file", async () => {
		// Nothing pending, so no gap to detect: only this connection's sync can
		// tell an empty local store from a note a peer cleared.
		const crdtDoc = new Y.Doc();
		const { fakeDoc, writeContents, setSyncBase, state } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);
		let syncCalls = 0;
		fakeDoc.onceFreshlySynced = () => {
			syncCalls++;
			return new Promise<void>(() => {});
		};

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(syncCalls).toBe(1);
		expect(result.outcome).toBe("not-synced");
		expect(result.remoteText).toBeUndefined();
		expect(writeContents).not.toHaveBeenCalled();
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(state.vault).toBe(FULL_TEXT);
	});

	test("a file an earlier version already blanked gets the full text once the gap closes, with no editor open", async () => {
		// 0.1.27 wrote "" over the file and recorded "" as the base.
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, "", "");
		const queue = makeQueue();

		// The relay has not sent the missing part yet: nothing is written.
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");
		expect(writeContents).not.toHaveBeenCalled();

		// The next background pull's sync fills the gap.
		fakeDoc.onceFreshlySynced = async () => Y.applyUpdate(crdtDoc, history.full);
		const result = await queue.pullIfUnchanged(fakeDoc);

		expect(result.outcome).toBe("flushed");
		expect(state.vault).toBe(FULL_TEXT);
		expect(state.syncBase).toBe(FULL_TEXT);
	});

	test("a gap that outlasts the patience without any completed sync never blanks the file", async () => {
		// The relay never answers this doc's catch-up: no sync completes.
		const crdtDoc = docWithHistoryGap();
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);
		fakeDoc.onceFreshlySynced = () => new Promise<void>(() => {});
		const clock = new InstantClock();
		const queue = makeQueue(clock);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("not-synced");
		clock.time += PATIENCE_MS * 3;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("not-synced");

		expect(writeContents).not.toHaveBeenCalled();
		expect(state.vault).toBe(FULL_TEXT);
	});

	test("control: a note a peer genuinely cleared is still written to disk", async () => {
		const { fakeDoc, writeContents, state } = makeFakeDoc(docClearedByPeer(), FULL_TEXT, FULL_TEXT);

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "");
		expect(state.vault).toBe("");
		expect(result.outcome).toBe("flushed");
	});
});

describe("upload and fetch — a doc with a history gap is not reconciled, recorded or flushed", () => {
	test("upload does not seed the file into the gapped doc nor record its text as the base", async () => {
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, setSyncBase, writeConflictCopy } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		// Once the relay fills the gap the text is the author's, not doubled.
		Y.applyUpdate(crdtDoc, history.full);
		expect(crdtDoc.getText("contents").toString()).toBe(FULL_TEXT);
	});

	test.each([
		["clear", (text: Y.Text) => text.delete(0, text.length), ""],
		["edit", (text: Y.Text) => text.insert(0, "PEER LINE\n"), "PEER LINE\n" + FULL_TEXT],
	])(
		"a no-base doc whose gap closes keeps a peer's %s: nothing is written over it, no conflict copy",
		async (_label, peerChange, remote) => {
			const history = authorHistory();
			const crdtDoc = docWithHistoryGap(history);
			const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, FULL_TEXT, undefined);
			const queue = makeQueue();
			// Whatever the pull queues really runs, so a stale-file reconcile would show.
			const uploads: Promise<boolean>[] = [];
			jest.mocked(queue.enqueueUpload).mockImplementation(async (doc) => {
				uploads.push(queue.uploadDocumentViaSocket(doc as Document));
			});

			await queue.uploadDocumentViaSocket(fakeDoc);
			expect(state.syncBase).toBeUndefined();

			// The relay fills the gap together with the peer's change.
			const peer = new Y.Doc();
			Y.applyUpdate(peer, history.full);
			peerChange(peer.getText("contents"));
			Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
			expect(crdtDoc.getText("contents").toString()).toBe(remote);

			await queue.pullIfUnchanged(fakeDoc);
			await Promise.all(uploads);

			expect(uploads).toHaveLength(0);
			expect(crdtDoc.getText("contents").toString()).toBe(remote);
			expect(writeConflictCopy).not.toHaveBeenCalled();
			// Only the peer's text reaches the file, never the stale one back.
			for (const [, written] of writeContents.mock.calls) expect(written).toBe(remote);
		},
	);

	test.each([
		["clear", (text: Y.Text) => text.delete(0, text.length), ""],
		["edit", (text: Y.Text) => text.insert(0, "PEER LINE\n"), "PEER LINE\n" + FULL_TEXT],
	])(
		"a no-base doc converges on a peer's %s in one background pull once its gap closes",
		async (_label, peerChange, remote) => {
			// The upload was held back by the gap; the file still holds what this
			// client's own history held, so it is stale, not a local edit.
			const history = authorHistory();
			const crdtDoc = docWithHistoryGap(history);
			const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, FULL_TEXT, undefined);
			const queue = makeQueue();
			const uploads: Promise<boolean>[] = [];
			jest.mocked(queue.enqueueUpload).mockImplementation(async (doc) => {
				uploads.push(queue.uploadDocumentViaSocket(doc as Document));
			});

			await queue.uploadDocumentViaSocket(fakeDoc);

			const peer = new Y.Doc();
			Y.applyUpdate(peer, history.full);
			peerChange(peer.getText("contents"));
			Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

			const pull = await queue.pullIfUnchanged(fakeDoc);
			await Promise.all(uploads);

			expect(pull.outcome).toBe("flushed");
			expect(crdtDoc.getText("contents").toString()).toBe(remote);
			expect(state.vault).toBe(remote);
			expect(state.syncBase).toBe(remote);
			expect(writeConflictCopy).not.toHaveBeenCalled();
			expect(writeContents).toHaveBeenCalledTimes(1);

			// The next cycle finds nothing to do and puts nothing stale back.
			expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("unchanged");
			await queue.uploadDocumentViaSocket(fakeDoc);
			expect(crdtDoc.getText("contents").toString()).toBe(remote);
			expect(state.vault).toBe(remote);
		},
	);

	test("a no-base doc whose file was edited apart from its history is left for the upload to reconcile", async () => {
		// Edited while the plugin was not running: the file is not what this
		// client's history held, so it may carry work the relay never saw.
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const offlineEdit = FULL_TEXT + "Offline line\n";
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, offlineEdit, undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);

		const peer = new Y.Doc();
		Y.applyUpdate(peer, history.full);
		peer.getText("contents").insert(0, "PEER LINE\n");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

		const pull = await queue.pullIfUnchanged(fakeDoc);

		expect(pull.outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe(offlineEdit);
		expect(state.syncBase).toBeUndefined();
	});

	test("a no-base doc whose stored history builds on text it does not hold is not taken for stale", async () => {
		// "BASE" by one client, " tail" appended by another: only the second
		// is stored, so what this client saw of "BASE" is unknown.
		const base = new Y.Doc();
		base.getText("contents").insert(0, "BASE");
		const tail = new Y.Doc();
		Y.applyUpdate(tail, Y.encodeStateAsUpdate(base));
		const before = Y.encodeStateVector(tail);
		tail.getText("contents").insert(4, " tail");
		const crdtDoc = new Y.Doc();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(tail, before));
		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		// Deleted "BASE" while the plugin was not running.
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, " tail", undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(tail));
		peer.getText("contents").insert(0, "PEER ");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("PEER BASE tail");

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe(" tail");
	});

	test("a no-base doc whose stored history reaches text it does not hold through another client is not taken for stale", async () => {
		// B typed "TAIL"; A put "BASE" before it, then appended to a list;
		// C appended after A, B after C. Only B's structs are stored: they
		// reach A's "BASE" only through C's entry, which is missing. No
		// deletion names A either.
		const b = new Y.Doc();
		b.getText("contents").insert(0, "TAIL");
		const a = new Y.Doc();
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		a.getText("contents").insert(0, "BASE");
		a.getArray("chain").push([1]);
		const c = new Y.Doc();
		Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
		c.getArray("chain").push([2]);
		Y.applyUpdate(b, Y.encodeStateAsUpdate(c));
		b.getArray("chain").push([3]);
		const allButB = Y.decodeStateVector(Y.encodeStateVector(b));
		allButB.delete(b.clientID);
		const crdtDoc = new Y.Doc();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(b, Y.encodeStateVector(allButB)));
		expect(crdtDoc.getText("contents").toString()).toBe("TAIL");
		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		// Deleted "BASE" while the plugin was not running.
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, "TAIL", undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(b));
		peer.getText("contents").insert(0, "PEER ");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("PEER BASETAIL");

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe("TAIL");
	});

	test("a no-base doc whose history chain runs through a collected nested type is not taken for stale", async () => {
		// As above, but the chain lives in a nested list that a peer then
		// deletes: its entries are collected and their references are gone.
		const d = new Y.Doc();
		d.getMap("m").set("list", new Y.Array<number>());
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(d));
		b.getText("contents").insert(0, "TAIL");
		const a = new Y.Doc();
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		a.getText("contents").insert(0, "BASE");
		(a.getMap("m").get("list") as Y.Array<number>).push([1]);
		const c = new Y.Doc();
		Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
		(c.getMap("m").get("list") as Y.Array<number>).push([2]);
		Y.applyUpdate(b, Y.encodeStateAsUpdate(c));
		(b.getMap("m").get("list") as Y.Array<number>).push([3]);
		const onlyB = Y.decodeStateVector(Y.encodeStateVector(b));
		onlyB.set(b.clientID, 0);
		const crdtDoc = new Y.Doc();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(d));
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(b, Y.encodeStateVector(onlyB)));
		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, "TAIL", undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(b));
		peer.getMap("m").delete("list");
		peer.getText("contents").insert(0, "PEER ");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("PEER BASETAIL");

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe("TAIL");
	});

	test("a no-base doc whose gap is only a deletion of text it does not hold is not taken for stale", async () => {
		const author = new Y.Doc();
		author.getText("contents").insert(0, "BASE");
		const inserted = Y.encodeStateVector(author);
		author.getText("contents").delete(0, 4);
		const crdtDoc = new Y.Doc();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(author, inserted));
		expect(crdtDoc.store.pendingDs).not.toBeNull();
		// Cleared while the plugin was not running.
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, "", undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(author));
		peer.getText("contents").insert(0, "PEER");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("PEER");

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(state.vault).toBe("");
	});

	test("once a pull sees the file in step, a later edit back to the old text is not taken for stale", async () => {
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, FULL_TEXT, undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, history.full);
		peer.getText("contents").insert(0, "PEER LINE\n");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		// The peer's text reached the file some other way.
		state.vault = "PEER LINE\n" + FULL_TEXT;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("unchanged");

		// Reverted while the plugin was not running; the peer edits again.
		state.vault = FULL_TEXT;
		peer.getText("contents").insert(0, "MORE\n");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(writeContents).not.toHaveBeenCalled();
		expect(state.vault).toBe(FULL_TEXT);
	});

	test("a pull aborted after the gap closed leaves the next pull to deliver the peer's clear", async () => {
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeConflictCopy, state } = makeFakeDoc(crdtDoc, FULL_TEXT, undefined);
		const queue = makeQueue();

		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, history.full);
		peer.getText("contents").delete(0, peer.getText("contents").length);
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

		const controller = new AbortController();
		const aborted = await queue.pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			onPhase: (phase) => {
				if (phase === "sync-base") controller.abort();
			},
		});
		expect(aborted.outcome).toBe("aborted");
		expect(state.vault).toBe(FULL_TEXT);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("flushed");
		expect(state.vault).toBe("");
		expect(state.syncBase).toBe("");
		expect(writeConflictCopy).not.toHaveBeenCalled();
	});

	test("a doc recreated under the same guid while gapped converges on its own gap", async () => {
		const queue = makeQueue();
		const first = makeFakeDoc(docWithHistoryGap(), FULL_TEXT, undefined);
		await queue.uploadDocumentViaSocket(first.fakeDoc);
		first.fakeDoc.crdtDoc.destroy();

		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, state } = makeFakeDoc(crdtDoc, FULL_TEXT, undefined);
		await queue.uploadDocumentViaSocket(fakeDoc);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, history.full);
		peer.getText("contents").delete(0, peer.getText("contents").length);
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("flushed");
		expect(state.vault).toBe("");
	});

	test("a peer's clear that lands while an upload is held back by a gap reaches disk", async () => {
		const history = authorHistory();
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);
		const queue = makeQueue();
		const internals = queue as unknown as {
			uploadDocument: (doc: Document, priority: boolean) => Promise<void>;
			uploadRetryStats: { failed: number };
		};

		await internals.uploadDocument(fakeDoc, false);
		// No retry is left to reconcile the stale file over what comes next.
		expect(internals.uploadRetryStats.failed).toBe(0);

		// A peer clears the note; the relay fills the gap along with it.
		const peer = new Y.Doc();
		Y.applyUpdate(peer, history.full);
		peer.getText("contents").delete(0, peer.getText("contents").length);
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("");

		const result = await queue.pullIfUnchanged(fakeDoc);

		expect(result.outcome).toBe("flushed");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe("");
		expect(state.syncBase).toBe("");
		expect(crdtDoc.getText("contents").toString()).toBe("");
	});

	test("fetch holds back partial text of a gapped doc while retries remain", async () => {
		// The peer's line is integrated, the author's text is still pending: partial, not empty.
		const crdtDoc = docWithHistoryGap();
		const peer = new Y.Doc();
		peer.getText("contents").insert(0, "PEER LINE\n");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		expect(crdtDoc.getText("contents").toString()).toBe("PEER LINE\n");
		const { fakeDoc, writeContents } = makeFakeDoc(crdtDoc, "", undefined);
		const clock = new InstantClock();
		const queue = makeQueue(clock) as unknown as {
			fetchDocument: (doc: Document, retry?: number, wait?: number, slowRounds?: number) => Promise<void>;
		};

		const fetching = queue.fetchDocument(fakeDoc, 1, 1000, 0);
		// Let the sync grace pass, then drop the retry the fetch schedules.
		await new Promise((resolve) => setImmediate(resolve));
		clock.fireTimeouts = false;
		await fetching;

		expect(writeContents).not.toHaveBeenCalled();
	});

	test.each([
		["empty", ""],
		["partial", "PEER LINE\n"],
	])("fetch with no retry left still never writes a gapped doc's %s text over a local edit", async (_label, peerText) => {
		const crdtDoc = docWithHistoryGap();
		if (peerText) {
			const peer = new Y.Doc();
			peer.getText("contents").insert(0, peerText);
			Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		}
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, "local edit\n", FULL_TEXT);
		const queue = makeQueue(new InstantClock()) as unknown as {
			fetchDocument: (doc: Document, retry?: number, wait?: number, slowRounds?: number) => Promise<void>;
		};

		await queue.fetchDocument(fakeDoc, 0, 1000, 0);

		expect(writeContents).not.toHaveBeenCalled();
		expect(state.vault).toBe("local edit\n");
	});
});
