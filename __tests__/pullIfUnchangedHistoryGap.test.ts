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

	const goOffline = jest.fn<() => void>();

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
	Object.defineProperty(fakeDoc, "goOffline", { value: goOffline });
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
	return { fakeDoc, writeContents, writeConflictCopy, setSyncBase, goOffline, state };
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

	test("upload of an explicit edit on a legacy doc with tombstones and no init flag still sends the edit", async () => {
		// Written before the init flag existed: text inserted and cleared, base "".
		const crdtDoc = docClearedByPeer();
		const { fakeDoc, state } = makeFakeDoc(crdtDoc, "LOCAL EDIT\n", "");

		await makeQueue().uploadDocumentViaSocket(fakeDoc);

		expect(crdtDoc.getText("contents").toString()).toBe("LOCAL EDIT\n");
		expect(state.syncBase).toBe("LOCAL EDIT\n");
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

			const pull = await queue.pullIfUnchanged(fakeDoc);
			await Promise.all(uploads);

			expect(pull.outcome).toBe("no-base");
			expect(uploads).toHaveLength(0);
			expect(crdtDoc.getText("contents").toString()).toBe(remote);
			expect(writeContents).not.toHaveBeenCalled();
			expect(writeConflictCopy).not.toHaveBeenCalled();
			// The local file is left as it was, for the next upload to take.
			expect(state.vault).toBe(FULL_TEXT);
		},
	);

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

/**
 * The author's note reached the relay as a file entry only: its text never
 * made it into the CRDT, on the author or on the relay. A restart re-queues
 * an upload only for a note the relay never acknowledged, so the background
 * pull is the one pass that still looks at it, and without a base it left
 * the file alone. Every other client kept the note empty.
 */
