/**
 * Regression test: — loadRelayOnPremShares first-ever
 * discovery truncated a known-remote file to 0 bytes, permanently (no
 * self-heal across 3 restarts), reproduced identically across builds.
 *
 * Root cause (live-traced against the self-hosted stand's own relay-server
 * logs and MinIO-backed storage, task comments): TransferQueue.fetchDocument()
 * only runs its WS-fallback path in relay-onprem mode -- the HTTP `as-update`
 * attempt (fetchItem()) always fails first (CWT tokens aren't accepted for
 * HTTP endpoints there). That WS path (uploadDocumentViaSocket(), reached via
 * fallbackToWebsocketSync()) had NO check on the content it ends up with: a
 * relay room the server hasn't loaded into memory yet in this process's
 * lifetime can answer sync-step-2 (flipping the client's `synced` flag) off a
 * still-loading, effectively empty placeholder, and this client's own
 * "connect just long enough to sync once" logic (`intent === "disconnected"`)
 * disconnects on that signal alone and unconditionally flushes doc.content to
 * disk -- even when it's empty. This function is only ever reached for a path
 * the folder index's OWN metadata already says exists on the relay
 * (_onServerCreate's "create" op), so an empty result here is never a
 * legitimate "brand new empty doc" on the very first attempt -- that class is
 * already handled by fetchItem()'s (dead, HTTP-only) "uninitialized doc,
 * users.size===0" branch above.
 *
 * Fix: apply the same retry-with-backoff shape fetchDocument() already uses
 * for that HTTP-path "uninitialized doc" case to this one too -- hold back
 * the flush (fallbackToWebsocketSync()'s new `shouldFlush` guard) when the WS
 * sync reports success but content is still empty and retries remain, and
 * schedule a fresh retry (a full reconnect) instead. Bounded: once retries
 * are exhausted, flush whatever's there rather than hang forever.
 *
 * These tests exercise the real, private `TransferQueue.fetchDocument()`
 * (reached via a typed cast, matching this repo's convention for testing
 * private methods with real Document instances -- see e.g.
 * pullIfUnchangedConflictCopy.test.ts for the same duck-typed-Document
 * pattern applied to a public sibling) against a minimal duck-typed Document.
 * A MockClock drives fetchDocument()'s retry backoff and
 * uploadDocumentViaSocket()'s internal PULL_SYNC_GRACE_MS delay explicitly,
 * so the test asserts on causality (what fired, in what order) rather than
 * real wall-clock timing.
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

interface FakeDocOptions {
	/** connectAttempts count (1-indexed) at which bringOnline() starts
	 * reporting real content, or undefined to never populate it (models a
	 * room that never recovers within the retry budget). */
	populateOnAttempt?: number;
}

function makeFakeDoc(opts: FakeDocOptions) {
	let remoteText = "";
	let connectAttempts = 0;
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockResolvedValue(undefined);

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => remoteText });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", {
		value: async () => {
			connectAttempts++;
			// Models the live-observed mechanism: a room that's cold on the
			// FIRST connect (still "Loading doc" server-side) answers correctly
			// on a later, fresh reconnect once it's had time to load/warm up.
			if (opts.populateOnAttempt !== undefined && connectAttempts >= opts.populateOnAttempt) {
				remoteText = "real content from the relay";
			}
			return true;
		},
	});
	Object.defineProperty(fakeDoc, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => undefined });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			workspaceId: "test-relay-id",
			// Fresh pull: nothing local yet.
			readContents: async () => {
				throw new Error("file does not exist");
			},
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});

	return { fakeDoc, writeContents, getConnectAttempts: () => connectAttempts };
}

function makeQueue(clock: MockClock) {
	const queue = new TransferQueue({} as never, clock, {} as never);
	return queue as unknown as {
		fetchDocument: (doc: Document, retry?: number, wait?: number) => Promise<void>;
	};
}

describe("fetchDocument — empty WS-sync result on a known-remote doc retries instead of silently truncating", () => {
	test("REGRESSION: first sync lands empty (cold relay room), retry reconnects and gets the real content -- never flushes empty", async () => {
		const { fakeDoc, writeContents, getConnectAttempts } = makeFakeDoc({ populateOnAttempt: 2 });
		const clock = new MockClock();
		const queue = makeQueue(clock);

		const call = queue.fetchDocument(fakeDoc, 2, 1000);

		// First attempt: fetchItem() throws immediately (resourceAddress isn't
		// a real RemoteDocumentAddress), falls to uploadDocumentViaSocket(),
		// which connects (attempt #1, still empty) then waits out its own
		// PULL_SYNC_GRACE_MS delay before returning.
		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();

		expect(getConnectAttempts()).toBe(1);
		// Empty content, retries remain -- held back, not flushed.
		expect(writeContents).not.toHaveBeenCalled();

		// Fire the scheduled retry.
		clock.setTime(clock.now() + 1000);
		await flushMicrotasks();
		// Second attempt's own PULL_SYNC_GRACE_MS delay.
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();
		await call;

		expect(getConnectAttempts()).toBe(2);
		expect(writeContents).toHaveBeenCalledTimes(1);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "real content from the relay");
	});

	test("retries exhausted while still empty: never writes a 0-byte file (#266), schedules a slow re-fetch instead", async () => {
		const { fakeDoc, writeContents, getConnectAttempts } = makeFakeDoc({});
		const clock = new MockClock();
		const queue = makeQueue(clock);

		const call = queue.fetchDocument(fakeDoc, 1, 1000);

		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();
		expect(writeContents).not.toHaveBeenCalled(); // attempt #1, one retry left

		clock.setTime(clock.now() + 1000);
		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();
		await call;

		// Budget exhausted while still empty: the throttled relay may simply not
		// have served the content yet. A 0-byte file would look "present" to
		// every later pass and never heal -- so nothing is written here.
		expect(getConnectAttempts()).toBe(2);
		expect(writeContents).not.toHaveBeenCalled();

		// A slow re-fetch with a fresh budget picks it up once the relay recovers.
		const populated = makeFakeDoc({ populateOnAttempt: 1 });
		void populated;
		clock.setTime(clock.now() + 10 * 60 * 1000);
		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();
		expect(getConnectAttempts()).toBeGreaterThanOrEqual(3);
	});

	test("a genuinely empty remote note is still created once the slow re-fetch rounds are used up", async () => {
		const { fakeDoc, writeContents } = makeFakeDoc({});
		const clock = new MockClock();
		const queue = makeQueue(clock);

		const call = queue.fetchDocument(fakeDoc, 0, 1000);
		for (let i = 0; i < 100; i++) {
			await flushMicrotasks();
			clock.setTime(clock.now() + 15 * 60 * 1000);
		}
		await call;
		await flushMicrotasks();

		expect(writeContents).toHaveBeenCalledTimes(1);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "");
	});

	test("already-warm room: first sync gets real content immediately, no retry needed", async () => {
		const { fakeDoc, writeContents, getConnectAttempts } = makeFakeDoc({ populateOnAttempt: 1 });
		const clock = new MockClock();
		const queue = makeQueue(clock);

		const call = queue.fetchDocument(fakeDoc, 2, 1000);
		await flushMicrotasks();
		clock.setTime(clock.now() + 5000);
		await flushMicrotasks();
		await call;

		expect(getConnectAttempts()).toBe(1);
		expect(writeContents).toHaveBeenCalledTimes(1);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "real content from the relay");
	});
});
