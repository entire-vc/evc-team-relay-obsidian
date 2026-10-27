/**
 * A background pull and an upload of a local edit on the same closed note:
 * whichever finishes last closes the connection, so the pull never cuts off
 * an upload that is still on its connection.
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

function makeDoc() {
	const goOffline = jest.fn();
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
	Object.defineProperty(doc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(doc, "bringOnline", { value: async () => true });
	Object.defineProperty(doc, "onceOnline", { value: async () => {} });
	Object.defineProperty(doc, "goOffline", { value: goOffline });
	Object.defineProperty(doc, "getSyncBase", { value: async () => "same" });
	Object.defineProperty(doc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(doc, "vaultShare", { value: share });
	return { doc, goOffline };
}

describe("pull and upload on one connection", () => {
	test("a pull leaves the connection to an upload still running on it, which then closes it", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never, 3);
		let finishUpload: () => void = () => {};
		jest.spyOn(queue, "uploadDocumentViaSocket").mockImplementation(
			() => new Promise<boolean>((resolve) => (finishUpload = () => resolve(true))),
		);
		queue.wake();
		const { doc, goOffline } = makeDoc();
		void queue.enqueueUpload(doc, { priority: true });
		await flushMacrotasks();

		const result = await queue.pullIfUnchanged(doc);
		expect(result.outcome).toBe("unchanged");
		expect(goOffline).not.toHaveBeenCalled();

		finishUpload();
		await flushMacrotasks();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("with no upload on it, a pull closes its own connection", async () => {
		const queue = new TransferQueue({} as never, new InstantClock(), {} as never, 3);
		const { doc, goOffline } = makeDoc();
		await queue.pullIfUnchanged(doc);
		expect(goOffline).toHaveBeenCalledTimes(1);
	});
});
