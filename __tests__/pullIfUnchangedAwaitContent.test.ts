/**
 * Unit tests: an announced pull waits connected for its content, and the
 * relay probe
 *
 * Measured on 0.1.15: an announcement's marker often reached the other
 * client before its text did, and each re-check paid a fresh connect (15-19s
 * under load). Given the announced fingerprint, pullIfUnchanged() now stays
 * connected after the grace window until the text matches (or its wait runs
 * out), on one connect.
 *
 * Measured on 0.1.24 under an 800-note bulk load: three edits still waited
 * 20-38s connected for text the relay already had. A pull that owns its
 * connection now reconnects when the text is still missing after a few
 * seconds.
 *
 * probeRelay() times connect and first sync of one closed document, so a
 * load test can tell relay latency from client scheduling.
 */

import * as Y from "yjs";
import { describe, test, expect, jest } from "@jest/globals";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { textFingerprint } from "../src/docActivity";

/** Fake time: timers fire in due order, and only when `settle()` runs out of other work. */
class SteppingClock implements Clock {
	time = 1_000_000;
	private timers: { due: number; callback: () => void }[] = [];
	now(): number {
		return this.time;
	}
	scheduleTimeout(callback: () => void, ms = 0): number {
		this.timers.push({ due: this.time + ms, callback });
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
	/** Runs `promise` to completion, firing the earliest timer whenever nothing else is pending. */
	async settle<T>(promise: Promise<T>): Promise<T> {
		let done = false;
		const mark = () => (done = true);
		promise.then(mark, mark);
		for (let i = 0; i < 10_000; i++) {
			await flushMacrotasks(3);
			if (done) return promise;
			this.timers.sort((a, b) => a.due - b.due);
			const next = this.timers.shift();
			if (!next) break;
			this.time = Math.max(this.time, next.due);
			next.callback();
		}
		return promise;
	}
}

async function flushMacrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function makeFakeDoc(
	opts: { bringOnline?: () => Promise<boolean>; onceFreshlySynced?: () => Promise<void>; editLock?: boolean } = {},
) {
	let content = "shared content";
	const goOffline = jest.fn();
	const bringOnline = jest.fn(opts.bringOnline ?? (async () => true));
	const writeContents = jest.fn<(doc: unknown, content: string) => Promise<void>>(async () => {});
	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: opts.editLock ?? false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => content });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: bringOnline });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "onceFreshlySynced", { value: opts.onceFreshlySynced ?? (async () => {}) });
	Object.defineProperty(fakeDoc, "goOffline", { value: goOffline });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => "shared content" });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: async () => {} });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			readContents: async () => "shared content",
			hasFile: async () => true,
			isDeletePending: () => false,
			ensureParentDir: async () => {},
			writeConflictCopy: async () => {},
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return {
		fakeDoc,
		goOffline,
		bringOnline,
		writeContents,
		setContent: (text: string) => (content = text),
	};
}

function makeQueue(clock: Clock): TransferQueue {
	return new TransferQueue({} as never, clock, {} as never);
}

