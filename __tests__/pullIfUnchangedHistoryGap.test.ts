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
 * A doc with a history gap does not show what was last synced, so the pull
 * must not flush it to disk.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";

class InstantClock implements Clock {
	now(): number {
		return Date.now();
	}
	scheduleTimeout(callback: () => void): number {
		setImmediate(callback);
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

/** The author's doc after a restart: its stored updates start past clocks it never stored. */
function docWithHistoryGap(): Y.Doc {
	const author = new Y.Doc();
	author.getMap("users").set("author", "seeded before the store attached");
	const seeded = Y.encodeStateVector(author);
	author.getText("contents").insert(0, FULL_TEXT);
	const stored = Y.encodeStateAsUpdate(author, seeded);

	const restarted = new Y.Doc();
	Y.applyUpdate(restarted, stored);
	return restarted;
}

/** A doc whose text a peer genuinely cleared: complete history, empty text. */
function docClearedByPeer(): Y.Doc {
	const doc = new Y.Doc();
	const text = doc.getText("contents");
	text.insert(0, FULL_TEXT);
	text.delete(0, text.length);
	return doc;
}

function makeFakeDoc(crdtDoc: Y.Doc, vaultContents: string, syncBase: string) {
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
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => state.syncBase });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: setSyncBase });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
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

function makeQueue(): TransferQueue {
	const queue = new TransferQueue({} as never, new InstantClock(), {} as never);
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

	test("once the relay fills the gap the pull sees the full text and leaves the file alone", async () => {
		const author = new Y.Doc();
		author.getMap("users").set("author", "seeded before the store attached");
		const seeded = Y.encodeStateVector(author);
		author.getText("contents").insert(0, FULL_TEXT);
		const crdtDoc = new Y.Doc();
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(author, seeded));
		// The relay holds the whole history: its sync supplies the missing clocks.
		Y.applyUpdate(crdtDoc, Y.encodeStateAsUpdate(author));
		expect(crdtDoc.store.pendingStructs).toBeNull();
		const { fakeDoc, writeContents } = makeFakeDoc(crdtDoc, FULL_TEXT, FULL_TEXT);

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(result.outcome).toBe("unchanged");
		expect(result.remoteText).toBe(FULL_TEXT);
	});

	test("control: a note a peer genuinely cleared is still written to disk", async () => {
		const { fakeDoc, writeContents, state } = makeFakeDoc(docClearedByPeer(), FULL_TEXT, FULL_TEXT);

		const result = await makeQueue().pullIfUnchanged(fakeDoc);

		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "");
		expect(state.vault).toBe("");
		expect(result.outcome).toBe("flushed");
	});
});
