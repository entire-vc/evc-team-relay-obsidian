import { TFile, TFolder, type TAbstractFile } from "obsidian";
import * as Y from "yjs";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import type { FolderIndex } from "../src/FolderIndex";
import { ShareRegistry, VaultShare } from "../src/VaultShare";
import { STUCK_UPLOAD_MS, uploadNotice } from "../src/stuckUploads";

const DAY = 24 * 60 * 60 * 1000;
// The Jest mock (mocks/obsidian.ts) gives TFile/TFolder path constructors the real typings lack.
const MockFile = TFile as unknown as new (path: string) => TFile;
const MockFolder = TFolder as unknown as new (path: string, children?: TAbstractFile[]) => TFolder;
const GUID = "11111111-1111-4111-8111-111111111111";

/** A vault of real (mock) TFolder/TFile nodes, looked up by path. */
function makeVault(tree: Record<string, string[]>) {
	const nodes = new Map<string, TAbstractFile>();
	for (const [folderPath, files] of Object.entries(tree)) {
		const folder = new MockFolder(folderPath, files.map((f) => new MockFile(`${folderPath}/${f}`)));
		nodes.set(folderPath, folder);
		for (const child of folder.children) nodes.set(child.path, child);
	}
	// Obsidian lists the vault root among loaded files, with path "/".
	nodes.set("/", new MockFolder("/", []));
	return {
		nodes,
		getAbstractFileByPath: (p: string) => nodes.get(p) ?? null,
		getAllLoadedFiles: () => [...nodes.values()],
		getRoot: () => new MockFolder("", []),
	};
}

function makeShare(path: string, vaultApi: unknown, extra: Record<string, unknown> = {}) {
	const persisted: Record<string, unknown> = { path, guid: GUID };
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path,
		entityGuid: GUID,
		vaultApi,
		warn: jest.fn(),
		log: jest.fn(),
		setLoggers: jest.fn(),
		isTornDown: false,
		isSyncableVaultFile: () => true,
		_config: {
			mutateValue: async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
				Object.assign(persisted, fn({ ...persisted }));
			},
		},
		refreshFromServer: jest.fn().mockResolvedValue(undefined),
		...extra,
	});
	return { share, persisted };
}

function makeRegistry(vaultApi: unknown, shares: VaultShare[]) {
	const queue = [...shares];
	const registry = new ShareRegistry(
		{} as never,
		vaultApi as never,
		(() => queue.shift()) as never,
		{ readValue: () => [], mutateValue: async () => {} } as never,
	);
	for (const s of shares) registry.new(s.path, s.entityGuid);
	return registry;
}

describe("re-link a share to another existing folder", () => {
	test("relink moves the record to the new path and the new folder's files come into scope", () => {
		const vault = makeVault({ New: ["a.md", "b.png"], Other: ["x.md"] });
		const { share, persisted } = makeShare("Gone", vault);
		const registry = makeRegistry(vault, [share]);
		expect(share.folderMissing).toBe(true);

		registry.relink(share, "New");

		expect(share.path).toBe("New");
		expect(persisted.path).toBe("New");
		expect(share.folderMissing).toBe(false);
		const inScope = (share as unknown as { vaultFilesInScope(): { path: string }[] })
			.vaultFilesInScope()
			.map((f) => f.path)
			.sort();
		expect(inScope).toEqual(["New/a.md", "New/b.png"]);
		expect(share.refreshFromServer).toHaveBeenCalledTimes(1);
	});

	test("relink refuses another share's folder, a nested folder and the vault root", () => {
		const vault = makeVault({ Taken: [], "Taken/Sub": [], Free: [] });
		const { share } = makeShare("Gone", vault);
		const other = makeShare("Taken", vault).share;
		Object.assign(other, { entityGuid: "22222222-2222-4222-8222-222222222222" });
		const registry = makeRegistry(vault, [share, other]);

		expect(() => registry.relink(share, "Taken")).toThrow(/Another shared folder/);
		expect(() => registry.relink(share, "Taken/Sub")).toThrow(/Nested/);
		expect(() => registry.relink(share, "")).toThrow(/vault root/);
		expect(() => registry.relink(share, "/")).toThrow(/vault root/);
		expect(() => registry.relink(share, "Missing")).toThrow(/No folder/);
		expect(share.path).toBe("Gone");
		expect(registry.relinkTargets(share)).toEqual(["Free"]);
	});
});

