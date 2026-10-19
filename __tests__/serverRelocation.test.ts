/**
 * Offline client + server-side relocation (relocate-artifacts): the client
 * must follow the move locally instead of publishing the old root again.
 */
import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { VaultShare } from "../src/VaultShare";
import { FolderIndex } from "../src/FolderIndex";
import { makeFolderRecord, makeDocumentRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import { TFile, TFolder } from "obsidian";
import {
	findServerMoves,
	findStructuralMoves,
	isUnderSkippedPath,
	takeRecordSnapshot,
	type RecordSnapshot,
} from "../src/serverRelocation";

const snap = (entries: Record<string, [string, string]>): RecordSnapshot =>
	new Map(Object.entries(entries).map(([p, [type, id]]) => [p, { type, id }]));

describe("findServerMoves", () => {
	test("ignores moves whose paths escape the share", () => {
		const before = snap({ "aaaa1111": ["folder", "f1"], "bbbb2222": ["folder", "f2"] });
		const after = snap({
			"../Outside": ["folder", "f1"],
			"/abs": ["folder", "f2"],
		});
		expect(findServerMoves(before, after)).toEqual([]);
	});

	test("same ids at a new path are a move; children are implied by the root", () => {
		const before = snap({
			"aaaa1111": ["folder", "f1"],
			"aaaa1111/note.md": ["document", "d1"],
		});
		const after = snap({
			"artifacts/aaaa1111": ["folder", "f1"],
			"artifacts/aaaa1111/note.md": ["document", "d1"],
		});
		expect(findServerMoves(before, after)).toEqual([
			{ from: "aaaa1111", to: "artifacts/aaaa1111" },
		]);
	});

	test("duplicate-root merge: destination keeps its own ids", () => {
		const before = snap({ "aaaa1111": ["folder", "f1"] });
		const after = snap({ "artifacts/aaaa1111": ["folder", "f2"] });
		expect(findServerMoves(before, after)).toEqual([
			{ from: "aaaa1111", to: "artifacts/aaaa1111" },
		]);
	});

	test("duplicate-root merge into a destination that already existed", () => {
		const before = snap({
			"aaaa1111": ["folder", "f1"],
			"artifacts/aaaa1111": ["folder", "f2"],
		});
		const after = snap({ "artifacts/aaaa1111": ["folder", "f2"] });
		expect(findServerMoves(before, after)).toEqual([
			{ from: "aaaa1111", to: "artifacts/aaaa1111" },
		]);
	});

	test("a plain remote delete is not a move", () => {
		expect(findServerMoves(snap({ gone: ["folder", "f1"] }), snap({}))).toEqual([]);
	});

	test("untouched paths are not moves", () => {
		const same = snap({ keep: ["folder", "f1"] });
		expect(findServerMoves(same, same)).toEqual([]);
	});
});

function offlineMoveFixture() {
	const persisted = new Y.Doc();
	persisted.getMap("filemeta_v0").set("aaaa1111", makeFolderRecord("f1"));
	persisted.getMap("filemeta_v0").set("aaaa1111/note.md", makeDocumentRecord("d1"));
	persisted.getMap("docs").set("aaaa1111/note.md", "d1");

	const server = new Y.Doc();
	Y.applyUpdate(server, Y.encodeStateAsUpdate(persisted));
	server.transact(() => {
		const meta = server.getMap("filemeta_v0");
		const docs = server.getMap("docs");
		meta.delete("aaaa1111");
		meta.delete("aaaa1111/note.md");
		docs.delete("aaaa1111/note.md");
		meta.set("artifacts", makeFolderRecord("fa"));
		meta.set("artifacts/aaaa1111", makeFolderRecord("f1"));
		meta.set("artifacts/aaaa1111/note.md", makeDocumentRecord("d1"));
		docs.set("artifacts/aaaa1111/note.md", "d1");
	});

	const cache = new Y.Doc();
	Y.applyUpdate(cache, Y.encodeStateAsUpdate(persisted));
	const index = new FolderIndex(cache, "Shared", new Map(), {
		subscribe: () => () => {},
	} as unknown as AttachmentSyncSettings);

	let confirm!: () => void;
	const synced = new Promise<void>((resolve) => { confirm = resolve; });
	const local = new Set(["Shared/aaaa1111", "Shared/aaaa1111/note.md"]);
	const renames: Array<[string, string]> = [];
	const adopted: string[][] = [];

	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared", crdtDoc: cache, folderIndex: index,
		_wantsConnection: true, freshlyCreated: false, isTornDown: false,
		awaitSynced: async () => {}, onceFreshlySynced: () => synced,
		followedMoveSkips: new Set<string>(),
		adoptLocalFiles: jest.fn(async () => { adopted.push([...local]); }),
		scanFileTree: jest.fn(async () => {}),
		vaultApi: {
			getAbstractFileByPath: (p: string) => (local.has(p) ? { path: p } : null),
		},
		fileOps: {
			renameFile: async (file: { path: string }, to: string) => {
				renames.push([file.path, to]);
				for (const p of [...local]) {
					if (p === file.path || p.startsWith(file.path + "/")) {
						local.delete(p);
						local.add(to + p.slice(file.path.length));
					}
				}
			},
		},
		_ensureParentDir: async () => { local.add("Shared/artifacts"); },
	});
	return { cache, server, share, confirm, renames, adopted, local };
}

