/**
 * Unit tests: CrdtBackgroundSyncPoller scheduling
 *
 * Covers:
 *   (a) a pull stuck in a phase with no timeout of its own (first-sync,
 *       connect) frees its slot at PULL_DEADLINE_MS, is aborted, and the
 *       timeout is attributed to that phase; other work keeps going. A pull
 *       already in its final write phase is released but not aborted
 *   (b) free slots are handed out round-robin across shares, so a small
 *       share isn't stuck behind a large share's backlog
 *   (c) a document another client announced as changed starts before the
 *       sweep backlog
 *   (d) an announcement whose pulled text doesn't match yet is re-checked;
 *       a matching one records a delivery latency
 *   (e) a share's sweep is refilled only after its pass was handed out
 *   (f) destroy() aborts in-flight pulls and drops announcement listeners
 * Every case except (e) MUST fail on the global-FIFO, no-deadline poller
 * (origin/main@09f889d).
 *
 * Express slot:
 *   (g) an edit announced in one share starts at once while another share's
 *       bulk sync holds every regular slot
 *   (h) a share whose announced pull is already running can't take the
 *       express slot, so a bulk share's announced backlog doesn't hold it
 *   (i) one express pull at a time; regular slots stay at laneLimit
 * (g) and (h) MUST fail on the poller without the express slot
 * (origin/main@d7f58c8).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

const mockIsDocument = jest.fn<(file?: { __isDocument?: boolean }) => boolean>();
jest.mock("src/Document", () => ({
	isDocument: (file?: { __isDocument?: boolean }) => mockIsDocument(file),
}));
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import { MockClock } from "./mocks/MockClock";
import { CrdtBackgroundSyncPoller, PULL_DEADLINE_MS } from "src/CrdtBackgroundSyncPoller";
import { textFingerprint, type RemoteActivityListener } from "src/docActivity";
import type { Document } from "src/Document";
import type { PullControl, PullResult } from "src/TransferQueue";
import type { VaultShare } from "src/VaultShare";

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeFile extends Pick<Document, "isOnline" | "entityGuid" | "entryPath"> {
	__isDocument?: boolean;
}

type PullFn = (file: FakeFile, control: PullControl) => Promise<PullResult>;

interface FakeFolder extends Pick<VaultShare, "workspaceId" | "isOnline" | "path"> {
	trackedEntries: Map<string, FakeFile>;
	transfers: { pullIfUnchanged: jest.Mock<PullFn>; laneLimit: number };
	docActivity: { subscribeRemote: (listener: RemoteActivityListener) => () => void };
	announce: (guid: string, fingerprint: string) => void;
	listenerCount: () => number;
}

/** A pull that only settles when the test says so. */
interface Held {
	file: FakeFile;
	control: PullControl;
	resolve: (result: PullResult) => void;
}