describe("files not uploaded for more than 7 days", () => {
	function shareWithClaim(claimedAt: number) {
		const claims = new Map([["note.md", "g-note"]]);
		const ages = new Map([["g-note", claimedAt]]);
		const { share } = makeShare("Shared", makeVault({ Shared: ["note.md"] }), {
			uploadClaims: claims,
			uploadClaimAges: ages,
		});
		return { share, claims, ages };
	}

	test("a claim older than 7 days is reported", () => {
		const now = Date.UTC(2026, 10, 14);
		const { share } = shareWithClaim(now - 8 * DAY);
		expect(share.stuckUploadPaths(now)).toEqual(["note.md"]);
	});

	test("a claim younger than 7 days is not reported", () => {
		const now = Date.UTC(2026, 10, 14);
		const { share } = shareWithClaim(now - 6 * DAY);
		expect(share.stuckUploadPaths(now)).toEqual([]);
		expect(STUCK_UPLOAD_MS).toBe(7 * DAY);
	});

	test("a new claim gets its age when it is minted, not when the panel first reads it", () => {
		// Empty start: no claims, so no retry timer and no reconcile runs later.
		const t0 = Date.UTC(2026, 10, 1);
		const claims = new Map<string, string>();
		const ages = new Map<string, number>();
		const { share } = makeShare("Shared", makeVault({ Shared: [] }), {
			uploadClaims: claims,
			uploadClaimAges: ages,
			crdtDoc: new Y.Doc(),
			attachmentSettings: {
				subscribe: () => () => {},
				isFileTypeAllowed: () => true,
			} as unknown as AttachmentSyncSettings,
		});
		const index = (share as unknown as { _buildSyncStore(): FolderIndex })
			._buildSyncStore();
		const now = jest.spyOn(Date, "now").mockReturnValue(t0);
		try {
			index.new("late.md");
		} finally {
			now.mockRestore();
		}
		// First look at the panel eight days later.
		expect(share.stuckUploadPaths(t0 + 8 * DAY)).toEqual(["late.md"]);
		expect(share.stuckUploadPaths(t0 + 8 * DAY)).toEqual(["late.md"]);
	});

	test("reading never stamps an age; reconcile backfills with mtime and drops finished ages", () => {
		const now = Date.now();
		const claims = new Map([["fresh.md", "g-fresh"]]);
		const ages = new Map([["g-done", now - 30 * DAY]]);
		const vault = makeVault({ Shared: ["fresh.md"] });
		const { share } = makeShare("Shared", vault, {
			uploadClaims: claims,
			uploadClaimAges: ages,
		});
		expect(share.stuckUploadPaths(now)).toEqual([]);
		expect(ages.has("g-fresh")).toBe(false);

		const mtime = now - 20 * DAY;
		const file = vault.nodes.get("Shared/fresh.md");
		if (!(file instanceof TFile)) throw new Error("fixture: Shared/fresh.md is not a file");
		file.stat.mtime = mtime;
		(share as unknown as { _reconcileUploadClaimAges(): void })._reconcileUploadClaimAges();
		expect(ages.has("g-done")).toBe(false);
		expect(ages.get("g-fresh")).toBe(mtime);
		expect(share.stuckUploadPaths(now)).toEqual(["fresh.md"]);
	});
});

describe("one upload notice block", () => {
	test("stuck files: one block with the stuck count and the rest as 'more'", () => {
		expect(uploadNotice(5, 3)).toEqual({ kind: "stuck", stuck: 3, more: 2 });
		expect(uploadNotice(3, 3)).toEqual({ kind: "stuck", stuck: 3, more: 0 });
	});

	test("nothing stuck: the plain pending count, or no block at all", () => {
		expect(uploadNotice(4, 0)).toEqual({ kind: "pending", count: 4 });
		expect(uploadNotice(0, 0)).toBeNull();
	});
});
