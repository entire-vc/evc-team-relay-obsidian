/**
 * Tests for the vault-root path convention translation and the TFolder
 * resolver built on top of it.
 *
 * `isRootSharePath`/`toSharePath` cover the wire-convention translation.
 * `resolveShareFolder` covers the actual bug this follow-up fixes: a plain
 * `vault.getAbstractFileByPath(share.path)` returns `null` for a root share
 * (Obsidian's real root `TFolder.path` is `"/"`, not the wire convention's
 * `""`), silently breaking every caller that resolves "the TFolder a share's
 * `.path` points at" without going through this helper.
 */

import { describe, test, expect } from "@jest/globals";
import { TFile, TFolder } from "./mocks/obsidian";
import {
	OBSIDIAN_VAULT_ROOT_PATH,
	isRootSharePath,
	toSharePath,
	resolveShareFolder,
	collectWebFolderItems,
	isPathWithinFolder,
	toFolderRelativePath,
	joinFolderPath,
} from "../src/vaultRootPath";

describe("isRootSharePath", () => {
	test("true for the empty string (wire convention for vault root)", () => {
		expect(isRootSharePath("")).toBe(true);
	});

	test("false for a real folder path", () => {
		expect(isRootSharePath("notes")).toBe(false);
	});

	test("false for Obsidian's own root path literal '/' -- that's the OTHER convention", () => {
		expect(isRootSharePath(OBSIDIAN_VAULT_ROOT_PATH)).toBe(false);
	});
});

describe("toSharePath", () => {
	test("maps Obsidian's root path '/' to the wire convention ''", () => {
		expect(toSharePath("/")).toBe("");
	});

	test("leaves a real folder path unchanged", () => {
		expect(toSharePath("notes/sub")).toBe("notes/sub");
	});
});

// Minimal duck-typed Vault -- only the two methods resolveShareFolder calls.
function fakeVault(opts: { root: TFolder; byPath?: Map<string, TFolder> }) {
	const byPath = opts.byPath ?? new Map<string, TFolder>();
	return {
		getRoot: () => opts.root,
		getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
	};
}

describe("resolveShareFolder", () => {
	test("returns vault.getRoot() for a root share path, bypassing getAbstractFileByPath", () => {
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH);
		const vault = fakeVault({ root });
		const resolved = resolveShareFolder(vault as any, "");
		expect(resolved).toBe(root);
	});

	test("resolves a non-root share path via getAbstractFileByPath", () => {
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH);
		const notes = new TFolder("notes");
		const vault = fakeVault({ root, byPath: new Map([["notes", notes]]) });
		const resolved = resolveShareFolder(vault as any, "notes");
		expect(resolved).toBe(notes);
	});

	test("returns null for a non-root path with no backing folder (deleted/renamed on disk)", () => {
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH);
		const vault = fakeVault({ root });
		const resolved = resolveShareFolder(vault as any, "gone");
		expect(resolved).toBeNull();
	});

	test("returns null when getAbstractFileByPath resolves to a TFile, not a TFolder", () => {
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH);
		// A plain object standing in for a TFile -- not `instanceof TFolder`.
		const fileStandIn = { path: "notes.md" };
		const vault = {
			getRoot: () => root,
			getAbstractFileByPath: (_path: string) => fileStandIn as any,
		};
		const resolved = resolveShareFolder(vault as any, "notes.md");
		expect(resolved).toBeNull();
	});
});

