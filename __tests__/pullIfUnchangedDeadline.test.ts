/**
 * Unit tests: pullIfUnchanged() under an aborted deadline
 *
 * CrdtBackgroundSyncPoller frees a pull's slot at PULL_DEADLINE_MS and aborts
 * it. Whatever the pull was awaiting may still resolve later; when it does,
 * the pull must write nothing and must drop any connection it opened.
 * Also covers the early returns that used to leave a background-opened
 * connection (or its scheduled retry) behind: a failed connect and a doc
 * with no recorded sync base.
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
	scheduleInterval(callback: () => void): number {
		setImmediate(callback);
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
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

interface FakeDocOptions {
	awaitFirstSync?: () => Promise<void>;
	bringOnline?: () => Promise<boolean>;
	syncBase?: string;
	vaultContents?: string;
	fileExists?: boolean;
	deletePending?: boolean;
}

function makeFakeDoc(opts: FakeDocOptions = {}) {
	const goOffline = jest.fn();
	const writeContents = jest.fn<(doc: unknown, content: string) => Promise<void>>(async () => {});
	const writeConflictCopy = jest.fn<(...args: unknown[]) => Promise<void>>(async () => {});
	const setSyncBase = jest.fn<(text: string) => Promise<void>>(async () => {});
	const ensureParentDir = jest.fn<(vpath: string) => Promise<void>>(async () => {});
	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: opts.awaitFirstSync ?? (async () => {}) });
	Object.defineProperty(fakeDoc, "content", { get: () => "relay content EDITED BY PEER" });
	Object.defineProperty(fakeDoc, "crdtDoc", { value: new Y.Doc() });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: opts.bringOnline ?? (async () => true) });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", { value: goOffline });
	Object.defineProperty(fakeDoc, "getSyncBase", {
		value: async () => ("syncBase" in opts ? opts.syncBase : "shared content"),
	});
	Object.defineProperty(fakeDoc, "setSyncBase", { value: setSyncBase });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			readContents: async () => opts.vaultContents ?? "shared content",
			hasFile: async () => opts.fileExists ?? true,
			isDeletePending: () => opts.deletePending ?? false,
			ensureParentDir,
			writeConflictCopy,
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { fakeDoc, goOffline, writeContents, writeConflictCopy, setSyncBase, ensureParentDir };
}

function makeQueue(): TransferQueue {
	return new TransferQueue({} as never, new InstantClock(), {} as never);
}

describe("pullIfUnchanged — deadline abort and connection release", () => {
	test("aborted while awaitFirstSync() hangs: when it finally resolves, nothing is connected or written", async () => {
		let releaseFirstSync!: () => void;
		const bringOnline = jest.fn(async () => true);
		const { fakeDoc, goOffline, writeContents } = makeFakeDoc({
			awaitFirstSync: () => new Promise<void>((resolve) => (releaseFirstSync = resolve)),
			bringOnline,
		});
		const controller = new AbortController();
		const phases: string[] = [];
		const pull = makeQueue().pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await flushMacrotasks();
		expect(phases).toEqual(["read-vault", "first-sync"]);

		controller.abort();
		releaseFirstSync();
		await expect(pull).resolves.toEqual({ outcome: "aborted" });
		expect(bringOnline).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
		expect(goOffline).not.toHaveBeenCalled();
	});

	test("aborted while bringOnline() hangs: a late successful connect is dropped again", async () => {
		let finishConnect!: (ok: boolean) => void;
		const { fakeDoc, goOffline, writeContents } = makeFakeDoc({
			bringOnline: () => new Promise<boolean>((resolve) => (finishConnect = resolve)),
		});
		const controller = new AbortController();
		const pull = makeQueue().pullIfUnchanged(fakeDoc, { signal: controller.signal });
		await flushMacrotasks();

		controller.abort();
		finishConnect(true);
		await expect(pull).resolves.toEqual({ outcome: "aborted" });
		expect(goOffline).toHaveBeenCalledTimes(1);
		expect(writeContents).not.toHaveBeenCalled();
	});

	test("aborted during the sync grace window: no write, connection dropped", async () => {
		const { fakeDoc, goOffline, writeContents, writeConflictCopy } = makeFakeDoc();
		const controller = new AbortController();
		const pull = makeQueue().pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			onPhase: (phase) => {
				if (phase === "grace") controller.abort();
			},
		});
		await expect(pull).resolves.toEqual({ outcome: "aborted" });
		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("aborted while the conflict-copy write is pending: the vault file is not overwritten", async () => {
		const { fakeDoc, goOffline, writeContents, writeConflictCopy } = makeFakeDoc({
			// The vault ("shared content") differs from this base: a genuine
			// unsynced local edit, so a conflict copy is written first.
			syncBase: "older agreed content",
		});
		const controller = new AbortController();
		let finishCopy!: () => void;
		writeConflictCopy.mockImplementation(() => new Promise<void>((resolve) => (finishCopy = resolve)));
		const pull = makeQueue().pullIfUnchanged(fakeDoc, { signal: controller.signal });
		await flushMacrotasks();
		expect(writeConflictCopy).toHaveBeenCalledTimes(1);

		controller.abort();
		finishCopy();
		await expect(pull).resolves.toEqual({ outcome: "aborted" });
		expect(writeContents).not.toHaveBeenCalled();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("past the point of no return: a write already handed to the vault completes WITH its sync-base update", async () => {
		// Stopping between writeContents() and setSyncBase() would leave the
		// disk holding relay text the base doesn't know about -- the next
		// pull would then write a spurious conflict copy.
		const { fakeDoc, writeContents, setSyncBase } = makeFakeDoc();
		const controller = new AbortController();
		let finishWrite!: () => void;
		writeContents.mockImplementation(() => new Promise<void>((resolve) => (finishWrite = resolve)));
		const phases: string[] = [];
		const pull = makeQueue().pullIfUnchanged(fakeDoc, {
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await flushMacrotasks();
		expect(phases[phases.length - 1]).toBe("write");
		expect(writeContents).toHaveBeenCalledTimes(1);

		controller.abort(); // e.g. plugin unload mid-write
		finishWrite();
		await expect(pull).resolves.toEqual({ outcome: "flushed", remoteText: "relay content EDITED BY PEER" });
		expect(setSyncBase).toHaveBeenCalledWith("relay content EDITED BY PEER");
		expect(writeContents).toHaveBeenCalledTimes(1);
	});

	test("a failed connect releases the doc (cancelling bringOnline()'s scheduled retry)", async () => {
		const { fakeDoc, goOffline } = makeFakeDoc({ bringOnline: async () => false });
		await expect(makeQueue().pullIfUnchanged(fakeDoc)).resolves.toEqual({ outcome: "connect-failed" });
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("no recorded sync base: skips the write AND drops the connection it opened", async () => {
		const { fakeDoc, goOffline, writeContents } = makeFakeDoc({ syncBase: undefined });
		await expect(makeQueue().pullIfUnchanged(fakeDoc)).resolves.toEqual({
			outcome: "no-base",
			remoteText: "relay content EDITED BY PEER",
		});
		expect(writeContents).not.toHaveBeenCalled();
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("no base and no file on disk: a peer's new note is written, with its base", async () => {
		const { fakeDoc, goOffline, writeContents, setSyncBase, ensureParentDir } = makeFakeDoc({
			syncBase: undefined,
			vaultContents: "",
			fileExists: false,
		});
		await expect(makeQueue().pullIfUnchanged(fakeDoc)).resolves.toEqual({
			outcome: "flushed",
			remoteText: "relay content EDITED BY PEER",
		});
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "relay content EDITED BY PEER");
		expect(setSyncBase).toHaveBeenCalledWith("relay content EDITED BY PEER");
		expect(ensureParentDir).toHaveBeenCalledWith("note.md");
		expect(goOffline).toHaveBeenCalledTimes(1);
	});

	test("no base, no file, but its folder is being deleted: nothing is recreated", async () => {
		const { fakeDoc, writeContents, ensureParentDir } = makeFakeDoc({
			syncBase: undefined,
			vaultContents: "",
			fileExists: false,
			deletePending: true,
		});
		await expect(makeQueue().pullIfUnchanged(fakeDoc)).resolves.toEqual({
			outcome: "unchanged",
			remoteText: "relay content EDITED BY PEER",
		});
		expect(ensureParentDir).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
	});

	test("no base and an EMPTY file that does exist: still left alone", async () => {
		const { fakeDoc, writeContents } = makeFakeDoc({ syncBase: undefined, vaultContents: "", fileExists: true });
		await expect(makeQueue().pullIfUnchanged(fakeDoc)).resolves.toEqual({
			outcome: "no-base",
			remoteText: "relay content EDITED BY PEER",
		});
		expect(writeContents).not.toHaveBeenCalled();
	});

	test("not aborted: flushes and reports the relay text it wrote", async () => {
		const { fakeDoc, goOffline, writeContents } = makeFakeDoc();
		await expect(makeQueue().pullIfUnchanged(fakeDoc, { signal: new AbortController().signal })).resolves.toEqual({
			outcome: "flushed",
			remoteText: "relay content EDITED BY PEER",
		});
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "relay content EDITED BY PEER");
		expect(goOffline).toHaveBeenCalledTimes(1);
	});
});
