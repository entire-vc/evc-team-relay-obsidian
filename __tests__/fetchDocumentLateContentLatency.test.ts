/**
 * Regression test: a second client attaching to a share with
 * notes left one note in the folder index but never on disk for minutes
 * (2 of 3 files after >4 min on the hosted relay).
 *
 * fetchDocument() holds back the flush while a known-remote doc still reads
 * empty (#266), which is right. But once its fast retry budget
 * (~27s of reconnects) is spent, the next look used to be a flat
 * SLOW_REFETCH_MS = 5 min away. A relay room that serves its real content
 * only a few seconds after that budget ran out -- a cold room still loading
 * its snapshot, a peer's upload that lands late -- therefore left the note
 * missing for five minutes on a client that already has its record.
 *
 * The slow rounds now start small and grow, so late content lands within
 * the 45s the share-join acceptance allows, while the total wait before
 * accepting a genuinely empty note stays at least as long as before.
 */

import * as Y from "yjs";
import { describe, test, expect, jest } from "@jest/globals";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { MockClock } from "./mocks/MockClock";

async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

/** A doc whose relay room reads empty until `readyAt` (clock time). */
function makeLateDoc(clock: MockClock, readyAt: number) {
	let remoteText = "";
	const writes: number[] = [];
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockImplementation(async () => {
			writes.push(clock.now());
		});

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "local1.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "late-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => remoteText });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", {
		value: async () => {
			if (clock.now() >= readyAt) remoteText = "late content from the relay";
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
			readContents: async () => {
				throw new Error("file does not exist");
			},
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { fakeDoc, writeContents, writes };
}

function makeQueue(clock: MockClock) {
	const queue = new TransferQueue({} as never, clock, {} as never);
	return queue as unknown as { fetchDocument: (doc: Document) => Promise<void> };
}

/** Advance the mock clock one second at a time up to `untilMs` past `start`. */
async function runFor(clock: MockClock, start: number, untilMs: number): Promise<void> {
	while (clock.now() - start < untilMs) {
		clock.setTime(clock.now() + 1000);
		await flushMicrotasks();
	}
}

describe("fetchDocument — content that appears after the fast retries lands within 45s", () => {
	test("REGRESSION: relay serves the note 30s after the first attempt -> on disk by 45s, not after 5 min", async () => {
		const clock = new MockClock();
		const start = clock.now();
		const { fakeDoc, writeContents, writes } = makeLateDoc(clock, start + 30_000);
		const queue = makeQueue(clock);

		void queue.fetchDocument(fakeDoc);
		await flushMicrotasks();
		await runFor(clock, start, 45_000);

		expect(writeContents).toHaveBeenCalledTimes(1);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "late content from the relay");
		expect(writes[0] - start).toBeLessThanOrEqual(45_000);
	});

	test("a note that stays empty is still not written as 0 bytes before the old 15-minute budget", async () => {
		const clock = new MockClock();
		const start = clock.now();
		const { fakeDoc, writeContents } = makeLateDoc(clock, Number.POSITIVE_INFINITY);
		const queue = makeQueue(clock);

		void queue.fetchDocument(fakeDoc);
		await flushMicrotasks();
		await runFor(clock, start, 15 * 60_000);

		expect(writeContents).not.toHaveBeenCalled();
	});
});