describe("offline client + server relocation", () => {
	test("the old root is renamed before local files are adopted", async () => {
		const f = offlineMoveFixture();
		// As in the constructor: _onSynced() starts the folder-tree barrier (and the
		// persisted snapshot) as soon as IndexedDB has loaded, before the provider syncs.
		(f.share as unknown as { _onSynced(): void })._onSynced();
		const ready = (f.share as unknown as { _onReady(): Promise<void> })._onReady();
		await new Promise((resolve) => window.setTimeout(resolve, 5));
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await ready;

		expect(f.renames).toEqual([["Shared/aaaa1111", "Shared/artifacts/aaaa1111"]]);
		expect(f.adopted).toHaveLength(1);
		expect(f.adopted[0]).toContain("Shared/artifacts/aaaa1111/note.md");
		expect(f.adopted[0]).not.toContain("Shared/aaaa1111");
		expect(takeRecordSnapshot((f.share as unknown as { folderIndex: FolderIndex }).folderIndex).has("aaaa1111")).toBe(false);
	});

	test("never overwrites a destination that already exists locally", async () => {
		const f = offlineMoveFixture();
		f.local.add("Shared/artifacts/aaaa1111");
		// As in the constructor: _onSynced() starts the folder-tree barrier (and the
		// persisted snapshot) as soon as IndexedDB has loaded, before the provider syncs.
		(f.share as unknown as { _onSynced(): void })._onSynced();
		const ready = (f.share as unknown as { _onReady(): Promise<void> })._onReady();
		await new Promise((resolve) => window.setTimeout(resolve, 5));
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await ready;
		expect(f.renames).toEqual([]);
		// The old root stays on disk but is excluded from adoption.
		expect([...(f.share as unknown as { followedMoveSkips: Set<string> }).followedMoveSkips]).toEqual(["aaaa1111"]);
	});

	test("a failed local rename keeps the old root out of adoption", async () => {
		const f = offlineMoveFixture();
		(f.share as unknown as { fileOps: { renameFile: () => Promise<void> } }).fileOps.renameFile = async () => {
			throw new Error("rename failed");
		};
		(f.share as unknown as { _onSynced(): void })._onSynced();
		const ready = (f.share as unknown as { _onReady(): Promise<void> })._onReady();
		await new Promise((resolve) => window.setTimeout(resolve, 5));
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await ready;
		expect([...(f.share as unknown as { followedMoveSkips: Set<string> }).followedMoveSkips]).toEqual(["aaaa1111"]);
	});

	test("skipped roots cover their children but not look-alike siblings", () => {
		const skips = new Set(["aaaa1111"]);
		expect(isUnderSkippedPath("aaaa1111", skips)).toBe(true);
		expect(isUnderSkippedPath("aaaa1111/note.md", skips)).toBe(true);
		expect(isUnderSkippedPath("aaaa11112/note.md", skips)).toBe(false);
		expect(isUnderSkippedPath("artifacts/aaaa1111/note.md", skips)).toBe(false);
	});
});

describe("findStructuralMoves", () => {
	const after = snap({
		artifacts: ["folder", "fa"],
		"artifacts/aaaa1111__legacy": ["folder", "f1"],
		"artifacts/Projects": ["folder", "f2"],
	});

	test("an untracked tool-named root with a tracked artifacts/<root> is a move", () => {
		expect(findStructuralMoves(["aaaa1111__legacy"], after)).toEqual([
			{ from: "aaaa1111__legacy", to: "artifacts/aaaa1111__legacy" },
		]);
	});

	test("ordinary folder names are never treated as moved", () => {
		expect(findStructuralMoves(["Projects"], after)).toEqual([]);
	});

	test("a root the share still tracks (itself or by content) stays", () => {
		const tracked = snap({
			"artifacts/aaaa1111__legacy": ["folder", "f1"],
			"aaaa1111__legacy/note.md": ["document", "d1"],
		});
		expect(findStructuralMoves(["aaaa1111__legacy"], tracked)).toEqual([]);
		const itself = snap({
			aaaa1111__legacy: ["folder", "f9"],
			"artifacts/aaaa1111__legacy": ["folder", "f1"],
		});
		expect(findStructuralMoves(["aaaa1111__legacy"], itself)).toEqual([]);
	});
});

