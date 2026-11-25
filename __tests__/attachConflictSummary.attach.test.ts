/**
 * GH #114: attaching a folder whose files already exist, diverged, on the
 * server left one "(relay conflict ...)" copy per differing file and no word
 * about them. The copies stay (they are the protection against losing
 * either side); the first sync now reports them in ONE summary notice.
 *
 * The VaultShare tests run the real `VaultShare.prototype` methods the first
 * sync goes through: `_ensureServerSyncMarked()` (the folder's first sync on
 * this device starts here) and `writeConflictCopy()` (every copy is written
 * here), and count every Notice the obsidian mock records. They import
 * nothing new, so on a build without the summary they fail on behaviour
 * (no notice), not on a missing module.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { noticeMock } from "./mocks/obsidian";
import { VaultShare } from "../src/VaultShare";

interface FakeShareOptions {
	/** Has this device synced the folder before? false = it was just attached. */
	serverSynced: boolean;
}

function makeShare(opts: FakeShareOptions) {
	const written: string[] = [];
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.defineProperty(share, "path", { value: "Projects", writable: true });
	Object.defineProperty(share, "isTornDown", { value: false, writable: true });
	Object.defineProperty(share, "vaultApi", {
		value: {
			adapter: {
				write: async (path: string) => {
					written.push(path);
				},
			},
		},
	});
	Object.defineProperty(share, "readServerSynced", { value: async () => opts.serverSynced });
	Object.defineProperty(share, "onceEverSynced", { value: async () => {} });
	Object.defineProperty(share, "noteSynced", { value: async () => {} });
	return { share, written };
}

type Internals = {
	_ensureServerSyncMarked(): Promise<void>;
	writeConflictCopy(doc: { entryPath: string }, content: string, label: string): Promise<string>;
};

/** Runs the folder's first-sync start, then writes one relay-conflict copy per path. */
async function syncWithDifferingFiles(share: VaultShare, paths: string[]): Promise<string[]> {
	const internals = share as unknown as Internals;
	await internals._ensureServerSyncMarked();
	const copies: string[] = [];
	for (const path of paths) {
		copies.push(
			await internals.writeConflictCopy(
				{ entryPath: path },
				`local text of ${path}`,
				"relay conflict 2026-11-25T13-00-00-000Z",
			),
		);
	}
	await jest.advanceTimersByTimeAsync(15_000);
	return copies;
}

function noticeTexts(): string[] {
	return noticeMock.mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
	jest.useFakeTimers();
	noticeMock.mockClear();
});

afterEach(() => {
	jest.useRealTimers();
});

describe("attach: first sync of a folder with diverged server copies (#114)", () => {
	test("3 differing files -> exactly 1 notice naming N=3 and all 3 copies, no per-file notice", async () => {
		const { share, written } = makeShare({ serverSynced: false });

		const copies = await syncWithDifferingFiles(share, ["a.md", "notes/b.md", "c.md"]);

		expect(written).toHaveLength(3); // the copies themselves are still written
		expect(noticeTexts()).toHaveLength(1);
		const [summary] = noticeTexts();
		expect(summary).toContain("3 files differed between local and server");
		for (const copy of copies) expect(summary).toContain(copy);
		expect(copies).toEqual([
			"a (relay conflict 2026-11-25T13-00-00-000Z).md",
			"notes/b (relay conflict 2026-11-25T13-00-00-000Z).md",
			"c (relay conflict 2026-11-25T13-00-00-000Z).md",
		]);
	});

	test("control: 0 differing files -> no notice", async () => {
		const { share } = makeShare({ serverSynced: false });

		await syncWithDifferingFiles(share, []);
		await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

		expect(noticeTexts()).toHaveLength(0);
	});

	test("more than 10 copies -> the first 10 by name and '+K more'", async () => {
		const { share } = makeShare({ serverSynced: false });
		const paths = Array.from({ length: 12 }, (_, i) => `note-${String(i + 1).padStart(2, "0")}.md`);

		const copies = await syncWithDifferingFiles(share, paths);

		expect(noticeTexts()).toHaveLength(1);
		const [summary] = noticeTexts();
		expect(summary).toContain("12 files differed between local and server");
		for (const copy of copies.slice(0, 10)) expect(summary).toContain(copy);
		for (const copy of copies.slice(10)) expect(summary).not.toContain(copy);
		expect(summary).toMatch(/, \+2 more$/);
	});

	test("other sync passes untouched: a folder synced before shows no summary", async () => {
		const { share, written } = makeShare({ serverSynced: true });

		await syncWithDifferingFiles(share, ["a.md", "b.md", "c.md"]);

		expect(written).toHaveLength(3);
		expect(noticeTexts()).toHaveLength(0);
	});

	test("one first sync, one notice: a copy after the summary adds no second notice", async () => {
		const { share, written } = makeShare({ serverSynced: false });
		const internals = share as unknown as Internals;

		await syncWithDifferingFiles(share, ["a.md", "b.md"]);
		await jest.advanceTimersByTimeAsync(30_000);
		await internals.writeConflictCopy({ entryPath: "c.md" }, "text", "relay conflict later");
		await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

		expect(written).toHaveLength(3);
		expect(noticeTexts()).toHaveLength(1);
		expect(noticeTexts()[0]).toContain("2 files differed between local and server");
	});

	test("copies a linked delete preserves are not counted as local/server differences", async () => {
		const { share } = makeShare({ serverSynced: false });
		const internals = share as unknown as Internals;
		await internals._ensureServerSyncMarked();

		await internals.writeConflictCopy({ entryPath: "gone.md" }, "text", "relay deleted 2026-11-25");
		await jest.advanceTimersByTimeAsync(15_000);

		expect(noticeTexts()).toHaveLength(0);
	});

	test("the window ends: copies after it are left to the ordinary passes", async () => {
		const { share } = makeShare({ serverSynced: false });
		const internals = share as unknown as Internals;
		await internals._ensureServerSyncMarked();

		await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
		await internals.writeConflictCopy({ entryPath: "late.md" }, "text", "relay conflict late");
		await jest.advanceTimersByTimeAsync(15_000);

		expect(noticeTexts()).toHaveLength(0);
	});

	test("teardown before the quiet period reports what is pending", async () => {
		const { share } = makeShare({ serverSynced: false });
		const internals = share as unknown as Internals & { attachConflictSummary?: { close(): void } };
		await internals._ensureServerSyncMarked();
		await internals.writeConflictCopy({ entryPath: "a.md" }, "text", "relay conflict t");

		internals.attachConflictSummary?.close();

		expect(noticeTexts()).toEqual([
			"Team Relay (Projects): 1 file differed between local and server; " +
				"conflict copies created: a (relay conflict t).md",
		]);
	});
});
