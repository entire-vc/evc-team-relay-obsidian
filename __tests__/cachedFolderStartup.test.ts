import { describe, test, expect, jest, afterEach } from "@jest/globals";
import * as Y from "yjs";
import "fake-indexeddb/auto";
import { TFolder } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { ProviderBacked } from "../src/ProviderBacked";
import { FolderIndex } from "../src/FolderIndex";
import { makeFolderRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import { LocalDocumentStore, collapseStoredHistory, dropStoredDocument } from "../src/storage/local-document-store";

function fixture(persisted?: Y.Doc) {
	const old = persisted ?? new Y.Doc();
	if (!persisted) {
		old.getMap("docs").set("dev-docs/specs/old.md", "old-doc");
		old.getMap("filemeta_v0").set("dev-docs", makeFolderRecord("old-folder"));
		old.getMap("filemeta_v0").set("dev-docs/specs", makeFolderRecord("old-specs"));
	}
	const server = new Y.Doc();
	Y.applyUpdate(server, Y.encodeStateAsUpdate(old));
	server.transact(() => {
		for (const name of ["docs", "filemeta_v0"]) {
			for (const path of server.getMap(name).keys()) server.getMap(name).delete(path);
		}
	});
	const cache = new Y.Doc();
	Y.applyUpdate(cache, Y.encodeStateAsUpdate(old));
	const index = new FolderIndex(cache, "Shared", new Map(), {
		subscribe: () => () => {},
	} as unknown as AttachmentSyncSettings);
	let confirm!: () => void;
	const synced = new Promise<void>((resolve) => { confirm = resolve; });
	const created: string[] = [];
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared", crdtDoc: cache, folderIndex: index,
		_wantsConnection: true, freshlyCreated: false, isTornDown: false,
		awaitSynced: async () => {}, onceFreshlySynced: () => synced,
		syncKind: (_index: FolderIndex, _log: string[], _ops: unknown[], types: string[]) => {
			index.eachRecord((meta, path) => { if (types.includes(meta.type)) created.push(path); });
		},
		_logSyncFileTreeStart: jest.fn(), _logSyncFileTreeResult: jest.fn(),
		pruneUntrackedFiles: () => [],
		_localDb: { set: async () => {} },
	});
	return { cache, server, index, share, created, confirm };
}