describe("collectWebFolderItems", () => {
	test("root share (folderPath '') -- top-level item path is NOT off-by-one", () => {
		// Real Obsidian: vault root TFolder.path is "/", but top-level
		// children's own `.path` has no leading slash at all ("readme.md",
		// not "/readme.md") -- this is exactly the case that a blind
		// `child.path.substring(folderPath.length + 1)` (folderPath="")
		// mishandles, chopping the first character off.
		const readme = new TFile("readme.md");
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH, [readme]);

		const items = collectWebFolderItems(root as any, "");

		expect(items).toEqual([{ path: "readme.md", name: "readme", type: "doc" }]);
	});

	test("root share -- nested file gets its full relative path, subfolder listed too", () => {
		const nested = new TFile("sub/note.md");
		const sub = new TFolder("sub", [nested]);
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH, [sub]);

		const items = collectWebFolderItems(root as any, "");

		expect(items).toEqual([
			{ path: "sub", name: "sub", type: "folder" },
			{ path: "sub/note.md", name: "note", type: "doc" },
		]);
	});

	test("non-root share -- unchanged: '<folderPath>/' prefix is stripped as before", () => {
		const child = new TFile("notes/a.md");
		const notes = new TFolder("notes", [child]);

		const items = collectWebFolderItems(notes as any, "notes");

		expect(items).toEqual([{ path: "a.md", name: "a", type: "doc" }]);
	});

	test("non-root share -- nested subfolder path is relative to the share, not the vault root", () => {
		const grandchild = new TFile("notes/sub/b.md");
		const sub = new TFolder("notes/sub", [grandchild]);
		const notes = new TFolder("notes", [sub]);

		const items = collectWebFolderItems(notes as any, "notes");

		expect(items).toEqual([
			{ path: "sub", name: "sub", type: "folder" },
			{ path: "sub/b.md", name: "b", type: "doc" },
		]);
	});

	test("canvas files are typed 'canvas', non-md/canvas files are skipped, folders always included", () => {
		const canvas = new TFile("board.canvas");
		const image = new TFile("photo.png");
		const empty = new TFolder("empty-sub");
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH, [canvas, image, empty]);

		const items = collectWebFolderItems(root as any, "");

		expect(items).toEqual([
			{ path: "board.canvas", name: "board", type: "canvas" },
			{ path: "empty-sub", name: "empty-sub", type: "folder" },
		]);
	});
});

describe("resolveShareFolder + collectWebFolderItems composed (main.ts syncAllShares/_initialFullSync call-site pattern)", () => {
	// main.ts's syncAllShares()/_initialFullSync() build a share's
	// web_folder_items by calling `resolveShareFolder(vault, share.path)`
	// then feeding the resolved TFolder into the folder-listing helper --
	// exactly the two-step pattern WebSyncManager/ShareManagementModal/
	// ShareDetailView.svelte already use. Before this fix, main.ts had its
	// own fourth hand-rolled copy of the listing step that derived
	// `basePath` from `folder.path` (`"/"` for a root share) instead of the
	// wire-convention `share.path` (`""`), stripping 2 characters instead
	// of 1 off every top-level item. Composing the two real exported
	// functions here (not a stand-in) pins the call-site behavior, not just
	// the helper in isolation.
	test("root share -- top-level item path is the real filename, not truncated by 1 or 2 chars", () => {
		const readme = new TFile("readme.md");
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH, [readme]);
		const vault = fakeVault({ root });
		const sharePath = ""; // wire convention for "whole vault"

		const folderAbs = resolveShareFolder(vault as any, sharePath);
		expect(folderAbs).toBe(root);
		const items = collectWebFolderItems(folderAbs as any, sharePath);

		expect(items).toEqual([{ path: "readme.md", name: "readme", type: "doc" }]);
	});

	test("non-root share -- regression check, unaffected by the root-share fix", () => {
		const child = new TFile("notes/a.md");
		const notes = new TFolder("notes", [child]);
		const root = new TFolder(OBSIDIAN_VAULT_ROOT_PATH);
		const vault = fakeVault({ root, byPath: new Map([["notes", notes]]) });
		const sharePath = "notes";

		const folderAbs = resolveShareFolder(vault as any, sharePath);
		expect(folderAbs).toBe(notes);
		const items = collectWebFolderItems(folderAbs as any, sharePath);

		expect(items).toEqual([{ path: "a.md", name: "a", type: "doc" }]);
	});
});

describe("isPathWithinFolder", () => {
	test("root share (folderPath '') -- every real vault path is contained", () => {
		expect(isPathWithinFolder("readme.md", "")).toBe(true);
		expect(isPathWithinFolder("sub/deep/note.md", "")).toBe(true);
	});

	test("root share -- even a path that looks unrelated is still contained (root has no boundary)", () => {
		expect(isPathWithinFolder("unrelated-top-level-file.md", "")).toBe(true);
	});

	test("non-root share -- unchanged: a nested path is contained", () => {
		expect(isPathWithinFolder("notes/a.md", "notes")).toBe(true);
		expect(isPathWithinFolder("notes/sub/b.md", "notes")).toBe(true);
	});

	test("non-root share -- a sibling or unrelated path is NOT contained", () => {
		expect(isPathWithinFolder("other/a.md", "notes")).toBe(false);
		expect(isPathWithinFolder("notes-but-not-really/a.md", "notes")).toBe(false);
	});

	test("non-root share -- the folder's own path (no trailing segment) is NOT contained by this check", () => {
		// Matches the pre-existing `startsWith(folderPath + "/")` semantics this
		// helper replaces: exact-match-on-itself is the caller's job (several
		// call sites in WebSyncManager.ts explicitly OR this in separately).
		expect(isPathWithinFolder("notes", "notes")).toBe(false);
	});
});

