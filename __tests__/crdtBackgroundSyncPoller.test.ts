/**
 * Unit tests: CrdtBackgroundSyncPoller
 *
 * Covers:
 *   (a) calls pullIfUnchanged() for an unopened Document in a connected,
 *       relay-linked folder
 *   (b) skips folders that aren't relay-linked (no workspaceId)
 *   (c) skips folders that aren't connected
 *   (d) skips files that are already live-connected (open in an editor --
 *       they get updates for free via their own connection)
 *   (e) skips non-Document files (isDocument() false)
 *   (f) start() polls immediately, then on every interval; is idempotent
 *   (g) destroy() stops further polling, including a poll already in flight
 *       from start()'s immediate check
 *   (h) does not re-fire for a document whose previous pullIfUnchanged()
 *       call hasn't resolved yet; fires again once it has
 *   (i) caps concurrent in-flight pullIfUnchanged() calls at
 *       transfers.laneLimit -- MUST fail on
 *       unbounded-concurrency code (origin/main@738dd72)
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

// ─── Mock isDocument so tests don't need a real Document/Y.Doc instance ───────
const mockIsDocument = jest.fn<(file?: { __isDocument?: boolean }) => boolean>();
jest.mock("src/Document", () => ({
	isDocument: (file?: { __isDocument?: boolean }) => mockIsDocument(file),
}));

// ─── Mock debug logging (no-op) ───────────────────────────────────────────────
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import { MockClock } from "./mocks/MockClock";
import { CrdtBackgroundSyncPoller, PULL_DEADLINE_MS } from "src/CrdtBackgroundSyncPoller";
import type { Document } from "src/Document";
import type { VaultShare } from "src/VaultShare";

/** Flush all pending microtasks. */
const flushPromises = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

// `isOnline`/`entityGuid`/`workspaceId` below are `Pick<>`'d off the real
// production types rather than declared as this mock's own free-standing
// fields. This file
// shipped exactly that shape of bug twice in one evening: FakeFolder.connected
// (MR !228, real field renamed to isOnline) and FakeFile.guid (MR !235, real
// field renamed to entityGuid) both went stale silently -- __tests__ was
// entirely outside tsc's `include` at the time, so a hand-rolled interface
// with its own spelling for a renamed member compiled clean regardless of
// what the real type was called. scripts/check-tests-types.sh (CI job
// `tests-typecheck`) now closes that gap generally, but this `Pick<>` is
// what actually gives a rename teeth: without it, the interface would still
// be internally self-consistent and tsc would have nothing to object to.
// Referencing the real type via `Pick<>` means a future rename of
// `isOnline`/`entityGuid`/`workspaceId` breaks the `Pick<>` reference itself
// -- a compile error named at this declaration -- rather than silently
// reading `undefined` at runtime.
// This does NOT extend to `path`/`__isDocument` below: neither is a real
// member CrdtBackgroundSyncPoller reads off `Document` (the real field is
// `entryPath`, via the `SyncableEntry` interface) -- they are this test's own
// bookkeeping, not a mirror of a production field, so there's nothing to pin
// them to.
interface FakeFile extends Pick<Document, "isOnline" | "entityGuid"> {
	__isDocument?: boolean;
	path: string;
}

interface FakeFolder extends Pick<VaultShare, "workspaceId" | "isOnline"> {
	trackedEntries: Map<string, FakeFile>;
	transfers: { pullIfUnchanged: jest.Mock; laneLimit: number };
}

function makeFile(overrides: Partial<FakeFile> = {}): FakeFile {
	return {
		__isDocument: true,
		isOnline: false,
		path: "note.md",
		entityGuid: "guid-1",
		...overrides,
	};
}

/** Matches TransferQueue's own default (src/TransferQueue.ts) -- the cap this poller reuses. */
const DEFAULT_TRANSFER_QUEUE_CONCURRENCY = 3;

function makeFolder(overrides: Partial<FakeFolder> = {}): FakeFolder {
	return {
		workspaceId: "relay-1",
		isOnline: true,
		trackedEntries: new Map(),
		transfers: {
			pullIfUnchanged: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
			laneLimit: DEFAULT_TRANSFER_QUEUE_CONCURRENCY,
		},
		...overrides,
	};
}

/** A minimal stand-in for ShareRegistry: just needs `.each`. */
function makeRegistry(folders: FakeFolder[]) {
	return { each: (cb: (f: FakeFolder) => void) => folders.forEach(cb) };
}

