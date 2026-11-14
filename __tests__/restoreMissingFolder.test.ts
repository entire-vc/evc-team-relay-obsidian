/**
 * A share whose folder is missing at startup is restored, not dropped: it is
 * listed with `folderMissing=true` ("Folder not found": Re-link, Recreate,
 * Remove) and stays dormant -- no connection, no sync pass, no upload, no
 * claim pruning -- until a folder backs it again. Before, `_restoreFrom`
 * skipped such a record with a warning, so the share left the UI while its
 * record stayed in data.json and Re-link could never be reached.
 *
 * Runs the real `ShareRegistry.restore()` and the real `VaultShare`
 * constructor; only the network side (provider connect, transfer queue,
 * credential cache) is stubbed and watched.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import "fake-indexeddb/auto";
import { TFile, TFolder, type TAbstractFile } from "obsidian";
import { ShareRegistry, VaultShare, type VaultShareSettings } from "../src/VaultShare";
import { ProviderBacked } from "../src/ProviderBacked";
import { Settings, SettingsScope } from "../src/SettingsPersistence";

const MockFile = TFile as unknown as new (path: string) => TFile;
const MockFolder = TFolder as unknown as new (path: string, children?: TAbstractFile[]) => TFolder;
const GUID = "33333333-3333-4333-8333-333333333333";

/** Vault of mock TFolder/TFile nodes; `addFolder` simulates Recreate. */
function makeVault(tree: Record<string, string[]>) {
	const nodes = new Map<string, TAbstractFile>();
	const addFolder = (folderPath: string, files: string[] = []) => {
		const folder = new MockFolder(folderPath, files.map((f) => new MockFile(`${folderPath}/${f}`)));
		nodes.set(folderPath, folder);
		for (const child of folder.children) nodes.set(child.path, child);
		return folder;
	};
	for (const [folderPath, files] of Object.entries(tree)) addFolder(folderPath, files);
	nodes.set("/", new MockFolder("/", []));
	return {
		addFolder,
		getAbstractFileByPath: (p: string) => nodes.get(p) ?? null,
		getAllLoadedFiles: () => [...nodes.values()],
		getRoot: () => new MockFolder("", []),
		adapter: {},
	};
}

class MemoryStorage<T> {
	private json: string | null = null;
	async loadData(): Promise<T | null> {
		return this.json === null ? null : (JSON.parse(this.json) as T);
	}
	async saveData(data: T): Promise<void> {
		this.json = JSON.stringify(data);
	}
}

interface Root {
	sharedFolders: VaultShareSettings[];
}

