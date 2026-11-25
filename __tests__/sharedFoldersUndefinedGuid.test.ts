/**
 * GH #116: a share with an undefined guid was persisted to data.json as
 * `{guid: "undefined", path}` next to the real record.
 *
 * The plugin's share factory addressed the folder's settings slice as
 * `sharedFolders/[guid=${guid}]`; an undefined guid became the string
 * "undefined", SettingsScope matched no entry and appended a new one.
 *
 * These tests run the real Settings + SettingsScope + ShareRegistry against
 * an in-memory data.json and assert on what is actually saved. The factory
 * below performs the same unguarded settings write the plugin's factory did
 * before the fix, so this file imports nothing added by the fix and runs
 * red against the pre-fix `src/` (the registry guard and the load-time
 * cleanup are what turn it green).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { MockClock } from "./mocks/MockClock";
import { Settings, SettingsScope } from "../src/SettingsPersistence";
import { NotificationDispatcher } from "../src/notifiers/NotificationDispatcher";
import { ShareRegistry, type VaultShareSettings } from "../src/VaultShare";
import { TFolder } from "./mocks/obsidian";

type FolderBuilder = ConstructorParameters<typeof ShareRegistry>[2];

const VALID_GUID = "3f1c2a8e-1111-4111-8111-111111111111";
const OTHER_GUID = "3f1c2a8e-2222-4222-8222-222222222222";

class MemoryStorage {
	data: Record<string, unknown> | null = null;
	saves = 0;
	async loadData() {
		return this.data;
	}
	async saveData(data: Record<string, unknown>) {
		this.saves++;
		this.data = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
	}
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeVault(paths: string[]) {
	return {
		getAbstractFileByPath: (p: string) => (paths.includes(p) ? new TFolder(p) : null),
		getRoot: () => new TFolder("/"),
	};
}

async function setup(initial: VaultShareSettings[]) {
	const storage = new MemoryStorage();
	storage.data = { sharedFolders: initial };
	const settings = new Settings<Record<string, unknown>>(storage, {});
	await settings.hydrate();
	storage.saves = 0;
	const root = settings as unknown as Settings<unknown>;
	const persisted = new SettingsScope<VaultShareSettings[]>(root, "sharedFolders");
	const factory = jest.fn<FolderBuilder>((path, guid, workspaceId) => {
		// The pre-fix factory write: guid interpolated into the path unchecked.
		const scope = new SettingsScope<VaultShareSettings>(root, `sharedFolders/[guid=${guid}]`);
		void scope.mutateValue(
			(current) => ({ ...current, path, guid, ...(workspaceId ? { relay: workspaceId } : {}) }),
			true,
		);
		return { path, entityGuid: guid, dismantle: () => {} } as never;
	});
	const registry = new ShareRegistry(
		{} as never,
		makeVault(["Team/X", "Team/Y"]) as never,
		factory,
		persisted,
	);
	return { storage, registry, factory };
}

function saved(storage: MemoryStorage): VaultShareSettings[] {
	return (storage.data?.sharedFolders ?? []) as VaultShareSettings[];
}

beforeEach(() => {
	NotificationDispatcher.shutdown();
	// @ts-ignore - private constructor, same setup as TestSettingsBackend
	NotificationDispatcher["current"] = new NotificationDispatcher(new MockClock());
	NotificationDispatcher["_shutDown"] = false;
});

describe("ShareRegistry.new() never persists a guid \"undefined\" record (GH #116)", () => {
	const existing: VaultShareSettings = { guid: VALID_GUID, path: "Team/X", relay: "relay-onprem" };

	test("control: a valid guid adds exactly one record", async () => {
		const { storage, registry } = await setup([existing]);
		registry.new("Team/Y", OTHER_GUID, "relay-onprem");
		await flush();
		const records = saved(storage);
		expect(records).toHaveLength(2);
		expect(records.map((r) => r.guid).sort()).toEqual([VALID_GUID, OTHER_GUID].sort());
	});

	test("an undefined guid is refused before the factory writes anything", async () => {
		const { storage, registry, factory } = await setup([existing]);
		let thrown: unknown;
		try {
			registry.new("Team/X", undefined as unknown as string, "relay-onprem");
		} catch (e) {
			thrown = e;
		}
		await flush();
		expect(saved(storage)).toEqual([existing]);
		expect(storage.saves).toBe(0);
		expect(factory).not.toHaveBeenCalled();
		expect(String(thrown)).toMatch(/no valid share id/);
	});
});

describe("restore() removes stored guid \"undefined\" records (GH #116)", () => {
	const valid: VaultShareSettings = { guid: VALID_GUID, path: "Team/X", relay: "relay-onprem" };

	test("the junk record is dropped from data.json, the valid sibling survives and restores", async () => {
		const { storage, registry, factory } = await setup([valid, { path: "Team/X", guid: "undefined" }]);
		registry.restore();
		await flush();
		const records = saved(storage);
		expect(records).toEqual([valid]);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(factory).toHaveBeenCalledWith("Team/X", VALID_GUID, "relay-onprem", undefined, true, undefined);
	});

	test("control: without junk records restore() keeps sharedFolders as is", async () => {
		const { storage, registry, factory } = await setup([valid]);
		registry.restore();
		await flush();
		expect(saved(storage)).toEqual([valid]);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	test("other invalid guids are kept for the reconnect warning, only the literal \"undefined\" is removed", async () => {
		const missing = { path: "Team/Y" } as unknown as VaultShareSettings;
		const { storage, registry } = await setup([missing, { path: "Team/X", guid: "undefined" }]);
		registry.restore();
		await flush();
		expect(saved(storage)).toEqual([missing]);
	});
});
