/**
 * Regression test: obsidian community-plugin validator flagged the two
 * `flush` callbacks fetchCanvas()/fetchDocument() pass into
 * fallbackToWebsocketSync() (`() => doc.vaultShare.writeContents(...)`) as
 * "Promise returned where void expected" -- `flush` was typed ` => void` but fed a Promise-returning
 * function, and fallbackToWebsocketSync() called it WITHOUT awaiting.
 *
 * Same shape of bug as pullIfUnchangedAwaitsWrite.test.ts, just reached via
 * fallbackToWebsocketSync()'s shared HTTP-download-failed tail:
 * fetchDocument() is what `drainLane()` awaits via `lane.run(item)` before
 * it clears `lane.inFlight`/resolves an `enqueueFetch()` waiter (see
 * TransferQueue.ts's queue-lane bookkeeping) -- so a caller awaiting
 * `enqueueFetch()` is entitled to assume the file is actually on disk once
 * that resolves. Before the fix, `flush()`'s promise could still be pending
 * when fetchDocument() (and therefore the whole queue item) already reported
 * "done".
 *
 * Fixture is the fetchItem()-throws-so-falls-back-to-WS-sync path already
 * exercised by fetchDocumentEmptySyncRetry.test.ts -- same
 * duck-typed Document + MockClock pattern, but `writeContents` here is a
 * manually-resolved deferred promise so the test can assert on ordering.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { MockClock } from "./mocks/MockClock";

async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
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
	// Content is already present on the very first bringOnline() -- no
	// retry needed, isolates this test to the flush-ordering question.
	Object.defineProperty(fakeDoc, "content", { get: () => "real content from the relay" });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", {
		value: () => {
			events.push("goOffline");
		},
	});
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => undefined });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			readContents: async () => {
				throw new Error("file does not exist");
			},
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});

	return { fakeDoc, writeContents, resolveWrite: () => resolveWrite() };
}

function makeQueue(clock: MockClock) {
	const queue = new TransferQueue({} as never, clock, {} as never);
	return queue as unknown as {
		fetchDocument: (doc: Document, retry?: number, wait?: number) => Promise<void>;
	};
}

describe("fetchDocument -> fallbackToWebsocketSync() -- flush() is awaited, not fired-and-forgotten", () => {
	test("REGRESSION: fetchDocument()'s own promise does not resolve until the WS-fallback disk write actually lands", async () => {
		const events: string[] = [];
		const { fakeDoc, writeContents, resolveWrite } = makeFakeDocWithDeferredWrite(events);
		const clock = new MockClock();
		const queue = makeQueue(clock);

		const fetchPromise = queue.fetchDocument(fakeDoc, 1, 1000).then(() => {
			events.push("fetch-resolved");
		});

		// fetchItem() throws synchronously (resourceAddress isn't a real
		// RemoteDocumentAddress) -> falls to fallbackToWebsocketSync() ->
		// uploadDocumentViaSocket() connects and waits out its own
		// PULL_SYNC_GRACE_MS delay before flush() is even called.
		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();

		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "real content from the relay");
		// If the flush is correctly awaited, fetchDocument() must not have
		// resolved yet -- the write is still pending. `goOffline` (fired by
		// uploadDocumentViaSocket()'s own `intent === "disconnected"` tail,
		// BEFORE the flush callback even runs) is expected here -- it's not
		// what this test is regressing against.
		expect(events).toEqual(["goOffline"]);

		resolveWrite();
		await fetchPromise;

		// The write must be recorded as resolved strictly BEFORE
		// fetchDocument() itself resolves.
		expect(events).toEqual(["goOffline", "write-resolved", "fetch-resolved"]);
	});
});
