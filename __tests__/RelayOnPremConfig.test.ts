import { describe, test, expect } from "@jest/globals";
import { withUpdatedLastUserEmail, findDuplicateServer } from "../src/RelayOnPremConfig";
import type { RelayOnPremSettings, RelayOnPremServer } from "../src/RelayOnPremConfig";
import {
	MIN_SUPPORTED_SERVER_VERSION,
	compareSemver,
	isServerVersionSupported,
	serverCompatMessage,
	crossServerAccountNote,
	EVC_SERVER_ID,
	TR_RU_SERVER_ID,
} from "../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.tr.entire.vc",
		isValidated: true,
		...overrides,
	};
}

function makeSettings(servers: RelayOnPremServer[]): RelayOnPremSettings {
	return {
		enabled: true,
		servers,
	};
}

describe("withUpdatedLastUserEmail", () => {
	test("sets lastUserEmail on the matching server", () => {
		const settings = makeSettings([makeServer({ id: "server-1" }), makeServer({ id: "server-2" })]);

		const updated = withUpdatedLastUserEmail(settings, "server-2", "user@example.com");

		expect(updated.servers.find((s) => s.id === "server-2")?.lastUserEmail).toBe(
			"user@example.com"
		);
	});

	test("leaves other servers untouched", () => {
		const settings = makeSettings([
			makeServer({ id: "server-1", lastUserEmail: "existing@example.com" }),
			makeServer({ id: "server-2" }),
		]);

		const updated = withUpdatedLastUserEmail(settings, "server-2", "new@example.com");

		expect(updated.servers.find((s) => s.id === "server-1")?.lastUserEmail).toBe(
			"existing@example.com"
		);
	});

	test("does not mutate the input settings object (safe for SettingsScope.update)", () => {
		const original = makeSettings([makeServer({ id: "server-1" })]);
		const snapshot = JSON.parse(JSON.stringify(original));

		withUpdatedLastUserEmail(original, "server-1", "user@example.com");

		expect(original).toEqual(snapshot);
	});

	test("returns the same settings reference when the server is not found", () => {
		const settings = makeSettings([makeServer({ id: "server-1" })]);

		const updated = withUpdatedLastUserEmail(settings, "does-not-exist", "user@example.com");

		expect(updated).toBe(settings);
	});

	test("preserves other settings fields (defaultServerId)", () => {
		const settings: RelayOnPremSettings = {
			...makeSettings([makeServer({ id: "server-1" })]),
			defaultServerId: "server-1",
		};

		const updated = withUpdatedLastUserEmail(settings, "server-1", "user@example.com");

		expect(updated.defaultServerId).toBe("server-1");
		expect(updated.enabled).toBe(true);
	});
});

describe("findDuplicateServer", () => {
	test("finds a collision on matching generated id (same URL added twice)", () => {
		const existing = [makeServer({ id: "cp-tr-entire-vc-443" })];

		const duplicate = findDuplicateServer(
			existing,
			"cp-tr-entire-vc-443",
			"https://cp.tr.entire.vc"
		);

		expect(duplicate).toBe(existing[0]);
	});

	test("finds a collision on matching URL under a different id", () => {
		const existing = [
			makeServer({ id: "server-custom-id", controlPlaneUrl: "https://cp.tr.entire.vc" }),
		];

		const duplicate = findDuplicateServer(
			existing,
			"cp-tr-entire-vc-443", // freshly generated id, differs from the stored custom id
			"https://cp.tr.entire.vc"
		);

		expect(duplicate).toBe(existing[0]);
	});

	test("matches URLs that differ only by trailing slash or case", () => {
		const existing = [makeServer({ controlPlaneUrl: "https://CP.tr.entire.vc/" })];

		const duplicate = findDuplicateServer(existing, "some-new-id", "https://cp.tr.entire.vc");

		expect(duplicate).toBe(existing[0]);
	});

	test("returns undefined when there's no collision", () => {
		const existing = [makeServer({ id: "server-1", controlPlaneUrl: "https://cp.tr.entire.vc" })];

		const duplicate = findDuplicateServer(
			existing,
			"other-host-443",
			"https://other-host.example.com"
		);

		expect(duplicate).toBeUndefined();
	});

	test("returns undefined against an empty server list", () => {
		expect(findDuplicateServer([], "any-id", "https://cp.tr.entire.vc")).toBeUndefined();
	});
});

