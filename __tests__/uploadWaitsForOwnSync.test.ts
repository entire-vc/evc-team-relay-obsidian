/**
 * An upload of a closed note waits for its own connection's sync.
 *
 * Measured on 0.1.25 under an 800-note bulk load: some edits reached the
 * relay only 34-38s after their upload reported success in 2.4s. The note
 * had synced once before, so the upload's sync wait resolved at once,
 * while bringOnline() had only started a socket that was still queued.
 * The edit went into a socket that was not open yet, its frame was
 * dropped, and the upload closed the socket before it ever opened.
 */

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
	scheduleInterval(): number {
		return 0;
	}
	cancelTimeout(): void {}
	cancelInterval(): void {}
	teardown(): void {}
	debounced<T extends (...args: unknown[]) => void>(func: T): (...args: Parameters<T>) => void {
		return (...args: Parameters<T>) => func(...args);
	}
}

async function flushMacrotasks(times = 30): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeDoc() {
	let syncThisConnection: () => void = () => {};
	const freshSync = new Promise<void>((resolve) => (syncThisConnection = resolve));
	const goOffline = jest.fn();
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "entryPath", { value: "note.md" });
	Object.defineProperty(doc, "entityGuid", { value: "note-guid" });
	Object.defineProperty(doc, "editLock", { value: false });
	Object.defineProperty(doc, "resourceAddress", { value: {} });
	Object.defineProperty(doc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(doc, "content", { get: () => "same" });
	Object.defineProperty(doc, "connectionIntent", { get: () => "disconnected" });
	// Starts the socket and returns; the socket itself opens later.
	Object.defineProperty(doc, "bringOnline", { value: async () => true });
	// Synced on an earlier connection: this flag is sticky.
	Object.defineProperty(doc, "onceEverSynced", { value: () => Promise.resolve() });
	Object.defineProperty(doc, "onceFreshlySynced", { value: () => freshSync });
	Object.defineProperty(doc, "goOffline", { value: goOffline });
	Object.defineProperty(doc, "vaultShare", {
		value: {
			readContents: async () => "same",
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { doc, goOffline, syncThisConnection };
}

describe("uploadDocumentViaSocket on a closed note", () => {
	test("does not finish, or close the socket, before this connection has synced", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never);
		const { doc, goOffline, syncThisConnection } = makeDoc();
		let done: boolean | undefined;
		void queue.uploadDocumentViaSocket(doc).then((ok) => (done = ok));
		await flushMacrotasks();
		expect(done).toBeUndefined();
		expect(goOffline).not.toHaveBeenCalled();

		syncThisConnection();
		await flushMacrotasks();
		expect(done).toBe(true);
		expect(goOffline).toHaveBeenCalledTimes(1);
	});
});