describe("pullIfUnchanged — waiting connected for announced content", () => {
	test("text that lands after the grace window is pulled on the same connection", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, bringOnline, writeContents, goOffline, setContent } = makeFakeDoc();
		const phases: string[] = [];
		let checks = 0;
		const pull = makeQueue(clock).pullIfUnchanged(fakeDoc, {
			expected: () => {
				// The relay pushes the edit a few checks into the wait.
				if (++checks === 4) setContent("edited by peer");
				return textFingerprint("edited by peer");
			},
			awaitContentMs: 60_000,
			onPhase: (phase) => phases.push(phase),
		});
		await clock.settle(pull);
		expect(phases).toContain("await-content");
		expect(bringOnline).toHaveBeenCalledTimes(1);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "edited by peer");
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("text that never lands: the wait ends at awaitContentMs and the connection is dropped", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, bringOnline, writeContents, goOffline } = makeFakeDoc();
		let waitStart = 0;
		const result = await clock.settle(
			makeQueue(clock).pullIfUnchanged(fakeDoc, {
				expected: () => textFingerprint("never"),
				awaitContentMs: 5_000,
				onPhase: (phase) => {
					if (phase === "await-content") waitStart = clock.now();
				},
			}),
		);
		expect(result.outcome).toBe("unchanged");
		expect(clock.now() - waitStart).toBeGreaterThanOrEqual(5_000);
		expect(clock.now() - waitStart).toBeLessThan(6_000);
		// A reconnect at 4s would leave under one interval of the wait: none.
		expect(bringOnline).toHaveBeenCalledTimes(1);
		expect(writeContents).not.toHaveBeenCalled();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("text the first connection never receives arrives on a reconnect, within seconds", async () => {
		const clock = new SteppingClock();
		let connects = 0;
		const doc = makeFakeDoc({
			bringOnline: async () => {
				// The relay only hands the edit to a second connection.
				if (++connects === 2) doc.setContent("edited by peer");
				return true;
			},
		});
		let waitStart = 0;
		const onReconnect = jest.fn();
		const result = await clock.settle(
			makeQueue(clock).pullIfUnchanged(doc.fakeDoc, {
				expected: () => textFingerprint("edited by peer"),
				awaitContentMs: 60_000,
				onReconnect,
				onPhase: (phase) => {
					if (phase === "await-content") waitStart = clock.now();
				},
			}),
		);
		expect(result.outcome).toBe("flushed");
		expect(doc.writeContents).toHaveBeenCalledWith(doc.fakeDoc, "edited by peer");
		expect(onReconnect).toHaveBeenCalledTimes(1);
		expect(clock.now() - waitStart).toBeLessThan(5_000);
		expect(doc.goOffline).toHaveBeenCalledTimes(2);
	});

	test("reconnects back off and stop short of the end of the wait", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, bringOnline } = makeFakeDoc();
		let waitStart = 0;
		const reconnectsAt: number[] = [];
		await clock.settle(
			makeQueue(clock).pullIfUnchanged(fakeDoc, {
				expected: () => textFingerprint("never"),
				awaitContentMs: 60_000,
				onReconnect: () => reconnectsAt.push(clock.now() - waitStart),
				onPhase: (phase) => {
					if (phase === "await-content") waitStart = clock.now();
				},
			}),
		);
		// 4s, then 8s and 16s later; the next would be due at 60s, when the wait ends.
		expect(reconnectsAt).toEqual([4_000, 12_000, 28_000]);
		expect(bringOnline).toHaveBeenCalledTimes(4);
	});

	test("a reconnect whose connect never settles is bounded: the wait goes on and the next reconnect lands the text", async () => {
		const clock = new SteppingClock();
		let connects = 0;
		const doc = makeFakeDoc({
			bringOnline: () => {
				connects++;
				// The first reconnect hangs for good; the one after it gets the edit.
				if (connects === 2) return new Promise<boolean>(() => {});
				if (connects === 3) doc.setContent("edited by peer");
				return Promise.resolve(true);
			},
		});
		const pull = makeQueue(clock).pullIfUnchanged(doc.fakeDoc, {
			expected: () => textFingerprint("edited by peer"),
			awaitContentMs: 60_000,
		});
		const stalled = Symbol("stalled");
		const result = await Promise.race([
			clock.settle(pull),
			flushMacrotasks(200).then(() => stalled),
		]);
		expect(result).not.toBe(stalled);
		expect(result).toMatchObject({ outcome: "flushed" });
		expect(doc.writeContents).toHaveBeenCalledWith(doc.fakeDoc, "edited by peer");
	});

	test("aborted during a reconnect: no write, connection dropped", async () => {
		const clock = new SteppingClock();
		const controller = new AbortController();
		let connects = 0;
		const doc = makeFakeDoc({
			bringOnline: async () => {
				if (++connects === 2) {
					doc.setContent("edited by peer");
					controller.abort();
				}
				return true;
			},
		});
		const result = await clock.settle(
			makeQueue(clock).pullIfUnchanged(doc.fakeDoc, {
				signal: controller.signal,
				expected: () => textFingerprint("edited by peer"),
				awaitContentMs: 60_000,
			}),
		);
		expect(result).toEqual({ outcome: "aborted" });
		expect(doc.writeContents).not.toHaveBeenCalled();
		// Once for the reconnect, once for the release.
		expect(doc.goOffline).toHaveBeenCalledTimes(2);
	});

	test("a connection an editor holds is never dropped to ask again", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, bringOnline } = makeFakeDoc({ editLock: true });
		const onReconnect = jest.fn();
		await clock.settle(
			makeQueue(clock).pullIfUnchanged(fakeDoc, {
				expected: () => textFingerprint("never"),
				awaitContentMs: 10_000,
				onReconnect,
			}),
		);
		expect(onReconnect).not.toHaveBeenCalled();
		expect(bringOnline).toHaveBeenCalledTimes(1);
	});

	test("aborted while waiting: no write, connection dropped", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, writeContents, goOffline } = makeFakeDoc();
		const controller = new AbortController();
		const pull = makeQueue(clock).pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			expected: () => textFingerprint("never"),
			awaitContentMs: 60_000,
			onPhase: (phase) => {
				if (phase === "await-content") setImmediate(() => controller.abort());
			},
		});
		await expect(clock.settle(pull)).resolves.toEqual({ outcome: "aborted" });
		expect(writeContents).not.toHaveBeenCalled();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("a sweep pull (no expected text) doesn't wait", async () => {
		const clock = new SteppingClock();
		const { fakeDoc } = makeFakeDoc();
		const phases: string[] = [];
		await clock.settle(makeQueue(clock).pullIfUnchanged(fakeDoc, { onPhase: (phase) => phases.push(phase) }));
		expect(phases).not.toContain("await-content");
	});
});

describe("probeRelay", () => {
	test("times connect and first sync, then disconnects", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, goOffline } = makeFakeDoc({
			onceFreshlySynced: () => new Promise<void>((resolve) => clock.scheduleTimeout(resolve, 700)),
		});
		const sample = await clock.settle(makeQueue(clock).probeRelay(fakeDoc));
		expect(sample).toMatchObject({ ok: true, connectMs: 0, syncMs: 700 });
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("a connect that throws still leaves the document disconnected", async () => {
		const clock = new SteppingClock();
		const { fakeDoc, goOffline } = makeFakeDoc({
			bringOnline: async () => {
				throw new Error("socket");
			},
		});
		await expect(clock.settle(makeQueue(clock).probeRelay(fakeDoc))).rejects.toThrow("socket");
		expect(goOffline).toHaveBeenCalled();
	});

	test("a connect slower than the timeout is a failed sample, and its late socket is dropped too", async () => {
		const clock = new SteppingClock();
		let finishConnect!: (ok: boolean) => void;
		const { fakeDoc, goOffline } = makeFakeDoc({
			bringOnline: () => new Promise<boolean>((resolve) => (finishConnect = resolve)),
		});
		const sample = await clock.settle(makeQueue(clock).probeRelay(fakeDoc));
		expect(sample?.ok).toBe(false);
		expect(goOffline).toHaveBeenCalledTimes(1);

		finishConnect(true);
		await flushMacrotasks();
		expect(goOffline).toHaveBeenCalledTimes(2);
	});
});