async function setup(records: VaultShareSettings[], tree: Record<string, string[]>) {
	const settings = new Settings<Root>(new MemoryStorage<Root>(), { sharedFolders: records });
	await settings.hydrate();
	const vault = makeVault(tree);
	const transfers = {
		enqueueUpload: jest.fn(async () => {}),
		enqueueShareUpload: jest.fn(),
	};
	const auth = {
		isAuthenticated: true,
		isLoggedInToServer: () => true,
		getCurrentUserForServer: () => undefined,
		on: () => () => {},
	};
	const credentials = { peekToken: () => undefined };
	const localStorage = new Map<string, unknown>();
	const app = {
		loadLocalStorage: (k: string) => localStorage.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => localStorage.set(k, v),
	};
	const factory = (
		path: string,
		guid: string,
		workspaceId?: string,
		hasPendingUpdates?: boolean,
		isRestore?: boolean,
		freshlyCreated?: boolean,
	) =>
		new VaultShare(
			"test-app",
			guid,
			path,
			auth as never,
			vault as never,
			{} as never,
			credentials as never,
			{} as never,
			{} as never,
			transfers as never,
			new SettingsScope<VaultShareSettings>(
				settings as unknown as Settings<unknown>,
				`sharedFolders/[guid=${guid}]`,
			),
			app as never,
			workspaceId,
			hasPendingUpdates,
			isRestore,
			freshlyCreated,
		);
	const registry = new ShareRegistry(
		{} as never,
		vault as never,
		factory,
		new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders"),
	);
	return { settings, vault, transfers, registry, localStorage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits for the async local-store load the startup sequence goes through. */
async function eventually(check: () => boolean, ms = 2000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

type Internals = { _onReady(): Promise<void>; awaitFolderTreeReady(): Promise<boolean> };

describe("restore of a share whose folder is missing", () => {
	let connect: jest.SpiedFunction<typeof ProviderBacked.prototype.bringOnline>;
	// Behind the gates: the startup sequence and the first step of every sync pass.
	let startup: jest.SpiedFunction<Internals["_onReady"]>;
	let syncPass: jest.SpiedFunction<Internals["awaitFolderTreeReady"]>;
	const shares: VaultShare[] = [];

	beforeEach(() => {
		connect = jest.spyOn(ProviderBacked.prototype, "bringOnline").mockResolvedValue(false);
		const proto = VaultShare.prototype as unknown as Internals;
		startup = jest.spyOn(proto, "_onReady").mockResolvedValue(undefined);
		// The first-sync wait on the server (30 s timeout offline) resolves at once.
		jest.spyOn(VaultShare.prototype, "awaitReady").mockImplementation(function (this: VaultShare) {
			return Promise.resolve(this);
		});
		syncPass = jest.spyOn(proto, "awaitFolderTreeReady").mockResolvedValue(false);
	});

	afterEach(() => {
		for (const s of shares.splice(0)) s?.dismantle();
		jest.restoreAllMocks();
	});

	test("is listed with folderMissing=true and nothing connects, syncs or uploads", async () => {
		const { registry, transfers, localStorage } = await setup(
			[{ guid: GUID, path: "Gone", relay: "relay-onprem" }],
			{ Other: ["x.md"] },
		);
		// A claim waiting for upload: a dormant share must not prune it.
		const claimsKey = `test-app-evc-team-relay/folders/${GUID}/pendingUploads`;
		localStorage.set(claimsKey, { "note.md": "g-note" });

		registry.restore();
		const share = registry.locate((s) => s.entityGuid === GUID);
		expect(share).toBeDefined();
		shares.push(share!);
		expect(share!.folderMissing).toBe(true);
		expect(share!.isDormant).toBe(true);

		// Every way a sync starts is refused while the folder is missing.
		expect(await share!.bringOnline()).toBe(false);
		await share!.refreshFromServer();
		await share!.syncNow();
		await share!.retryPendingUploads();
		await share!.claimAndUploadFile(new MockFile("Gone/new.md"));
		// Long enough for the local store to load, which a started share waits on.
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(connect).not.toHaveBeenCalled();
		expect(startup).not.toHaveBeenCalled();
		expect(syncPass).not.toHaveBeenCalled();
		expect(transfers.enqueueUpload).not.toHaveBeenCalled();
		expect(transfers.enqueueShareUpload).not.toHaveBeenCalled();
		expect(localStorage.get(claimsKey)).toEqual({ "note.md": "g-note" });
	});

	test("re-link points the record at the new folder, brings its files into scope and starts the share", async () => {
		const { registry, settings } = await setup(
			[{ guid: GUID, path: "Gone", relay: "relay-onprem" }],
			{ New: ["a.md", "b.md"] },
		);
		registry.restore();
		const share = registry.locate((s) => s.entityGuid === GUID)!;
		shares.push(share);
		expect(share.isDormant).toBe(true);

		registry.relink(share, "New");
		await flush();

		expect(share.path).toBe("New");
		expect(settings.snapshot().sharedFolders.find((f) => f.guid === GUID)?.path).toBe("New");
		expect(share.folderMissing).toBe(false);
		expect(share.isDormant).toBe(false);
		const inScope = (share as unknown as { vaultFilesInScope(): TAbstractFile[] })
			.vaultFilesInScope()
			.map((f) => f.path)
			.sort();
		expect(inScope).toEqual(["New/a.md", "New/b.md"]);
		// Started like any restored share: it connects (the user is logged in).
		await eventually(() => connect.mock.calls.length > 0 && startup.mock.calls.length > 0);
	});

	test("recreating the folder at its path starts the share without a restart", async () => {
		const { registry, vault } = await setup(
			[{ guid: GUID, path: "Gone", relay: "relay-onprem" }],
			{},
		);
		registry.restore();
		const share = registry.locate((s) => s.entityGuid === GUID)!;
		shares.push(share);

		expect(registry.wakeAt("Gone")).toBeNull(); // still no folder
		expect(share.isDormant).toBe(true);

		vault.addFolder("Gone");
		expect(registry.wakeAt("Gone")).toBe(share);
		await flush();
		expect(share.isDormant).toBe(false);
		expect(share.folderMissing).toBe(false);
		await eventually(() => connect.mock.calls.length > 0 && startup.mock.calls.length > 0);
	});

	test("a share whose folder exists starts as before (control)", async () => {
		const { registry } = await setup(
			[{ guid: GUID, path: "Here", relay: "relay-onprem" }],
			{ Here: ["a.md"] },
		);
		registry.restore();
		const share = registry.locate((s) => s.entityGuid === GUID)!;
		shares.push(share);
		expect(share.isDormant).toBeFalsy();
		await eventually(() => connect.mock.calls.length > 0 && startup.mock.calls.length > 0);
	});

	test("a record with an invalid guid is still not restored", async () => {
		const { registry } = await setup(
			[{ guid: "undefined", path: "Gone", relay: "relay-onprem" }],
			{},
		);
		registry.restore();
		expect(registry.toArray()).toHaveLength(0);
	});
});