function makeFolder(name: string, docCount: number, pull: jest.Mock<PullFn>, laneLimit = 3): FakeFolder {
	const listeners = new Set<RemoteActivityListener>();
	const trackedEntries = new Map<string, FakeFile>();
	for (let i = 0; i < docCount; i++) {
		const guid = `${name}-${i}`;
		trackedEntries.set(guid, {
			__isDocument: true,
			isOnline: false,
			entityGuid: guid,
			entryPath: `${name}/${i}.md`,
		});
	}
	return {
		workspaceId: "relay-1",
		isOnline: true,
		path: name,
		trackedEntries,
		transfers: { pullIfUnchanged: pull, laneLimit },
		docActivity: {
			subscribeRemote: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		announce: (guid, fingerprint) => listeners.forEach((l) => l(guid, fingerprint)),
		listenerCount: () => listeners.size,
	};
}

function holdingPull(held: Held[]): jest.Mock<PullFn> {
	return jest.fn<PullFn>().mockImplementation(
		(file, control) =>
			new Promise<PullResult>((resolve) => {
				held.push({ file, control, resolve });
			}),
	);
}

function makeRegistry(folders: FakeFolder[]) {
	return { each: (cb: (f: FakeFolder) => void) => folders.forEach(cb) };
}

function startedGuids(pull: jest.Mock<PullFn>): string[] {
	return pull.mock.calls.map(([file]) => file.entityGuid);
}

describe("CrdtBackgroundSyncPoller scheduling", () => {
	let clock: MockClock;
	let t0: number;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		mockIsDocument.mockImplementation((file) => !!file?.__isDocument);
		clock = new MockClock();
		t0 = clock.now();
	});

	test("a pull hung before the connect timeout frees its slot at the deadline, aborted, attributed to its phase", async () => {
		const held: Held[] = [];
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			if (file.entityGuid === "a-0") {
				// Hangs forever inside awaitFirstSync()/IndexedDB.
				control.onPhase?.("first-sync");
				return new Promise<PullResult>(() => undefined);
			}
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const folder = makeFolder("a", 3, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();

		expect(startedGuids(pull)).toEqual(["a-0"]);
		const hungSignal = pull.mock.calls[0][1].signal;
		expect(hungSignal?.aborted).toBe(false);

		clock.setTime(t0 + PULL_DEADLINE_MS - 1);
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0"]);

		clock.setTime(t0 + PULL_DEADLINE_MS);
		await flushPromises();
		expect(hungSignal?.aborted).toBe(true);
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);
		expect(poller.stats().timeouts).toEqual({ "first-sync": 1 });
		expect(poller.stats().inflight).toBe(1);

		// The healthy work behind it completes normally.
		held[0].resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1", "a-2"]);
		poller.destroy();
	});

	test("a deadline in the preserve phase aborts; in the write phase it frees the slot WITHOUT aborting and holds the doc until the write settles", async () => {
		const held: Held[] = [];
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			control.onPhase?.(file.entityGuid === "a-0" ? "write" : "preserve");
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const folder = makeFolder("a", 2, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);

		clock.setTime(t0 + PULL_DEADLINE_MS);
		// MockClock's checkTimers() iterates while callbacks cancel timers, so
		// two deadlines due at the same instant need a second pass.
		clock.setTime(t0 + PULL_DEADLINE_MS + 1);
		await flushPromises();
		const [writing, preserving] = held;
		expect(writing.control.signal?.aborted).toBe(false);
		expect(preserving.control.signal?.aborted).toBe(true);
		expect(poller.stats().inflight).toBe(0);
		expect(poller.stats().timeouts).toEqual({ write: 1, preserve: 1 });

		// Next tick: a-1 is pulled again, a-0 is held back while its write is pending.
		clock.setTime(t0 + 60_000);
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1", "a-1"]);

		// Once the write settles, a-0 is eligible again on the next pass.
		writing.resolve({ outcome: "flushed", remoteText: "x" });
		held[2].resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		clock.setTime(t0 + 120_000);
		await flushPromises();
		expect(startedGuids(pull).filter((g) => g === "a-0")).toHaveLength(2);
		poller.destroy();
	});

	test("slots go round-robin across shares: a small share is not stuck behind a large one", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const big = makeFolder("big", 50, pull, 1);
		const small = makeFolder("small", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([big, small]) as never, 60_000);
		poller.start();

		expect(startedGuids(pull)).toEqual(["big-0"]);
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		// Global FIFO would start big-1 here and reach small-0 only after all 50.
		expect(startedGuids(pull)).toEqual(["big-0", "small-0"]);
		poller.destroy();
	});

	test("an announced change starts before the sweep backlog", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 100, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		expect(pull).toHaveBeenCalledTimes(3);

		folder.announce("s-90", textFingerprint("new text"));
		await flushPromises();
		expect(startedGuids(pull)[3]).toBe("s-90"); // express slot

		// The share's announced pull now runs, so the next one waits for a
		// regular slot -- and still goes ahead of the sweep backlog.
		folder.announce("s-91", textFingerprint("more text"));
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(4);

		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)[4]).toBe("s-91");
		poller.destroy();
	});

	test("announced text not there yet is re-checked; once it matches, a delivery latency is recorded", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();

		folder.announce("s-0", textFingerprint("new"));
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(2);

		// Marker beat the content: the relay still says "old".
		clock.setTime(t0 + 500);
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		expect(poller.stats().delivery.count).toBe(0);

		clock.setTime(t0 + 2_500);
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(3);

		clock.setTime(t0 + 3_000);
		held.shift()?.resolve({ outcome: "flushed", remoteText: "new" });
		await flushPromises();
		expect(poller.stats().delivery).toEqual({ count: 1, p50Ms: 3_000, p95Ms: 3_000, maxMs: 3_000 });
		poller.destroy();
	});

	test("an announcement for a document already being pulled is checked against that pull's result", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();

		folder.announce("s-0", textFingerprint("new"));
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		clock.setTime(t0 + 2_000);
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(2);
		poller.destroy();
	});

	test("a share's sweep is refilled only once its previous pass has been handed out", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 5, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 10_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" }); // s-0 done
		await flushPromises();

		clock.setTime(t0 + 10_000); // tick while s-2..s-4 are still queued
		await flushPromises();
		expect(poller.stats().queued.s.sweep).toBe(2);
		expect(startedGuids(pull)).toEqual(["s-0", "s-1", "s-2"]);
		poller.destroy();
	});

	test("an edit announced in a small share starts at once while a bulk share holds every regular slot", async () => {
		const held: Held[] = [];
		// Bulk pulls hang in connect, as measured live under an 800+ document sync.
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			control.onPhase?.("connect");
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const bulk = makeFolder("bulk", 800, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		notes.trackedEntries.set("note", {
			__isDocument: true,
			isOnline: false,
			entityGuid: "note",
			entryPath: "notes/note.md",
		});
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, notes]) as never,
			60_000,
		);
		poller.start();
		// The regular slots go round-robin; drain the small share's sweep first.
		const notesSweep = held.findIndex((h) => h.file.entityGuid === "note");
		held.splice(notesSweep, 1)[0].resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		expect(startedGuids(pull).filter((g) => g.startsWith("bulk-"))).toHaveLength(3);

		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		// Without the express slot it waits up to PULL_DEADLINE_MS for a bulk pull.
		expect(startedGuids(pull).at(-1)).toBe("note");
		expect(poller.stats().express).toBe(1);
		expect(poller.stats().inflight).toBe(4);

		clock.setTime(t0 + 4_000);
		held.find((h) => h.file.entityGuid === "note")?.resolve({ outcome: "flushed", remoteText: "edited" });
		await flushPromises();
		expect(poller.stats().delivery).toEqual({ count: 1, p50Ms: 4_000, p95Ms: 4_000, maxMs: 4_000 });
		expect(poller.stats().express).toBe(0);
		poller.destroy();
	});

	test("a bulk share's announced backlog can't take the express slot; another share's edit can", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, notes]) as never,
			60_000,
		);
		poller.start();
		for (let i = 0; i < 100; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		notes.trackedEntries.set("note", {
			__isDocument: true,
			isOnline: false,
			entityGuid: "note",
			entryPath: "notes/note.md",
		});
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "bulk-1", "bulk-2"]);
		expect(poller.stats().express).toBe(0);

		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "bulk-1", "bulk-2", "note"]);
		expect(poller.stats().express).toBe(1);
		poller.destroy();
	});

	test("one express pull at a time; regular slots stay at laneLimit", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 50, pull, 2);
		const a = makeFolder("a", 1, pull, 2);
		const b = makeFolder("b", 1, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, a, b]) as never,
			60_000,
		);
		poller.start();
		// Two regular slots: bulk-0 and a-0. b-0 waits for the sweep.
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0"]);

		b.announce("b-0", textFingerprint("edit b"));
		bulk.announce("bulk-40", textFingerprint("edit bulk"));
		await flushPromises();
		// b-0 takes the express slot; bulk-40 waits for a regular one.
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0", "b-0"]);
		expect(poller.stats().inflight).toBe(3);

		held.find((h) => h.file.entityGuid === "a-0")?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0", "b-0", "bulk-40"]);
		expect(poller.stats().inflight).toBe(3);
		poller.destroy();
	});

	test("destroy() aborts in-flight pulls and drops announcement listeners", () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 2, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 10_000);
		poller.start();
		expect(folder.listenerCount()).toBe(1);

		poller.destroy();
		expect(held.map((h) => h.control.signal?.aborted)).toEqual([true, true]);
		expect(folder.listenerCount()).toBe(0);
		expect(poller.stats().inflight).toBe(0);
	});
});