describe("cached folder startup", () => {
	afterEach(() => { jest.useRealTimers(); });
	test.each([false, true])("replayed IndexedDB cannot create deleted folders; live folder control=%s", async (liveFolder) => {
		const seed = fixture();
		const database = `cached-folder-startup-${liveFolder}`;
		const writer = new LocalDocumentStore(database, seed.cache);
		await writer.whenSynced;
		await collapseStoredHistory(writer);
		await writer.destroy();
		const replayed = new Y.Doc();
		const reader = new LocalDocumentStore(database, replayed);
		await reader.whenSynced;
		expect([...replayed.getMap("docs").keys()]).toContain("dev-docs/specs/old.md");
		const f = fixture(replayed);
		const nodes = new Map<string, TFolder>();
		const makeFolder = (path: string): TFolder => {
			const node: TFolder = Object.create(TFolder.prototype);
			node.path = path;
			node.children = [];
			nodes.set(path, node);
			return node;
		};
		makeFolder("Shared");
		const contains = Object.getOwnPropertyDescriptor(Array.prototype, "contains");
		Object.defineProperty(Array.prototype, "contains", { configurable: true, value: Array.prototype.includes });
		Object.assign(f.share, {
			syncKind: VaultShare.prototype.syncKind,
			awaitSynced: VaultShare.prototype.awaitSynced,
			_localDb: reader,
			trackedEntries: new Map(), awaitingDelete: new Set(), deletedEntries: new WeakSet(),
			pathSet: { include: jest.fn(), update: jest.fn() },
			subscribe: () => () => {}, log: jest.fn(),
			vaultApi: {
				getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
				createFolder: async (path: string) => makeFolder(path),
				adapter: { mkdir: async (path: string) => { makeFolder(path); } },
			},
		});
		// This fixture exercises folder creation, not document-content transfers.
		jest.spyOn(f.index.kinds, "enabledSyncKinds").mockReturnValue([]);
		try {
			const scan = f.share.scanFileTree(f.index);
			await new Promise((resolve) => window.setTimeout(resolve, 10));
			expect([...nodes.keys()]).toEqual(["Shared"]);
			if (liveFolder) f.server.getMap("filemeta_v0").set("current", makeFolderRecord("current"));
			Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
			f.confirm();
			await scan;
			await Promise.all([...f.share.trackedEntries.values()].map((entry) => (entry as { creation?: Promise<unknown> }).creation));
			expect([...nodes.keys()]).toEqual(liveFolder ? ["Shared", "Shared/current"] : ["Shared"]);
			expect([...f.cache.getMap("filemeta_v0").keys()]).toEqual(liveFolder ? ["current"] : []);
		} finally {
			if (contains) Object.defineProperty(Array.prototype, "contains", contains);
			else Reflect.deleteProperty(Array.prototype, "contains");
			await reader.destroy();
			await dropStoredDocument(database);
		}
	});
	test("old cache cannot materialize paths before a clean server's deletes arrive", async () => {
		const f = fixture();
		const scan = f.share.scanFileTree(f.index);
		await Promise.resolve();
		await Promise.resolve();
		expect(f.created).toEqual([]);
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await scan;
		expect(f.created).toEqual([]);
		expect([...f.cache.getMap("filemeta_v0").keys()]).toEqual([]);
		expect([...f.cache.getMap("docs").keys()]).toEqual([]);
	});

	test("a live server folder is materialized after the first sync", async () => {
		const f = fixture();
		f.server.getMap("filemeta_v0").set("current", makeFolderRecord("current"));
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		const scan = f.share.scanFileTree(f.index);
		await scan;
		expect(f.created).toContain("current");
	});

	test("automatic legacy observers cannot stage cached parents before fresh sync", async () => {
		const f = fixture();
		const observe = jest.spyOn(f.index, "observe");
		(f.share as unknown as { _onSynced(): void })._onSynced();
		await Promise.resolve();
		await Promise.resolve();
		f.cache.getMap("docs").set("keep.md", "keep");
		expect(observe).not.toHaveBeenCalled();
		expect([...f.index.stagedWrites.keys()]).toEqual([]);
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await f.share.scanFileTree(f.index);
		expect(observe).toHaveBeenCalledTimes(1);
		expect(f.created.some((path) => path.startsWith("dev-docs"))).toBe(false);
		f.index.destroy();
	});

	test("startup's 30 second timeout does not release cached tree processing", async () => {
		jest.useFakeTimers();
		const f = fixture();
		Object.assign(f.share, { adoptLocalFiles: jest.fn(async () => {}) });
		const ready = (f.share as unknown as { _onReady(): Promise<void> })._onReady();
		await jest.advanceTimersByTimeAsync(30001);
		await ready;
		expect(f.created).toEqual([]);
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await f.share.scanFileTree(f.index);
		expect(f.created).toEqual([]);
	});

	test("freshly created shares process their own folders offline", async () => {
		const f = fixture();
		Object.assign(f.share, { freshlyCreated: true, _wantsConnection: false });
		await f.share.scanFileTree(f.index);
		expect(f.created).toContain("dev-docs/specs");
	});

	test("migrating an existing offline authority still waits for its first sync", async () => {
		const f = fixture();
		Object.assign(f.share, { isAuthority: true, _wantsConnection: false });
		const scan = f.share.scanFileTree(f.index);
		await Promise.resolve();
		await Promise.resolve();
		expect(f.created).toEqual([]);
		Y.applyUpdate(f.cache, Y.encodeStateAsUpdate(f.server));
		f.confirm();
		await scan;
		expect(f.created).toEqual([]);
	});

	test("unload suppresses queued work even if fresh sync resolves afterwards", async () => {
		const f = fixture();
		const observe = jest.spyOn(f.index, "observe");
		(f.share as unknown as { _onSynced(): void })._onSynced();
		const scan = f.share.scanFileTree(f.index);
		await Promise.resolve();
		f.share.isTornDown = true;
		f.confirm();
		await scan;
		expect(observe).not.toHaveBeenCalled();
		expect(f.created).toEqual([]);
	});

	test("dismantling settles a pending scan without a provider sync", async () => {
		const f = fixture();
		Object.assign(f.share, {
			teardowns: [], trackedEntries: new Map(),
			attachmentSettings: { destroy: jest.fn() },
			_config: { destroy: jest.fn() }, pathSet: { clearAll: jest.fn() },
		});
		const providerTeardown = jest.spyOn(ProviderBacked.prototype, "dismantle").mockImplementation(() => {});
		try {
			const scan = f.share.scanFileTree(f.index);
			await Promise.resolve();
			f.share.dismantle();
			expect(await Promise.race([scan.then(() => true), new Promise((resolve) => window.setTimeout(() => resolve(false), 25))])).toBe(true);
			expect(f.created).toEqual([]);
		} finally {
			providerTeardown.mockRestore();
		}
	});
});
