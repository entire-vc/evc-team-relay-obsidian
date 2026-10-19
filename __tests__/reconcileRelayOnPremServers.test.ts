/**
 * Regression test for (hardening follow-up to /):
 * the "updated servers" branch of main.ts's relayOnPremSettings.subscribe()
 * handler used to replace EVERY previously-known server's RelayOnPremTokenProvider
 * on every settings write, with no comparison against the server's previous
 * controlPlaneUrl/name — pre multi-server this replacement was gated
 * on `newDefaultServer.controlPlaneUrl !== tokenProviderControlPlaneUrl`, and
 * that guard was lost when the single-provider code became N-provider code.
 *
 * The reconciliation logic itself now lives in reconcileRelayOnPremServers.ts
 * as a small pure function specifically so it's unit-testable without
 * constructing the plugin (main.ts's onload() needs a full Obsidian App,
 * which nothing in this test suite currently mocks).
 */

import { describe, test, expect } from "@jest/globals";
import {
	diffRelayOnPremServers,
	snapshotRelayOnPremServers,
} from "../src/relay/reconcileRelayOnPremServers";
import type { RelayOnPremServer } from "../src/RelayOnPremConfig";

function server(id: string, controlPlaneUrl: string, name = id): RelayOnPremServer {
	return { id, name, controlPlaneUrl } as RelayOnPremServer;
}

describe("diffRelayOnPremServers", () => {
	test("two consecutive diffs with no URL/name change produce zero updates", () => {
		const a = server("s1", "https://cp-a.example.com");
		let prev = snapshotRelayOnPremServers([a]);

		// First "settings write" — nothing actually changed about s1 (e.g. a
		// different server's default flag was toggled).
		const diff1 = diffRelayOnPremServers(prev, [a]);
		expect(diff1.updated).toHaveLength(0);
		expect(diff1.added).toHaveLength(0);
		expect(diff1.removedIds).toHaveLength(0);
		prev = snapshotRelayOnPremServers([a]);

		// Second write, same object shape again.
		const diff2 = diffRelayOnPremServers(prev, [server("s1", "https://cp-a.example.com")]);
		expect(diff2.updated).toHaveLength(0);
	});

	test("a controlPlaneUrl change produces exactly one update, for that server only", () => {
		const s1 = server("s1", "https://cp-a.example.com");
		const s2 = server("s2", "https://cp-b.example.com");
		const prev = snapshotRelayOnPremServers([s1, s2]);

		const s1Changed = server("s1", "https://cp-a-NEW.example.com");
		const diff = diffRelayOnPremServers(prev, [s1Changed, s2]);

		expect(diff.updated).toHaveLength(1);
		expect(diff.updated[0].id).toBe("s1");
		expect(diff.updated[0].controlPlaneUrl).toBe("https://cp-a-NEW.example.com");
		expect(diff.added).toHaveLength(0);
		expect(diff.removedIds).toHaveLength(0);
	});

	test("a name-only change also counts as updated", () => {
		const s1 = server("s1", "https://cp-a.example.com", "Old Name");
		const prev = snapshotRelayOnPremServers([s1]);

		const renamed = server("s1", "https://cp-a.example.com", "New Name");
		const diff = diffRelayOnPremServers(prev, [renamed]);

		expect(diff.updated).toHaveLength(1);
		expect(diff.updated[0].name).toBe("New Name");
	});

	test("a brand-new server id is 'added', not 'updated'", () => {
		const prev = snapshotRelayOnPremServers([]);
		const s1 = server("s1", "https://cp-a.example.com");

		const diff = diffRelayOnPremServers(prev, [s1]);

		expect(diff.added).toEqual([s1]);
		expect(diff.updated).toHaveLength(0);
	});

	test("a server missing from the current list is 'removed'", () => {
		const s1 = server("s1", "https://cp-a.example.com");
		const prev = snapshotRelayOnPremServers([s1]);

		const diff = diffRelayOnPremServers(prev, []);

		expect(diff.removedIds).toEqual(["s1"]);
		expect(diff.updated).toHaveLength(0);
	});
});
