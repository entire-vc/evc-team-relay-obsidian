/**
 * Tests for TenantRegistry — root-cause confirmation.
 *
 * This build (see esbuild.config.mjs: apiUrl = authUrl = "") compiles no
 * legacy cloud backend URL at all — it's relay-onprem only. The only
 * way resolveApiUrl()/resolveAuthUrl() return a non-empty value is a
 * successfully validated custom tenant. These tests pin that default-empty
 * behavior, which is the precondition for the finding (AuthSession
 * falling through to `new PocketBase("")` when relay-onprem is disabled).
 */

import { describe, test, expect } from "@jest/globals";
import { TenantRegistry } from "../src/TenantRegistry";
import type { SettingsScope } from "../src/SettingsPersistence";
import type { TenantSettings } from "../src/TenantRegistry";

// TenantRegistry's constructor stores `settings` but resolveApiUrl()/
// resolveAuthUrl()/resolveDefaultUrls() never read it — a minimal stub is
// enough for these tests.
const fakeSettings = {} as unknown as SettingsScope<TenantSettings>;

describe("TenantRegistry — compiled URL defaults", () => {
	test("resolveApiUrl() is empty by default — no legacy cloud backend compiled into this build", () => {
		const manager = new TenantRegistry(fakeSettings);
		expect(manager.resolveApiUrl()).toBe("");
	});

	test("resolveAuthUrl() is empty by default — no legacy cloud backend compiled into this build", () => {
		const manager = new TenantRegistry(fakeSettings);
		expect(manager.resolveAuthUrl()).toBe("");
	});

	test("resolveDefaultUrls() reports both compiled URLs as empty", () => {
		const manager = new TenantRegistry(fakeSettings);
		const defaults = manager.resolveDefaultUrls();
		expect(defaults.apiUrl).toBe("");
		expect(defaults.authUrl).toBe("");
	});
});
