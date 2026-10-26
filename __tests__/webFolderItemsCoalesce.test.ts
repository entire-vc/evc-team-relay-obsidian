/**
 * @jest-environment jsdom
 *
 * Unit tests: coalesced web_folder_items pushes.
 *
 * WebSyncManager.onFileCreated/onFileRenamed/onFileDeleted used to PATCH
 * /v1/shares/{id} with the folder's full item list on every single event —
 * a background pull of 800 documents into a published folder sent 800
 * PATCHes with an O(N) body each, enough to overload the server. These tests pin the
 * coalescing: a trailing debounce per share, one push in flight at a time,
 * no push for an unchanged list, and backoff on 429/5xx.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { TFile, TFolder, Vault } from "obsidian";
import { WebSyncManager } from "../src/WebSyncManager";
import type { RelayOnPremShareClientManager } from "../src/RelayOnPremShareClientManager";
import type { UpdateShareRequest } from "../src/RelayOnPremShareClient";
import { RelayHttpError, parseRetryAfterMs } from "../src/relayRequestErrors";

const FOLDER = "published";

// The obsidian test double's constructors take a path; the real typings don't.
const MockTFolder = TFolder as unknown as new (path: string) => TFolder;
const MockTFile = TFile as unknown as new (path: string) => TFile;

/** A vault holding one folder whose children the test can grow while events fire. */
function makeFolderVault(): { vault: Vault; folder: TFolder } {
	const folder = new MockTFolder(FOLDER);
	const vault = {
		getAbstractFileByPath: jest.fn((path: string) => (path === FOLDER ? folder : null)),
		getRoot: jest.fn(() => folder),
		read: jest.fn(async () => ""),
	} as unknown as Vault;
	return { vault, folder };
}

type UpdateShareMock = jest.Mock<
	(serverId: string, shareId: string, req: UpdateShareRequest) => Promise<unknown>
>;

function makeClientManager(updateShare: UpdateShareMock): RelayOnPremShareClientManager {
	return {
		updateShare,
		syncFolderFileContent: jest.fn(async () => undefined),
		getClient: jest.fn(),
	} as unknown as RelayOnPremShareClientManager;
}

function addFile(folder: TFolder, name: string): TFile {
	const file = new MockTFile(`${FOLDER}/${name}`);
	folder.children.push(file);
	return file;
}

function lastItems(updateShare: UpdateShareMock) {
	const calls = updateShare.mock.calls;
	return calls[calls.length - 1][2].web_folder_items ?? [];
}