describe("CrdtBackgroundSyncPoller", () => {
	let timeProvider: MockClock;
	let startTime: number;

	beforeEach(() => {
		jest.clearAllMocks();
		mockIsDocument.mockImplementation((file) => !!file?.__isDocument);
		timeProvider = new MockClock();
		startTime = timeProvider.now();
	});

	test("calls pullIfUnchanged for an unopened Document in a connected relay-linked folder", async () => {
		const file = makeFile({ isOnline: false, path: "note.md" });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledWith(file, expect.anything());
	});

	test("start() checks immediately, without waiting for the first interval", () => {
		const file = makeFile({ isOnline: false, path: "note.md" });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledWith(file, expect.anything());
	});

	test("skips a folder with no workspaceId (not relay-linked)", async () => {
		const file = makeFile({ isOnline: false });
		const folder = makeFolder({ workspaceId: undefined });
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).not.toHaveBeenCalled();
	});

	test("skips a folder that isn't connected", async () => {
		const file = makeFile({ isOnline: false });
		const folder = makeFolder({ isOnline: false });
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).not.toHaveBeenCalled();
	});

	test("skips a file that is already live-connected (open in an editor)", async () => {
		const file = makeFile({ isOnline: true });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).not.toHaveBeenCalled();
	});

	test("does not re-fire while a previous pullIfUnchanged() call is still pending, but does once it resolves", async () => {
		let resolvePull: () => void = () => undefined;
		const pending = new Promise<void>((resolve) => {
			resolvePull = resolve;
		});
		const file = makeFile({ isOnline: false, entityGuid: "guid-slow" });
		const folder = makeFolder();
		folder.transfers.pullIfUnchanged.mockReturnValueOnce(pending);
		folder.trackedEntries.set("guid-slow", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			20_000,
			PULL_DEADLINE_MS,
			0, // back-to-back sweep passes: this test is about per-tick re-checks
		);
		poller.start(); // immediate poll starts the still-pending call
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(1);

		// Next tick fires while the first call is still unresolved (and still
		// inside its PULL_DEADLINE_MS) -- must be skipped.
		timeProvider.setTime(startTime + 20_000);
		await flushPromises();
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(1);

		// Resolve the slow call, then the following tick should fire again.
		resolvePull();
		await flushPromises();
		timeProvider.setTime(startTime + 40_000);
		await flushPromises();
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(2);
	});

	test("skips a non-Document file (e.g. an attachment)", async () => {
		mockIsDocument.mockReturnValue(false);
		const file = makeFile({ __isDocument: false, isOnline: false });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).not.toHaveBeenCalled();
	});

	test("checks every unopened Document across multiple connected folders", async () => {
		const fileA = makeFile({ isOnline: false, path: "a.md", entityGuid: "guid-a" });
		const folderA = makeFolder();
		folderA.trackedEntries.set("guid-a", fileA);

		const fileB = makeFile({ isOnline: false, path: "b.md", entityGuid: "guid-b" });
		const folderB = makeFolder({ workspaceId: "relay-2" });
		folderB.trackedEntries.set("guid-b", fileB);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folderA, folderB]) as any,
			30_000,
		);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folderA.transfers.pullIfUnchanged).toHaveBeenCalledWith(fileA, expect.anything());
		expect(folderB.transfers.pullIfUnchanged).toHaveBeenCalledWith(fileB, expect.anything());
	});

	test("start is idempotent (second call does not double-register the interval)", async () => {
		const file = makeFile({ isOnline: false });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
			PULL_DEADLINE_MS,
			0, // back-to-back sweep passes: this test is about per-tick re-checks
		);
		poller.start();
		await flushPromises();
		poller.start(); // second call should be a no-op — not a second immediate poll either
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(1);

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		// immediate (on start) + exactly one interval tick, not two
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(2);
	});

	test("destroy clears the interval so no further polls occur", async () => {
		const file = makeFile({ isOnline: false });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start();
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(1); // the immediate poll
		await flushPromises();
		folder.transfers.pullIfUnchanged.mockClear();
		poller.destroy();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(folder.transfers.pullIfUnchanged).not.toHaveBeenCalled();
	});

	test("re-checks on every tick, not just once", async () => {
		const file = makeFile({ isOnline: false });
		const folder = makeFolder();
		folder.trackedEntries.set("guid-1", file);

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
			PULL_DEADLINE_MS,
			0, // back-to-back sweep passes: this test is about per-tick re-checks
		);
		poller.start(); // immediate poll: 1 call
		await flushPromises();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();
		timeProvider.setTime(startTime + 60_000);
		await flushPromises();

		// immediate + 2 interval ticks = 3
		expect(folder.transfers.pullIfUnchanged).toHaveBeenCalledTimes(3);
	});

	test("caps concurrent in-flight pullIfUnchanged() calls at transfers.laneLimit", async () => {
		const CAP = 3;
		const DOC_COUNT = 10; // significantly more than CAP

		let active = 0;
		let maxActive = 0;
		const resolvers: Array<() => void> = [];
		const pullIfUnchanged = jest
			.fn<() => Promise<void>>()
			.mockImplementation(() => {
				active++;
				maxActive = Math.max(maxActive, active);
				return new Promise<void>((resolve) => {
					resolvers.push(() => {
						active--;
						resolve();
					});
				});
			});

		const folder = makeFolder({
			transfers: { pullIfUnchanged, laneLimit: CAP },
		});
		for (let i = 0; i < DOC_COUNT; i++) {
			const guid = `guid-${i}`;
			folder.trackedEntries.set(guid, makeFile({ entityGuid: guid, path: `${i}.md` }));
		}

		const poller = new CrdtBackgroundSyncPoller(
			timeProvider as any,
			makeRegistry([folder]) as any,
			30_000,
		);
		poller.start(); // immediate poll -- must not exceed the cap right away

		expect(pullIfUnchanged).toHaveBeenCalledTimes(CAP);
		expect(active).toBe(CAP);
		expect(maxActive).toBeLessThanOrEqual(CAP);

		// Resolve in-flight calls one at a time; each freed slot should pick
		// up exactly one more queued document, never exceeding the cap.
		for (let resolved = 1; resolved <= DOC_COUNT; resolved++) {
			const next = resolvers.shift();
			expect(next).toBeDefined();
			next?.();
			await flushPromises();

			const remaining = DOC_COUNT - resolved;
			const expectedActive = Math.min(CAP, remaining);
			expect(active).toBe(expectedActive);
			expect(maxActive).toBeLessThanOrEqual(CAP);
		}

		expect(pullIfUnchanged).toHaveBeenCalledTimes(DOC_COUNT);
		expect(active).toBe(0);
	});
});