/**
 * Tests for RelayOnPremConfig — server version compatibility check.
 *
 * MIN_SUPPORTED_SERVER_VERSION is pinned to the control-plane's current
 * live baseline ("0.1.0", see the constant's own comment), so these tests
 * exercise the comparison logic against synthetic versions rather than
 * asserting on that literal value directly — the floor is expected to move.
 */

describe("compareSemver", () => {
	test("equal versions return 0", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	test("higher major wins regardless of minor/patch", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
	});

	test("higher minor wins when major is equal", () => {
		expect(compareSemver("1.5.0", "1.4.9")).toBeGreaterThan(0);
		expect(compareSemver("1.4.9", "1.5.0")).toBeLessThan(0);
	});

	test("higher patch wins when major and minor are equal", () => {
		expect(compareSemver("1.2.5", "1.2.4")).toBeGreaterThan(0);
		expect(compareSemver("1.2.4", "1.2.5")).toBeLessThan(0);
	});

	test("missing/non-numeric segments are treated as 0", () => {
		expect(compareSemver("1.2", "1.2.0")).toBe(0);
		expect(compareSemver("1", "1.0.0")).toBe(0);
	});

	test("a leading v/V prefix is stripped, not treated as garbage", () => {
		expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("V1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
	});
});

describe("isServerVersionSupported", () => {
	test("a version equal to the floor is supported", () => {
		expect(isServerVersionSupported(MIN_SUPPORTED_SERVER_VERSION)).toBe(true);
	});

	test("a version above the floor is supported", () => {
		const [major, minor, patch] = MIN_SUPPORTED_SERVER_VERSION.split(".").map(Number);
		expect(isServerVersionSupported(`${major}.${minor}.${patch + 1}`)).toBe(true);
		expect(isServerVersionSupported(`${major + 1}.0.0`)).toBe(true);
	});

	test("a version below the floor is NOT supported", () => {
		expect(isServerVersionSupported("0.0.1")).toBe(false);
	});

	test("a missing/empty version is NOT supported (pre-versioning server)", () => {
		expect(isServerVersionSupported(undefined)).toBe(false);
		expect(isServerVersionSupported(null)).toBe(false);
		expect(isServerVersionSupported("")).toBe(false);
	});
});

describe("serverCompatMessage", () => {
	test("mentions the server's reported version and the required floor", () => {
		const msg = serverCompatMessage("0.0.1");
		expect(msg).toContain("0.0.1");
		expect(msg).toContain(MIN_SUPPORTED_SERVER_VERSION);
		expect(msg.toLowerCase()).toContain("update the server");
	});

	test("has a distinct message for a server reporting no version at all", () => {
		const msg = serverCompatMessage(undefined);
		expect(msg.toLowerCase()).toContain("doesn't report a version");
		expect(msg.toLowerCase()).toContain("update the server");
	});
});

describe("crossServerAccountNote", () => {
	test("returns the pairing when both shipped instances are present", () => {
		const evc = makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay" });
		const ru = makeServer({ id: TR_RU_SERVER_ID, name: "Team Relay RU" });

		expect(crossServerAccountNote([evc, ru], EVC_SERVER_ID)).toEqual({
			thisServer: "EVC Team Relay",
			otherServer: "Team Relay RU",
		});
		// Symmetric on the other server too.
		expect(crossServerAccountNote([evc, ru], TR_RU_SERVER_ID)).toEqual({
			thisServer: "Team Relay RU",
			otherServer: "EVC Team Relay",
		});
	});

	test("negative control: a user-added server never gets the note, even alongside both shipped instances", () => {
		const evc = makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay" });
		const ru = makeServer({ id: TR_RU_SERVER_ID, name: "Team Relay RU" });
		const own = makeServer({ id: "my-own-relay", name: "My Own Relay" });

		expect(crossServerAccountNote([evc, ru, own], "my-own-relay")).toBeUndefined();
	});

	test("negative control: only one shipped instance present (pre-second-server install) -- no note", () => {
		const evc = makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay" });

		expect(crossServerAccountNote([evc], EVC_SERVER_ID)).toBeUndefined();
	});

	test("negative control: RU present without EVC -- no note either direction", () => {
		const ru = makeServer({ id: TR_RU_SERVER_ID, name: "Team Relay RU" });

		expect(crossServerAccountNote([ru], TR_RU_SERVER_ID)).toBeUndefined();
	});
});