describe("WebSyncManager — coalesced web_folder_items pushes", () => {
	let updateShare: UpdateShareMock;
	let manager: WebSyncManager;
	let folder: TFolder;

	beforeEach(() => {
		jest.useFakeTimers();
		updateShare = jest.fn(async () => ({})) as UpdateShareMock;
		const made = makeFolderVault();
		folder = made.folder;
		manager = new WebSyncManager(made.vault, makeClientManager(updateShare));
		manager.registerAutoSyncShare(FOLDER, "share1", "srv1", "folder", "slug");
	});

	afterEach(() => {
		manager.destroy();
		jest.useRealTimers();
	});

	test("800 create events within 1s produce at most 2 PATCHes carrying all 800 items", async () => {
		for (let i = 0; i < 800; i++) {
			const file = addFile(folder, `note-${i}.md`);
			manager.onFileCreated(file);
			if (i % 100 === 99) await jest.advanceTimersByTimeAsync(125);
		}
		await jest.advanceTimersByTimeAsync(10_000);

		expect(updateShare.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(updateShare.mock.calls.length).toBeLessThanOrEqual(2);
		const items = lastItems(updateShare);
		expect(items).toHaveLength(800);
		expect(items.map((i) => i.path)).toContain("note-799.md");
		expect(updateShare.mock.calls[0][1]).toBe("share1");
	});

	test("a long steady stream still pushes progress, bounded by the max wait", async () => {
		// One create every second for 2 minutes never leaves a 3s quiet gap.
		for (let i = 0; i < 120; i++) {
			manager.onFileCreated(addFile(folder, `n-${i}.md`));
			await jest.advanceTimersByTimeAsync(1000);
		}
		await jest.advanceTimersByTimeAsync(10_000);

		// ~one push per 30s max-wait window plus the trailing one, never one per event.
		expect(updateShare.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(updateShare.mock.calls.length).toBeLessThanOrEqual(6);
		expect(lastItems(updateShare)).toHaveLength(120);
	});

	test("events that do not change the item list send no PATCH", async () => {
		const note = addFile(folder, "a.md");
		manager.onFileCreated(note);
		await jest.advanceTimersByTimeAsync(5000);
		expect(updateShare).toHaveBeenCalledTimes(1);

		// Non-indexed file: not part of web_folder_items at all.
		manager.onFileCreated(addFile(folder, "image.png"));
		// Indexed file event whose list is identical to what the server has.
		manager.onFileCreated(note);
		manager.onFileDeleted(`${FOLDER}/missing.md`);
		await jest.advanceTimersByTimeAsync(10_000);

		expect(updateShare).toHaveBeenCalledTimes(1);
	});

	test("at most one PATCH in flight per share; the latest list wins", async () => {
		let release!: () => void;
		updateShare.mockImplementationOnce(
			() => new Promise((resolve) => { release = () => resolve({}); }),
		);

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(3500);
		expect(updateShare).toHaveBeenCalledTimes(1);

		// More changes while the first PATCH is still pending.
		manager.onFileCreated(addFile(folder, "b.md"));
		await jest.advanceTimersByTimeAsync(3500);
		manager.onFileCreated(addFile(folder, "c.md"));
		await jest.advanceTimersByTimeAsync(3500);
		expect(updateShare).toHaveBeenCalledTimes(1);

		release();
		await jest.advanceTimersByTimeAsync(5000);
		expect(updateShare).toHaveBeenCalledTimes(2);
		expect(lastItems(updateShare).map((i) => i.path)).toEqual(["a.md", "b.md", "c.md"]);
	});

	test("429 with Retry-After: waits the requested time, then retries once", async () => {
		updateShare.mockRejectedValueOnce(
			new RelayHttpError(429, "Failed to update share: 429 Too Many Requests", 20_000),
		);

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(3500);
		expect(updateShare).toHaveBeenCalledTimes(1);

		// Further events during the backoff must not bring the retry forward.
		manager.onFileCreated(addFile(folder, "b.md"));
		await jest.advanceTimersByTimeAsync(15_000);
		expect(updateShare).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(5000);
		expect(updateShare).toHaveBeenCalledTimes(2);
		expect(lastItems(updateShare)).toHaveLength(2);

		await jest.advanceTimersByTimeAsync(60_000);
		expect(updateShare).toHaveBeenCalledTimes(2);
	});

	test("a Retry-After longer than the fallback cap is honoured in full", async () => {
		updateShare.mockRejectedValueOnce(
			new RelayHttpError(429, "Failed to update share: 429 Too Many Requests", 10 * 60_000),
		);

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(3500);
		expect(updateShare).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(9 * 60_000);
		expect(updateShare).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(2 * 60_000);
		expect(updateShare).toHaveBeenCalledTimes(2);
	});

	test("a manual structure sync waits for an in-flight push and counts as the last push", async () => {
		let release!: () => void;
		updateShare.mockImplementationOnce(
			() => new Promise((resolve) => { release = () => resolve({}); }),
		);

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(3500);
		expect(updateShare).toHaveBeenCalledTimes(1);

		addFile(folder, "b.md");
		let manualDone = false;
		const manual = manager.syncFolderStructureToWeb(FOLDER, "srv1", "share1").then(() => {
			manualDone = true;
		});
		await jest.advanceTimersByTimeAsync(1000);
		// Still serialized behind the pending scheduled PATCH.
		expect(updateShare).toHaveBeenCalledTimes(1);
		expect(manualDone).toBe(false);

		release();
		await manual;
		expect(updateShare).toHaveBeenCalledTimes(2);
		expect(lastItems(updateShare).map((i) => i.path)).toEqual(["a.md", "b.md"]);

		// The list the manual sync sent is now the baseline: no duplicate.
		manager.onFileDeleted(`${FOLDER}/missing.md`);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(updateShare).toHaveBeenCalledTimes(2);
	});

	test("a manual sync for a share with no prior events records its list", async () => {
		await manager.syncFolderStructureToWeb(FOLDER, "srv1", "share1");
		expect(updateShare).toHaveBeenCalledTimes(1);

		manager.onFileCreated(addFile(folder, "image.png"));
		manager.onFileDeleted(`${FOLDER}/missing.md`);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(updateShare).toHaveBeenCalledTimes(1);
	});

	test("repeated 5xx backs off exponentially instead of retrying in a loop", async () => {
		updateShare.mockRejectedValue(new RelayHttpError(503, "Failed to update share: 503"));

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(10 * 60_000);

		// 3s debounce, then 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s gaps:
		// single digits over 10 minutes, not hundreds.
		expect(updateShare.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(updateShare.mock.calls.length).toBeLessThanOrEqual(10);
	});

	test("a non-transient error is not retried until the next change", async () => {
		updateShare.mockRejectedValueOnce(new RelayHttpError(400, "Failed to update share: 400"));

		manager.onFileCreated(addFile(folder, "a.md"));
		await jest.advanceTimersByTimeAsync(60_000);
		expect(updateShare).toHaveBeenCalledTimes(1);

		manager.onFileCreated(addFile(folder, "b.md"));
		await jest.advanceTimersByTimeAsync(5000);
		expect(updateShare).toHaveBeenCalledTimes(2);
	});

	test("unregistering the share cancels a pending push", async () => {
		manager.onFileCreated(addFile(folder, "a.md"));
		manager.unregisterAutoSyncShare(FOLDER);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(updateShare).not.toHaveBeenCalled();
	});

	test("rename and delete events are coalesced too", async () => {
		addFile(folder, "a.md");
		manager.onFileRenamed(`${FOLDER}/a.md`, `${FOLDER}/old.md`);
		manager.onFileDeleted(`${FOLDER}/gone.md`);
		manager.onFileRenamed(`${FOLDER}/a.md`, `${FOLDER}/older.md`);
		await jest.advanceTimersByTimeAsync(5000);
		expect(updateShare).toHaveBeenCalledTimes(1);
	});
});

describe("parseRetryAfterMs", () => {
	test("delta-seconds", () => {
		expect(parseRetryAfterMs("30")).toBe(30_000);
	});

	test("HTTP-date", () => {
		const now = Date.parse("2026-10-26T13:00:00Z");
		expect(parseRetryAfterMs("Mon, 26 Oct 2026 13:00:45 GMT", now)).toBe(45_000);
	});

	test("missing or garbage → undefined", () => {
		expect(parseRetryAfterMs(null)).toBeUndefined();
		expect(parseRetryAfterMs("soon")).toBeUndefined();
	});
});
