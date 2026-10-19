/**
 * Regression test for the folder-publish partial-failure fix ( /
 *): one file the server's path validator rejects used to
 * abort the whole `pushFolderContentToServer` loop, so a single bad name
 * (e.g. an em-dash Obsidian allows but the server's path allowlist didn't)
 * failed publishing every other file in the folder too.
 *
 * Mocks only the true external boundary -- the relay server's sync-write
 * protocol (`getFilesIndex`/`syncWriteFile`). The
 * folder-walk filtering and `sha256Hex` are the real production code, not
 * faked.
 */
import { describe, test, expect, jest } from "@jest/globals";
import { pushFolderContentToServer, type FolderPushDeps } from "../src/webPublish/pushFolderContentToServer";
import type { WebFolderEntry } from "../src/RelayOnPremShareClient";

function makeDeps(overrides: Partial<FolderPushDeps> = {}): FolderPushDeps {
	return {
		getFilesIndex: jest.fn(async () => []),
		syncWriteFile: jest.fn(async () => {}),
		getDocumentContent: jest.fn(async (path: string) => `content of ${path}`),
		...overrides,
	};
}

const items: WebFolderEntry[] = [
	{ path: "good-one.md", name: "good-one", type: "doc" },
	{ path: "bad — name.md", name: "bad — name", type: "doc" },
	{ path: "good-two.md", name: "good-two", type: "doc" },
];

describe("pushFolderContentToServer", () => {
	test("one file rejected by the server does not abort the rest of the publish", async () => {
		const writes: string[] = [];
		const deps = makeDeps({
			syncWriteFile: jest.fn(async (path: string) => {
				if (path === "bad — name.md") {
					throw new Error("400: path contains characters outside the allowlist");
				}
				writes.push(path);
			}),
		});

		const skipped = await pushFolderContentToServer("Share", items, deps);

		expect(skipped).toEqual(["bad — name.md"]);
		expect(writes.sort()).toEqual(["good-one.md", "good-two.md"]);
	});

	test("no rejections -- nothing skipped, everything written", async () => {
		const writes: string[] = [];
		const deps = makeDeps({
			syncWriteFile: jest.fn(async (path: string) => {
				writes.push(path);
			}),
		});

		const skipped = await pushFolderContentToServer("Share", items, deps);

		expect(skipped).toEqual([]);
		expect(writes.sort()).toEqual(["bad — name.md", "good-one.md", "good-two.md"]);
	});

	test("all files rejected -- every path reported skipped, none throw out of the function", async () => {
		const deps = makeDeps({
			syncWriteFile: jest.fn(async () => {
				throw new Error("500: server on fire");
			}),
		});

		const skipped = await pushFolderContentToServer("Share", items, deps);

		expect(skipped.sort()).toEqual(["bad — name.md", "good-one.md", "good-two.md"]);
	});

	test("already-synced file (matching remote sha) is skipped as a no-op write, not reported as failed", async () => {
		const content = "content of Share/good-one.md";
		const { sha256Hex } = await import("../src/contentDigest");
		const sha = await sha256Hex(new TextEncoder().encode(content).buffer as ArrayBuffer);

		const writes: string[] = [];
		const deps = makeDeps({
			getFilesIndex: jest.fn(async () => [{ path: "good-one.md", sha256: sha }]),
			getDocumentContent: jest.fn(async (path: string) => `content of ${path}`),
			syncWriteFile: jest.fn(async (path: string) => {
				writes.push(path);
			}),
		});

		const skipped = await pushFolderContentToServer("Share", [items[0]], deps);

		expect(skipped).toEqual([]);
		expect(writes).toEqual([]); // already in sync -- no write attempted at all
	});

	test("non-syncable items (plain folders) are ignored entirely", async () => {
		const deps = makeDeps();
		const folderOnly: WebFolderEntry[] = [{ path: "Subfolder", name: "Subfolder", type: "folder" }];

		const skipped = await pushFolderContentToServer("Share", folderOnly, deps);

		expect(skipped).toEqual([]);
		expect(deps.getFilesIndex).not.toHaveBeenCalled();
	});

	test("empty folder short-circuits without touching the network at all", async () => {
		const deps = makeDeps();

		const skipped = await pushFolderContentToServer("Share", [], deps);

		expect(skipped).toEqual([]);
		expect(deps.getFilesIndex).not.toHaveBeenCalled();
	});

	test("root share (folderPath '') -- content is read from the real vault path, not a leading-slash one", async () => {
		// `folderPath=""` is the wire convention for "whole vault" (a root
		// share). A naive `${folderPath}/${item.path}` join would produce
		// "/good-one.md" here, which `vault.getAbstractFileByPath` never
		// resolves -- no real Obsidian path starts with a separator. This
		// pins the fix (`joinFolderPath`, which special-cases the root
		// share to return `item.path` unchanged, no prepended slash).
		const requestedPaths: string[] = [];
		const deps = makeDeps({
			getDocumentContent: jest.fn(async (path: string) => {
				requestedPaths.push(path);
				return `content of ${path}`;
			}),
		});

		const skipped = await pushFolderContentToServer("", [items[0]], deps);

		expect(requestedPaths).toEqual(["good-one.md"]);
		expect(skipped).toEqual([]);
	});

	test("a missing files-index (fresh share) is treated as no-prior-sync, not fatal", async () => {
		const writes: string[] = [];
		const deps = makeDeps({
			getFilesIndex: jest.fn(async () => {
				throw new Error("404: no index yet");
			}),
			syncWriteFile: jest.fn(async (path: string) => {
				writes.push(path);
			}),
		});

		const skipped = await pushFolderContentToServer("Share", [items[0]], deps);

		expect(skipped).toEqual([]);
		expect(writes).toEqual(["good-one.md"]);
	});
});