describe("joinFolderPath", () => {
	test("root share (folderPath '') -- relativePath is returned unchanged, no leading slash prepended", () => {
		// The bug this fixes: a naive `${folderPath}/${relativePath}` join
		// produces "/readme.md" for a root share, which
		// vault.getAbstractFileByPath never resolves (no real Obsidian path
		// starts with a separator).
		expect(joinFolderPath("", "readme.md")).toBe("readme.md");
		expect(joinFolderPath("", "sub/note.md")).toBe("sub/note.md");
	});

	test("non-root share -- unchanged: folderPath and relativePath are joined with '/'", () => {
		expect(joinFolderPath("notes", "a.md")).toBe("notes/a.md");
		expect(joinFolderPath("notes", "sub/b.md")).toBe("notes/sub/b.md");
	});

	test("is the exact inverse of toFolderRelativePath for both root and non-root shares", () => {
		for (const [folderPath, relativePath] of [["", "readme.md"], ["notes", "a.md"]] as const) {
			const absolute = joinFolderPath(folderPath, relativePath);
			expect(toFolderRelativePath(absolute, folderPath)).toBe(relativePath);
		}
	});
});

describe("joinFolderPath feeding vault.getAbstractFileByPath (the getDocumentContent(join(...)) pattern used by content-sync call sites)", () => {
	// ShareDetailView.svelte's syncWebContent() ("Sync now"), ShareManagementModal.ts's
	// syncFolderItems() (getDocumentContent(filePath) -> vault.getAbstractFileByPath),
	// and the other content-push call sites all do the same two-step thing: join a
	// share's folderPath with an item's relative path, then look that up
	// via vault.getAbstractFileByPath. Neither ShareManagementModal (a
	// Modal subclass with heavy Obsidian UI deps) nor the .svelte component
	// (no jest transform in this repo -- see pushFolderContentToServer.ts's
	// own comment on this) is practical to instantiate directly, so this
	// composes the two real steps against a fake vault to pin the call-site
	// behavior directly, not just the join in isolation.
	test("root share -- the joined path resolves against the vault; a naive join would not", () => {
		const file = new TFile("readme.md");
		const vault = {
			getAbstractFileByPath: (path: string) => (path === "readme.md" ? file : null),
		};

		const resolved = vault.getAbstractFileByPath(joinFolderPath("", "readme.md"));

		expect(resolved).toBe(file);
		// The bug this guards against: a naive `${folderPath}/${item.path}`
		// join for a root share produces "/readme.md", which this same
		// fake vault would resolve to null.
		expect(vault.getAbstractFileByPath("/readme.md")).toBeNull();
	});

	test("non-root share -- unaffected, still resolves via the folderPath-prefixed path", () => {
		const file = new TFile("notes/a.md");
		const vault = {
			getAbstractFileByPath: (path: string) => (path === "notes/a.md" ? file : null),
		};

		const resolved = vault.getAbstractFileByPath(joinFolderPath("notes", "a.md"));

		expect(resolved).toBe(file);
	});

	test("ShareManagementModal.syncFolderItems' filePath -- root share resolves, matching the fixed call site", () => {
		// Pins ShareManagementModal.ts:909's fix: `joinFolderPath(this.selectedShare.path, item.path)`
		// feeding getDocumentContent(filePath) -> vault.getAbstractFileByPath(filePath).
		const file = new TFile("readme.md");
		const vault = {
			getAbstractFileByPath: (path: string) => (path === "readme.md" ? file : null),
		};
		const selectedSharePath = ""; // wire convention for a root share

		const filePath = joinFolderPath(selectedSharePath, "readme.md");

		expect(vault.getAbstractFileByPath(filePath)).toBe(file);
	});
});
