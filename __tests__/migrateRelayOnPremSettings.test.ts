import { describe, test, expect } from "@jest/globals";
import {
	migrateRelayOnPremSettings,
	DEFAULT_RELAY_ONPREM_SETTINGS,
	EVC_SERVER_ID,
	EVC_CP_URL,
	TR_RU_SERVER_ID,
	TR_RU_CP_URL,
} from "../src/RelayOnPremConfig";
import type { RelayOnPremServer, RelayOnPremSettings } from "../src/RelayOnPremConfig";

// Requirement: the second server is only for new users.
// (the second default server is for NEW installs only). The fix is a single
// entry added to DEFAULT_RELAY_ONPREM_SETTINGS.servers — no new migration
// branch. These tests prove that decision holds: a fresh install gets both
// servers, an established install gets neither more nor fewer servers than
// it already had, and a user's own custom server is never touched.

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.tr.entire.vc",
		isValidated: true,
		...overrides,
	};
}

function makeSettings(
	servers: RelayOnPremServer[],
	overrides: Partial<RelayOnPremSettings> = {}
): RelayOnPremSettings {
	return {
		enabled: true,
		servers,
		...overrides,
	};
}

describe("migrateRelayOnPremSettings — fresh install", () => {
	test("undefined settings (no data.json) get BOTH default servers", () => {
		const result = migrateRelayOnPremSettings(undefined);
		expect(result.changed).toBe(true);
		expect(result.settings.servers).toHaveLength(2);
		expect(result.settings.servers.map((s) => s.id)).toEqual([EVC_SERVER_ID, TR_RU_SERVER_ID]);
	});

	test("null settings get BOTH default servers", () => {
		const result = migrateRelayOnPremSettings(null);
		expect(result.settings.servers).toHaveLength(2);
	});

	test("defaultServerId stays on the EVC server, not the new RU one", () => {
		const result = migrateRelayOnPremSettings(undefined);
		expect(result.settings.defaultServerId).toBe(EVC_SERVER_ID);
	});

	test("the RU server has the expected id/name/url", () => {
		const result = migrateRelayOnPremSettings(undefined);
		const ru = result.settings.servers.find((s) => s.id === TR_RU_SERVER_ID);
		expect(ru).toBeDefined();
		expect(ru?.name).toBe("Team Relay RU");
		expect(ru?.controlPlaneUrl).toBe(TR_RU_CP_URL);
		expect(ru?.isValidated).toBe(false);
	});

	test("matches DEFAULT_RELAY_ONPREM_SETTINGS exactly", () => {
		const result = migrateRelayOnPremSettings(undefined);
		expect(result.settings).toEqual(DEFAULT_RELAY_ONPREM_SETTINGS);
	});
});

describe("migrateRelayOnPremSettings — established install (servers[] already present)", () => {
	test("REGRESSION: an install with only EVC configured does NOT gain the RU server", () => {
		// This is the requirement, not just "didn't break": the decision was
		// explicitly "new users only" — an established EVC-only install must
		// stay at exactly one server after migration.
		const existing = makeSettings(
			[makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL })],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers).toHaveLength(1);
		expect(result.settings.servers[0].id).toBe(EVC_SERVER_ID);
		expect(result.settings.servers.some((s) => s.id === TR_RU_SERVER_ID)).toBe(false);
	});

	test("nothing changes for an already-normalized EVC-only install (changed === false)", () => {
		const existing = makeSettings(
			[makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL })],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.changed).toBe(false);
	});

	test("a user's own custom server (unrelated id and URL) is preserved untouched", () => {
		const custom = makeServer({
			id: "my-custom-relay",
			name: "My Custom Relay",
			controlPlaneUrl: "https://relay.example.org",
			isValidated: true,
			lastUserEmail: "me@example.org",
		});
		const existing = makeSettings(
			[
				makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL }),
				custom,
			],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers).toHaveLength(2);
		const survived = result.settings.servers.find((s) => s.id === "my-custom-relay");
		expect(survived).toEqual(custom);
	});

	test("a custom server with no EVC server present yet still gets EVC prepended, RU is NOT added", () => {
		const custom = makeServer({
			id: "my-custom-relay",
			name: "My Custom Relay",
			controlPlaneUrl: "https://relay.example.org",
		});
		const existing = makeSettings([custom]);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers.map((s) => s.id)).toEqual([EVC_SERVER_ID, "my-custom-relay"]);
	});
});

describe("migrateRelayOnPremSettings — idempotency", () => {
	test("running migration on its own fresh-install output a second time makes no further changes", () => {
		const first = migrateRelayOnPremSettings(undefined);
		expect(first.changed).toBe(true);

		const second = migrateRelayOnPremSettings(first.settings);
		expect(second.changed).toBe(false);
		expect(second.settings.servers).toEqual(first.settings.servers);
		expect(second.settings.defaultServerId).toBe(first.settings.defaultServerId);
	});
});
