/**
 * Two background pulls of one closed note: the poller aborts pull A at its
 * deadline and starts pull B, which reuses the connection A opened. A's late
 * release must leave that connection to B, and B closes it when done.
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

async function flushMacrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A note whose connection opens when `openSocket()` is called and stays up
 * until goOffline(). With `separateFirstConnect`, the first bringOnline()
 * waits for `openFirstSocket()` instead.
 */
function makeDoc({ separateFirstConnect = false } = {}) {
	let online = false;
	let intent: "connected" | "disconnected" = "disconnected";
	let openSocket: () => void = () => {};
	let openFirstSocket: () => void = () => {};
	const opened = new Promise<void>((resolve) => (openSocket = resolve));
	const firstOpened = new Promise<void>((resolve) => (openFirstSocket = resolve));
	let connects = 0;
	const goOffline = jest.fn(() => {
		online = false;
		intent = "disconnected";
	});
	const doc = Object.create(Document.prototype) as Document;
	const share = {
		path: "Notes",
		isOnline: true,
		absolutePath: (p: string) => `Notes/${p}`,
		readContents: async () => "same",
		writeContents: async () => {},
		folderIndex: { tracks: () => true },
		credentialCache: { dropFromQueue: () => {} },
	};
	Object.defineProperty(doc, "entryPath", { value: "note.md" });
	Object.defineProperty(doc, "entityGuid", { value: "note-guid" });
	Object.defineProperty(doc, "editLock", { value: false });
	Object.defineProperty(doc, "resourceAddress", { value: {} });
	Object.defineProperty(doc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(doc, "content", { get: () => "same" });
	Object.defineProperty(doc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(doc, "connectionIntent", { get: () => intent });
	Object.defineProperty(doc, "bringOnline", {
		value: async () => {
			intent = "connected";
			await (separateFirstConnect && connects++ === 0 ? firstOpened : opened);
			online = true;
			return true;
		},
	});
	// Both resolve only on a live connection; the pull's timeout race ends them otherwise.
	const whileOnline = () => (online ? Promise.resolve() : new Promise<void>(() => {}));
	Object.defineProperty(doc, "onceOnline", { value: whileOnline });
	Object.defineProperty(doc, "onceFreshlySynced", { value: whileOnline });
	Object.defineProperty(doc, "goOffline", { value: goOffline });
	Object.defineProperty(doc, "getSyncBase", { value: async () => "same" });
	Object.defineProperty(doc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(doc, "vaultShare", { value: share });
	return { doc, goOffline, openSocket, openFirstSocket, isOnline: () => online };
}

describe("pull connection ownership", () => {
	test("an aborted pull's late release leaves the connection to the newer pull of the note", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never, 3);
		const { doc, goOffline, openSocket, isOnline } = makeDoc();

		const deadline = new AbortController();
		const pullA = queue.pullIfUnchanged(doc, { signal: deadline.signal });
		await flushMacrotasks();
		deadline.abort();

		const pullB = queue.pullIfUnchanged(doc);
		await flushMacrotasks();

		openSocket();
		const resultA = await pullA;
		const closedByA = goOffline.mock.calls.length;
		const resultB = await pullB;
		expect(resultA.outcome).toBe("aborted");
		expect(resultB.outcome).toBe("unchanged");
		expect(closedByA).toBe(0);
		// B closes the connection it took over.
		expect(goOffline).toHaveBeenCalledTimes(1);
		expect(isOnline()).toBe(false);
	});

	test("an aborted pull ending after the newer pull closes the connection nobody holds any more", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never, 3);
		const { doc, goOffline, openSocket, openFirstSocket, isOnline } = makeDoc({ separateFirstConnect: true });

		const deadline = new AbortController();
		const pullA = queue.pullIfUnchanged(doc, { signal: deadline.signal });
		await flushMacrotasks();
		deadline.abort();
		const pullB = queue.pullIfUnchanged(doc);
		await flushMacrotasks();

		openSocket();
		expect((await pullB).outcome).toBe("unchanged");
		expect(goOffline).toHaveBeenCalledTimes(1);

		// A's connect lands late: the socket it brings up is nobody's now.
		openFirstSocket();
		expect((await pullA).outcome).toBe("aborted");
		expect(goOffline).toHaveBeenCalledTimes(2);
		expect(isOnline()).toBe(false);

		// No hold is left behind: a third pull opens and closes its own connection.
		expect((await queue.pullIfUnchanged(doc)).outcome).toBe("unchanged");
		expect(goOffline).toHaveBeenCalledTimes(3);
	});

	test("an aborted pull nobody took over still closes its connection", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never, 3);
		const { doc, goOffline, openSocket, isOnline } = makeDoc();

		const deadline = new AbortController();
		const pullA = queue.pullIfUnchanged(doc, { signal: deadline.signal });
		await flushMacrotasks();
		deadline.abort();
		openSocket();
		expect((await pullA).outcome).toBe("aborted");
		expect(goOffline).toHaveBeenCalledTimes(1);
		expect(isOnline()).toBe(false);
	});
});
