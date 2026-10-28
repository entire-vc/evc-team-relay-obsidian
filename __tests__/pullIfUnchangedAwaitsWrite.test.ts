/**
 * Regression test: obsidian community-plugin validator flagged
 * `doc.vaultShare.writeContents(doc, remoteText)` in
 * TransferQueue.pullIfUnchanged() as a floating promise.
 *
 * This isn't just a lint nit -- pullIfUnchanged()'s only caller,
 * CrdtBackgroundSyncPoller, tracks in-flight calls in its own `pulling` set
 * specifically so the SAME doc can't be re-checked by a second
 * pullIfUnchanged() pass while a first one is still running (see that
 * file's own doc comment on `drain()`), and it only removes a guid from
 * `pulling` in a `.finally()` on the promise THIS method returns. Before the
 * fix, pullIfUnchanged() called `writeContents()` without awaiting it, so
 * its own returned promise resolved (and `pulling` released the guid)
 * BEFORE the disk write it just kicked off had actually landed -- exactly
 * the kind of write-ordering gap that has already produced real data-loss
 * bugs in this file (silently-overwritten edits, #51/#52; buffered-write-
 * vs-disconnect races, #74; ; reconcile-fast-path races,
 *).
 *
 * Same duck-typed-Document fixture pattern as
 * pullIfUnchangedConflictCopy.test.ts, but `writeContents` here is a
 * manually-resolved deferred promise so the test can assert on ORDERING:
 * pullIfUnchanged()'s own promise must not settle until writeContents()'s
 * promise has.
 */

import * as Y from "yjs";
import { describe, test, expect, jest } from "@jest/globals";
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

/**
 * InstantClock (above) schedules every timeout/interval via `setImmediate`,
 * a macrotask -- plain microtask flushing (`await Promise.resolve()`) never
 * lets those callbacks run. `pullIfUnchanged()` goes through
 * raceTimeout()/delay() (both clock-scheduled) before it ever reaches the
 * writeContents() call this test is probing, so this needs to flush
 * macrotasks too.
 */
async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function makeFakeDocWithDeferredWrite(events: string[]) {
	let resolveWrite!: () => void;
	const writePromise = new Promise<void>((resolve) => {
		resolveWrite = () => {
			events.push("write-resolved");
			resolve();
		};
	});
	const writeContents = jest.fn<(doc: unknown, content: string) => Promise<void>>(
		() => writePromise,
	);

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => "relay content EDITED BY PEER" });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", {
		value: () => {
			events.push("goOffline");
		},
	});
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => "shared content" });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			readContents: async () => "shared content",
			writeConflictCopy: jest.fn(),
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});

	return { fakeDoc, writeContents, resolveWrite: () => resolveWrite() };
}

function makeQueue(): TransferQueue {
	return new TransferQueue({} as never, new InstantClock(), {} as never);
}

describe("pullIfUnchanged — writeContents() is awaited, not fired-and-forgotten", () => {
	test("REGRESSION: pullIfUnchanged()'s own promise does not resolve until the disk write actually lands", async () => {
		const events: string[] = [];
		const { fakeDoc, writeContents, resolveWrite } = makeFakeDocWithDeferredWrite(events);

		const queue = makeQueue();
		const pullPromise = queue.pullIfUnchanged(fakeDoc).then(() => {
			events.push("pull-resolved");
		});

		// Let everything up to (and including) the writeContents() call run,
		// but do NOT resolve the write yet.
		await flushMicrotasks();

		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "relay content EDITED BY PEER");
		// If pullIfUnchanged() awaits the write correctly, its own .then()
		// must not have fired yet -- the write is still pending.
		expect(events).toEqual([]);

		resolveWrite();
		await pullPromise;

		// The write must be recorded as resolved strictly BEFORE
		// pullIfUnchanged() itself resolves. `goOffline` (the doc's
		// `intent === "disconnected"` tail) is expected to run AFTER the
		// write too -- it's sequenced after the write in the source, not
		// part of what this test is regressing against.
		expect(events).toEqual(["write-resolved", "goOffline", "pull-resolved"]);
	});
});