describe("pullIfUnchanged — an author's text that never reached the relay is seeded", () => {
	const AUTHOR_TEXT = "TR acceptance entire-018-2014\nUnicode: café, заметка, 日本語\n";
	const CONFIRM_MS = 60_000;

	/** The author's doc as stored: presence only, no text item ever, no init claim. */
	function docWithoutText(): Y.Doc {
		const doc = new Y.Doc();
		doc.getMap("users").set("author", "presence");
		return doc;
	}

	/** Mirrors every local update into a relay-side doc, like the provider would. */
	function relayOf(crdtDoc: Y.Doc): Y.Doc {
		const relay = new Y.Doc();
		Y.applyUpdate(relay, Y.encodeStateAsUpdate(crdtDoc));
		crdtDoc.on("update", (update: Uint8Array) => Y.applyUpdate(relay, update));
		return relay;
	}

	/** Applies `edit` from a peer that has seen everything `crdtDoc` holds. */
	function peerEdit(crdtDoc: Y.Doc, edit: (text: Y.Text) => void) {
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(crdtDoc));
		const before = Y.encodeStateVector(peer);
		edit(peer.getText("contents"));
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer, before));
	}

	/** Runs the first pull, which only starts the wait, and moves the clock past it. */
	async function firstPull(fakeDoc: Document) {
		const clock = new InstantClock();
		const queue = makeQueue(clock);
		const first = await queue.pullIfUnchanged(fakeDoc);
		clock.time += CONFIRM_MS;
		return { queue, clock, first };
	}

	/** Runs `edit` during the `nth` file read from now on. */
	function duringRead(fakeDoc: Document, state: { vault: string }, nth: number, edit: () => void) {
		let reads = 0;
		fakeDoc.vaultShare.readContents = async () => {
			if (++reads === nth) edit();
			return state.vault;
		};
		return () => reads;
	}

	test("REGRESSION: a no-base author whose relay text never held an item is seeded on the confirming pass", async () => {
		const crdtDoc = docWithoutText();
		const relay = relayOf(crdtDoc);
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);

		// One connection proves nothing: a room still loading also reads empty.
		const { queue, first } = await firstPull(fakeDoc);
		expect(first.outcome).toBe("no-base");
		expect(crdtDoc.getText("contents").toString()).toBe("");

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("seed-local");

		// Disk = CRDT = relay = the author's text, and that is the agreed base.
		expect(state.vault).toBe(AUTHOR_TEXT);
		expect(crdtDoc.getText("contents").toString()).toBe(AUTHOR_TEXT);
		expect(relay.getText("contents").toString()).toBe(AUTHOR_TEXT);
		expect(state.syncBase).toBe(AUTHOR_TEXT);
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(queue.enqueueUpload).not.toHaveBeenCalled();

		// The next pass finds nothing to do.
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("unchanged");
		expect(relay.getText("contents").toString()).toBe(AUTHOR_TEXT);
	});

	test("a confirmation that the relay contradicts in between starts over", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue, clock } = await firstPull(fakeDoc);

		// The loaded room turns out to hold a peer's text: not a seed case.
		peerEdit(crdtDoc, (text) => text.insert(0, "PEER LINE\n"));
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		// The peer clears it again: tombstones remain, still not a seed case.
		peerEdit(crdtDoc, (text) => text.delete(0, text.length));
		clock.time += CONFIRM_MS;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		clock.time += CONFIRM_MS;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");

		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(state.vault).toBe(AUTHOR_TEXT);
	});

	test("a peer's insert and clear that land while the seed reads the file are not undone", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, writeConflictCopy, setSyncBase, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);

		// The pull reads the file twice before it decides; the seed's read is the third.
		const reads = duringRead(fakeDoc, state, 3, () =>
			peerEdit(crdtDoc, (text) => {
				text.insert(0, "PEER LINE\n");
				text.delete(0, text.length);
			}),
		);
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");

		expect(reads()).toBeGreaterThanOrEqual(3);
		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(state.vault).toBe(AUTHOR_TEXT);
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
	});

	test("a peer's text that lands while the seed reads the file is not reconciled over", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, writeContents, writeConflictCopy, setSyncBase, state } = makeFakeDoc(
			crdtDoc,
			AUTHOR_TEXT,
			undefined,
		);
		const { queue } = await firstPull(fakeDoc);

		duringRead(fakeDoc, state, 3, () => peerEdit(crdtDoc, (text) => text.insert(0, "PEER LINE\n")));
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");

		expect(crdtDoc.getText("contents").toString()).toBe("PEER LINE\n");
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(state.vault).toBe(AUTHOR_TEXT);
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
	});

	test("a peer's edit that lands right after the seed reaches the file on the next pull", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, writeConflictCopy, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);

		// A peer edits the seeded text while the seed reads the file to record the base.
		let edited = false;
		fakeDoc.vaultShare.readContents = async () => {
			if (!edited && crdtDoc.getText("contents").toString() === AUTHOR_TEXT) {
				edited = true;
				peerEdit(crdtDoc, (text) => text.insert(text.length, "PEER LINE\n"));
			}
			return state.vault;
		};
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("seed-local");
		expect(edited).toBe(true);
		// What was seeded is the agreed text: the peer's edit is a diff against it.
		expect(state.syncBase).toBe(AUTHOR_TEXT);
		expect(state.vault).toBe(AUTHOR_TEXT);

		// Without that base every later pull stopped at "no-base" for good.
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("flushed");
		expect(state.vault).toBe(AUTHOR_TEXT + "PEER LINE\n");
		expect(state.syncBase).toBe(AUTHOR_TEXT + "PEER LINE\n");
		expect(writeConflictCopy).not.toHaveBeenCalled();
	});

	test("a file edited while the seed is flushed is not recorded as the base", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, setSyncBase, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);

		duringRead(fakeDoc, state, 4, () => {
			state.vault = AUTHOR_TEXT + "LOCAL LINE\n";
		});
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("seed-local");

		expect(crdtDoc.getText("contents").toString()).toBe(AUTHOR_TEXT);
		expect(setSyncBase).not.toHaveBeenCalled();
	});

	test.each([
		// The init claim is the seed's first write: the abort lands while it settles.
		["while the claim settles", (crdtDoc: Y.Doc, controller: AbortController) => {
			crdtDoc.once("afterTransaction", () => controller.abort());
		}],
		["while the seed reads the file", () => {}],
	])("a pull aborted %s seeds nothing and drops its connection", async (_label, armClaimAbort) => {
		const crdtDoc = docWithoutText();
		const relay = relayOf(crdtDoc);
		const { fakeDoc, setSyncBase, goOffline, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);
		goOffline.mockClear();

		const controller = new AbortController();
		const claimCase = armClaimAbort.length > 0;
		// Read 2 is the pull's last one before the seed starts its claim; read 3 is the seed's.
		duringRead(fakeDoc, state, claimCase ? 2 : 3, () =>
			claimCase ? armClaimAbort(crdtDoc, controller) : controller.abort(),
		);
		const phases: string[] = [];
		const result = await queue.pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});

		expect(result.outcome).toBe("aborted");
		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(relay.getText("contents").toString()).toBe("");
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(phases).not.toContain("write");
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("the seed enters the write phase before it inserts, so a deadline cannot abort it halfway", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);

		let textAtWrite: string | undefined;
		const result = await queue.pullIfUnchanged(fakeDoc, {
			signal: new AbortController().signal,
			onPhase: (phase) => {
				if (phase === "write") textAtWrite = crdtDoc.getText("contents").toString();
			},
		});

		expect(result.outcome).toBe("seed-local");
		expect(textAtWrite).toBe("");
	});

	test("a base write that fails still drops the pull's connection", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc, setSyncBase, goOffline } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);
		goOffline.mockClear();
		setSyncBase.mockRejectedValueOnce(new Error("store closed"));

		await expect(queue.pullIfUnchanged(fakeDoc)).rejects.toThrow("store closed");
		expect(crdtDoc.getText("contents").toString()).toBe(AUTHOR_TEXT);
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("a pull in between that does not find the note unseeded restarts the wait", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue, clock } = await firstPull(fakeDoc);

		fakeDoc.onceFreshlySynced = () => new Promise<void>(() => {});
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("not-synced");
		fakeDoc.onceFreshlySynced = async () => {};
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(crdtDoc.getText("contents").toString()).toBe("");
		clock.time += CONFIRM_MS;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("seed-local");
		expect(crdtDoc.getText("contents").toString()).toBe(AUTHOR_TEXT);
	});

	test("a no-base doc whose text a peer cleared keeps the clear: nothing seeded, file untouched", async () => {
		// The relay held the text once and a peer deleted it: its items stay as tombstones.
		const crdtDoc = docClearedByPeer();
		const relay = relayOf(crdtDoc);
		const { fakeDoc, writeContents, writeConflictCopy, setSyncBase, state } = makeFakeDoc(
			crdtDoc,
			AUTHOR_TEXT,
			undefined,
		);
		const { queue } = await firstPull(fakeDoc);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");

		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(relay.getText("contents").toString()).toBe("");
		expect(state.vault).toBe(AUTHOR_TEXT);
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(setSyncBase).not.toHaveBeenCalled();
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
	});

	test("a no-base doc with a history gap and no text item is not seeded", async () => {
		// The pending part may be the author's own text: a seed would double it.
		const history = authorHistory(AUTHOR_TEXT);
		const crdtDoc = docWithHistoryGap(history);
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const clock = new InstantClock();
		const queue = makeQueue(clock);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");
		clock.time += CONFIRM_MS;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");

		expect(writeContents).not.toHaveBeenCalled();
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
		Y.applyUpdate(crdtDoc, history.full);
		expect(crdtDoc.getText("contents").toString()).toBe(AUTHOR_TEXT);
		expect(state.vault).toBe(AUTHOR_TEXT);
	});

	test("a no-base doc whose seed is already marked done is not seeded again", async () => {
		const crdtDoc = docWithoutText();
		crdtDoc.getMap("meta").set("initDone", true);
		const { fakeDoc } = makeFakeDoc(crdtDoc, AUTHOR_TEXT, undefined);
		const { queue } = await firstPull(fakeDoc);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("no-base");
		expect(crdtDoc.getText("contents").toString()).toBe("");
	});

	test("an empty file on a no-base doc seeds nothing", async () => {
		const crdtDoc = docWithoutText();
		const { fakeDoc } = makeFakeDoc(crdtDoc, "", undefined);
		const { queue } = await firstPull(fakeDoc);

		await queue.pullIfUnchanged(fakeDoc);
		expect(crdtDoc.getText("contents").toString()).toBe("");
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
	});
});