// A client whose IndexedDB cannot tell the move: it is empty, or an earlier
// instance of the share already stored the server's post-move state.
function noMemoryFixture(disk: Record<string, string>) {
	const server = new Y.Doc();
	server.transact(() => {
		const meta = server.getMap("filemeta_v0");
		meta.set("artifacts", makeFolderRecord("fa"));
		meta.set("artifacts/aaaa1111", makeFolderRecord("f1"));
		meta.set("artifacts/aaaa1111/note.md", makeDocumentRecord("d1"));
		server.getMap("docs").set("artifacts/aaaa1111/note.md", "d1");
	});
	const cache = new Y.Doc();
	Y.applyUpdate(cache, Y.encodeStateAsUpdate(server));
	const index = new FolderIndex(cache, "Shared", new Map(), {
		subscribe: () => () => {},
	} as unknown as AttachmentSyncSettings);

	const files = new Map(Object.entries(disk));
	const folders = new Set<string>();
	const trashed: string[] = [];
	const renames: Array<[string, string]> = [];
	const dirsOf = (path: string) => {
		const parts = path.split("/");
		return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
	};
	for (const path of files.keys()) dirsOf(path).forEach((d) => folders.add(d));
	const listing = () => {
		const all = new Set<string>(folders);
		for (const path of files.keys()) dirsOf(path).forEach((d) => all.add(d));
		const nodes = new Map<string, TFile | TFolder>();
		for (const dir of [...all].sort()) nodes.set(dir, Object.assign(Object.create(TFolder.prototype), { path: dir, children: [] }));
		for (const path of files.keys()) nodes.set(path, Object.assign(Object.create(TFile.prototype), { path }));
		for (const [path, node] of nodes) {
			const parent = nodes.get(path.split("/").slice(0, -1).join("/"));
			if (parent instanceof TFolder) parent.children.push(node);
		}
		return nodes;
	};

	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared", crdtDoc: cache, folderIndex: index,
		_wantsConnection: true, freshlyCreated: false, isTornDown: false,
		awaitSynced: async () => {}, onceFreshlySynced: () => Promise.resolve(),
		followedMoveSkips: new Set<string>(),
		adoptLocalFiles: jest.fn(async () => {}),
		scanFileTree: jest.fn(async () => {}),
		vaultFilesInScope: () =>
			[...listing()].filter(([path]) => path !== "Shared" && path.startsWith("Shared/")).map(([, node]) => node),
		vaultApi: {
			getAbstractFileByPath: (p: string) => listing().get(p) ?? null,
			adapter: {
				exists: async (p: string) => files.has(p),
				readBinary: async (p: string) => new TextEncoder().encode(files.get(p) ?? "").buffer,
			},
			trash: async (node: { path: string }) => {
				trashed.push(node.path);
				files.delete(node.path);
				folders.delete(node.path);
			},
		},
		fileOps: {
			renameFile: async (file: { path: string }, to: string) => {
				renames.push([file.path, to]);
				for (const [p, text] of [...files]) {
					if (p === file.path || p.startsWith(file.path + "/")) {
						files.delete(p);
						files.set(to + p.slice(file.path.length), text);
					}
				}
			},
		},
		_ensureParentDir: async () => {},
	});
	return { share, files, trashed, renames };
}

describe("client with no usable memory of the old paths", () => {
	const run = async (share: VaultShare) => {
		(share as unknown as { _onSynced(): void })._onSynced();
		await (share as unknown as { _onReady(): Promise<void> })._onReady();
	};

	test("follows the move by structure when the destination is absent", async () => {
		const f = noMemoryFixture({ "Shared/aaaa1111/note.md": "same" });
		await run(f.share);
		expect(f.renames).toEqual([["Shared/aaaa1111", "Shared/artifacts/aaaa1111"]]);
		expect([...f.files.keys()]).toEqual(["Shared/artifacts/aaaa1111/note.md"]);
	});

	test("destination already on disk: identical copies go to the trash, root is not published", async () => {
		const f = noMemoryFixture({
			"Shared/aaaa1111/note.md": "same",
			"Shared/aaaa1111/mine.md": "only here",
			"Shared/artifacts/aaaa1111/note.md": "same",
		});
		await run(f.share);
		expect(f.renames).toEqual([]);
		expect(f.trashed).toEqual(["Shared/aaaa1111/note.md"]);
		expect([...f.files.keys()].sort()).toEqual([
			"Shared/aaaa1111/mine.md",
			"Shared/artifacts/aaaa1111/note.md",
		]);
		expect([...(f.share as unknown as { followedMoveSkips: Set<string> }).followedMoveSkips]).toEqual(["aaaa1111"]);
	});

	test("a fully duplicated root disappears, including its folders", async () => {
		const f = noMemoryFixture({
			"Shared/aaaa1111/note.md": "same",
			"Shared/artifacts/aaaa1111/note.md": "same",
		});
		await run(f.share);
		expect(f.trashed).toEqual(["Shared/aaaa1111/note.md", "Shared/aaaa1111"]);
		expect([...f.files.keys()]).toEqual(["Shared/artifacts/aaaa1111/note.md"]);
	});

	test("an ordinary local folder is left for normal adoption", async () => {
		const f = noMemoryFixture({ "Shared/Projects/a.md": "x" });
		await run(f.share);
		expect(f.renames).toEqual([]);
		expect(f.trashed).toEqual([]);
		expect((f.share as unknown as { followedMoveSkips: Set<string> }).followedMoveSkips.size).toBe(0);
	});
});
