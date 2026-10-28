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
import { hasHistoryGap } from "../src/preserveBeforeTrash";

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
 * A presence entry (the `users` map that `Y.PermanentUserData` keeps) whose
 * first clocks never reached anyone: the later pushes into its `ids`/`ds`
 * lists wait for them forever, while the text's history is complete.
 */
function presenceOnlyGap(opts: { deletePushed?: boolean } = {}): Uint8Array {
	const ghost = new Y.Doc();
	const user = new Y.Map<unknown>();
	user.set("ids", new Y.Array<number>());
	user.set("ds", new Y.Array<Uint8Array>());
	ghost.getMap("users").set("ghost-account", user);
	const ids = user.get("ids") as Y.Array<number>;
	ids.push([ghost.clientID]);
	const seeded = Y.encodeStateVector(ghost);
	ids.push([ghost.clientID + 1]);
	(user.get("ds") as Y.Array<Uint8Array>).push([new Uint8Array([0, 1, 2])]);
	if (opts.deletePushed) ids.delete(1, 1);
	return Y.encodeStateAsUpdate(ghost, seeded);
}

/** A peer's complete doc with `text`, plus the presence entries nobody can integrate. */
function docWithPresenceGap(text = FULL_TEXT, opts: { deletePushed?: boolean } = {}) {
	const peer = new Y.Doc();
	peer.getText("contents").insert(0, text);
	const crdtDoc = new Y.Doc();
	Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));
	Y.applyUpdate(crdtDoc, presenceOnlyGap(opts));
	return { crdtDoc, peer };
}

describe("a gap only in the presence map does not hold the text back", () => {
	test("the presence entries stay pending while the text is complete", () => {
		const { crdtDoc } = docWithPresenceGap(FULL_TEXT, { deletePushed: true });
		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		expect(crdtDoc.store.pendingDs).not.toBeNull();
		expect(crdtDoc.getText("contents").toString()).toBe(FULL_TEXT);
		expect(hasHistoryGap(crdtDoc)).toBe(false);
	});

	test.each([
		["pending structs", {}],
		["pending structs and deletes", { deletePushed: true }],
	])("REGRESSION: a peer's edit to a closed note reaches disk (%s in users)", async (_label, opts) => {
		const { crdtDoc, peer } = docWithPresenceGap(FULL_TEXT, opts);
		const { fakeDoc, writeContents, writeConflictCopy, state } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);
		// The peer edits the note while it is closed here; the pull's sync brings the edit.
		peer.getText("contents").insert(0, "PEER LINE\n");
		fakeDoc.onceFreshlySynced = async () => Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(peer));

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		expect(result.outcome).toBe("flushed");
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "PEER LINE\n" + FULL_TEXT);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(state.vault).toBe("PEER LINE\n" + FULL_TEXT);
		expect(state.syncBase).toBe("PEER LINE\n" + FULL_TEXT);
	});

	test("upload reconciles a local file edit into a doc whose gap is only in users, as without a gap", async () => {
		const local = FULL_TEXT + "LOCAL LINE\n";
		const runUpload = async (crdtDoc: Y.Doc) => {
			const { fakeDoc, writeConflictCopy, state } = makeFakeDoc(crdtDoc, local, FULL_TEXT);
			await makeQueue().uploadDocumentViaSocket(fakeDoc);
			return {
				text: crdtDoc.getText("contents").toString(),
				conflictCopies: writeConflictCopy.mock.calls.length,
				syncBase: state.syncBase,
			};
		};
		const gapFree = new Y.Doc();
		gapFree.getText("contents").insert(0, FULL_TEXT);

		const withPresenceGap = await runUpload(docWithPresenceGap().crdtDoc);

		expect(withPresenceGap).toEqual(await runUpload(gapFree));
		// Reconciled: the file's text reached the CRDT and is the recorded base.
		expect(withPresenceGap.text).toContain("LOCAL LINE\n");
		expect(withPresenceGap.syncBase).toBe(withPresenceGap.text);
	});

	test("a new presence entry pending behind the writer's lost clocks is not a gap", () => {
		const ghost = new Y.Doc();
		ghost.getMap("users").set("ghost-account", "seeded, never sent");
		const seeded = Y.encodeStateVector(ghost);
		ghost.getMap("users").set("second-account", new Y.Map<unknown>());
		const { crdtDoc } = docWithPresenceGap();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(ghost, seeded));

		expect(crdtDoc.store.pendingStructs).not.toBeNull();
		expect(hasHistoryGap(crdtDoc)).toBe(false);
	});

	test("pending text from the same writer after its presence entry is still a gap", () => {
		const ghost = new Y.Doc();
		ghost.getMap("users").set("ghost-account", "seeded, never sent");
		const seeded = Y.encodeStateVector(ghost);
		ghost.getMap("users").set("other", new Uint8Array([1]));
		ghost.getText("contents").insert(0, "GHOST TEXT\n");
		const { crdtDoc } = docWithPresenceGap();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(ghost, seeded));

		expect(crdtDoc.getText("contents").toString()).toBe(FULL_TEXT);
		expect(hasHistoryGap(crdtDoc)).toBe(true);
	});
});
