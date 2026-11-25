/**
 * GH #116: bindVaultShareSettings is the settings write behind the plugin's
 * share factory. It must refuse an invalid guid before it builds the
 * `sharedFolders/[guid=…]` scope, otherwise the guid lands in data.json as
 * the string "undefined" next to the real record.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import { MockClock } from "./mocks/MockClock";
import { Settings } from "../src/SettingsPersistence";
import { NotificationDispatcher } from "../src/notifiers/NotificationDispatcher";
import type { VaultShareSettings } from "../src/VaultShare";
import { bindVaultShareSettings, withoutUndefinedGuidShares } from "../src/vaultShareSettings";

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

async function setup(initial: VaultShareSettings[]) {
	const storage = new MemoryStorage();
	storage.data = { sharedFolders: initial };
	const settings = new Settings<Record<string, unknown>>(storage, {});
	await settings.hydrate();
	storage.saves = 0;
	return { storage, root: settings as unknown as Settings<unknown> };
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

describe("bindVaultShareSettings (GH #116)", () => {
	const existing: VaultShareSettings = { guid: VALID_GUID, path: "Team/X", relay: "relay-onprem" };

	test("control: a valid guid writes one record with path, guid and relay", async () => {
		const { storage, root } = await setup([existing]);
		bindVaultShareSettings(root, "Team/Y", OTHER_GUID, "relay-onprem");
		await flush();
		const records = saved(storage);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({ guid: OTHER_GUID, path: "Team/Y", relay: "relay-onprem" });
	});

	test.each([undefined, "", "undefined", "not-a-uuid"])("refuses guid %p before writing", async (guid) => {
		const { storage, root } = await setup([existing]);
		expect(() =>
			bindVaultShareSettings(root, "Team/X", guid as unknown as string, "relay-onprem"),
		).toThrow(/no valid share id/);
		await flush();
		expect(storage.saves).toBe(0);
		expect(saved(storage)).toEqual([existing]);
	});
});

describe("withoutUndefinedGuidShares (GH #116)", () => {
	test("drops only the literal \"undefined\" guid", () => {
		const missing = { path: "Team/Y" } as unknown as VaultShareSettings;
		const valid: VaultShareSettings = { guid: VALID_GUID, path: "Team/X" };
		expect(
			withoutUndefinedGuidShares([valid, { guid: "undefined", path: "Team/X" }, missing]),
		).toEqual([valid, missing]);
	});
});
