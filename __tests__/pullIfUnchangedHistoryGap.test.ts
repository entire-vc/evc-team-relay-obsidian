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
 * record it as the sync base. A gap no sync closes (changes the relay never
 * received) is waited out for a bounded time only.
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

	test("a gap no sync closes is waited out, then a peer's edit still reaches disk", async () => {
		// This client's own changes the relay never received stay pending;
		// a peer's edit is fully integrated next to them.
		const crdtDoc = docWithHistoryGap(authorHistory("never sent\n"));
		const peer = new Y.Doc();
		peer.getText("contents").insert(0, "PEER EDIT\n");
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
		const { fakeDoc, writeContents, state } = makeFakeDoc(crdtDoc, "old\n", "old\n");
		const clock = new InstantClock();
		const queue = makeQueue(clock);

		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");
		clock.time += PATIENCE_MS - 1;
		expect((await queue.pullIfUnchanged(fakeDoc)).outcome).toBe("history-gap");
		expect(writeContents).not.toHaveBeenCalled();

		clock.time += 1;
		const result = await queue.pullIfUnchanged(fakeDoc);

		expect(result.outcome).toBe("flushed");
		expect(state.vault).toBe("PEER EDIT\n");
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
});
