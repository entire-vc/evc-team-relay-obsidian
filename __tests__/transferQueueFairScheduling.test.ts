/**
 * Unit tests: TransferQueue lane scheduling across shares
 *
 * Live, after a restart, the download lane held ~50 documents of one large
 * share; each took up to 30s of a slot, and a single note of a small QA share
 * stayed queued behind all of them for minutes (path-sorted global FIFO).
 * The lanes now serve shares round-robin, run priority items (a note someone
 * is waiting on) first, and keep one extra slot that only priority items may
 * use.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import type { VaultShare } from "../src/VaultShare";

class ManualClock implements Clock {
	time = 1_000;
	now(): number {
		return this.time;
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

async function flushMacrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function makeShare(path: string): VaultShare {
	return { path, isOnline: true, absolutePath: (vpath: string) => `${path}/${vpath}` } as unknown as VaultShare;
}

function makeDoc(share: VaultShare, name: string): Document {
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "entryPath", { value: name });
	Object.defineProperty(doc, "entityGuid", { value: `${share.path}:${name}` });
	Object.defineProperty(doc, "vaultShare", { value: share });
	return doc;
}

describe("TransferQueue — fair, priority-aware lanes", () => {
	let clock: ManualClock;
	let queue: TransferQueue;
	let started: string[];
	let finish: Map<string, () => void>;

	beforeEach(() => {
		clock = new ManualClock();
		queue = new TransferQueue({} as never, clock, {} as never, 3);
		started = [];
		finish = new Map();
		jest.spyOn(queue, "uploadDocumentViaSocket").mockImplementation((doc) => {
			started.push(doc.entityGuid);
			return new Promise<boolean>((resolve) => finish.set(doc.entityGuid, () => resolve(true)));
		});
		queue.wake();
	});

	test("a small share's note is not starved by a large share's backlog", async () => {
		const big = makeShare("Big");
		const small = makeShare("Small");
		for (let i = 0; i < 20; i++) void queue.enqueueUpload(makeDoc(big, `doc-${String(i).padStart(2, "0")}.md`));
		clock.time += 10;
		void queue.enqueueUpload(makeDoc(small, "note.md"));
		await flushMacrotasks();

		// The first three slots went to Big (it was alone when they were
		// taken); the next free slot goes to Small, not to Big's backlog.
		expect(started).toEqual(["Big:doc-00.md", "Big:doc-01.md", "Big:doc-02.md"]);
		finish.get("Big:doc-00.md")?.();
		await flushMacrotasks();
		expect(started[3]).toBe("Small:note.md");
	});

	test("shares alternate when both have a backlog", async () => {
		const a = makeShare("A");
		const b = makeShare("B");
		for (let i = 0; i < 4; i++) {
			void queue.enqueueUpload(makeDoc(a, `a${i}.md`));
		}
		// Hold the lane so B's items are queued before anything is picked.
		queue.suspend();
		for (let i = 0; i < 4; i++) void queue.enqueueUpload(makeDoc(b, `b${i}.md`));
		queue.wake();
		await flushMacrotasks();
		for (let round = 0; round < 3; round++) {
			for (const guid of [...finish.keys()]) {
				const done = finish.get(guid);
				finish.delete(guid);
				done?.();
			}
			await flushMacrotasks();
		}
		const order = started.map((guid) => guid.split(":")[0]).join("");
		// After A's head start, the lane interleaves B and A instead of
		// draining A first.
		expect(order.slice(0, 3)).toBe("AAA");
		expect(order.slice(3)).toMatch(/^B.*A.*B/);
	});

	test("a priority item takes the reserved slot while every regular slot is busy", async () => {
		const big = makeShare("Big");
		const small = makeShare("Small");
		for (let i = 0; i < 10; i++) void queue.enqueueUpload(makeDoc(big, `doc-${i}.md`));
		await flushMacrotasks();
		expect(started).toHaveLength(3);

		void queue.enqueueUpload(makeDoc(small, "edited.md"), { priority: true });
		await flushMacrotasks();
		expect(started).toHaveLength(4);
		expect(started[3]).toBe("Small:edited.md");

		// The reserved slot is for priority work only: bulk items still wait.
		void queue.enqueueUpload(makeDoc(small, "bulk.md"));
		await flushMacrotasks();
		expect(started).toHaveLength(4);
	});

	test("priority items run before bulk ones of the same share", async () => {
		const share = makeShare("S");
		queue.suspend();
		for (let i = 0; i < 6; i++) void queue.enqueueUpload(makeDoc(share, `bulk${i}.md`));
		void queue.enqueueUpload(makeDoc(share, "urgent.md"), { priority: true });
		queue.wake();
		await flushMacrotasks();
		expect(started[0]).toBe("S:urgent.md");
	});

	test("re-enqueueing a queued bulk item as priority promotes it", async () => {
		const share = makeShare("S");
		for (let i = 0; i < 6; i++) void queue.enqueueUpload(makeDoc(share, `bulk${i}.md`));
		await flushMacrotasks();
		expect(started).toHaveLength(3);
		void queue.enqueueUpload(makeDoc(share, "bulk5.md"), { priority: true });
		await flushMacrotasks();
		expect(started[3]).toBe("S:bulk5.md");
	});

	test("priorityFetches() counts one share's queued and running priority fetches", async () => {
		const a = makeShare("A");
		const b = makeShare("B");
		jest.spyOn(queue as unknown as { fetchDocument: (doc: Document) => Promise<void> }, "fetchDocument").mockImplementation(
			() => new Promise<void>(() => {}),
		);
		for (let i = 0; i < 6; i++) void queue.enqueueFetch(makeDoc(a, `a${i}.md`), { priority: i < 5 });
		void queue.enqueueFetch(makeDoc(b, "b.md"));
		await flushMacrotasks();
		expect(queue.priorityFetches(a)).toBe(5);
		expect(queue.priorityFetches(b)).toBe(0);
	});

	test("laneStats() reports queue per share, priority backlog, active count and oldest wait", async () => {
		const a = makeShare("A");
		const b = makeShare("B");
		for (let i = 0; i < 5; i++) void queue.enqueueUpload(makeDoc(a, `a${i}.md`));
		clock.time += 500;
		void queue.enqueueUpload(makeDoc(b, "b.md"));
		await flushMacrotasks();
		clock.time += 1_000;
		const stats = queue.laneStats().uploads;
		expect(stats.active).toBe(3);
		expect(stats.queuedByShare).toEqual({ A: 2, B: 1 });
		expect(stats.priorityQueued).toBe(0);
		expect(stats.oldestWaitMs).toBe(1_500);
	});
});
