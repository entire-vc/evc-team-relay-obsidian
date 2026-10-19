/**
 * Focus: — updateServer() must clear stored auth for a server whose
 * control-plane URL changed, so a recreated provider under the same id
 * doesn't restore and forward the OLD host's token to the NEW host.
 *
 * Split into its own file (2026-07-25 rebase, sibling PR#78/landed a
 * separate MultiServerAuthManager.test.ts that constructs REAL
 * RelayOnPremAuthProvider/RelayOnPremAuthStore instances) — this file's
 * module-level jest.mock() of both would otherwise silently swap out the
 * real providers 's tests depend on, since jest.mock() applies
 * file-wide. See MultiServerAuthManager.integration.test.ts for the
 * complementary unmocked proof that clearing actually reaches the instance
 * a recreated provider reads through, not just that `.evict()` was called.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
}));

const mockEvict = jest.fn();
const mockAuthStoreInstance = { evict: mockEvict };
jest.mock("../../src/auth/RelayOnPremAuthStore", () => ({
	RelayOnPremAuthStore: jest.fn().mockImplementation(() => mockAuthStoreInstance),
	// MultiServerAuthManager uses the shared singleton (fix), not `new`.
	getAuthStore: jest.fn(() => mockAuthStoreInstance),
}));

const mockGetControlPlaneUrl = jest.fn();
const mockGetServerId = jest.fn();
jest.mock("../../src/auth/RelayOnPremAuthProvider", () => ({
	RelayOnPremAuthProvider: jest.fn().mockImplementation((config: { controlPlaneUrl: string; serverId: string }) => ({
		getControlPlaneUrl: () => mockGetControlPlaneUrl(config),
		getServerId: () => mockGetServerId(config),
	})),
}));

import { MultiServerAuthManager } from "../../src/auth/MultiServerAuthManager";
import type { RelayOnPremServer } from "../../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.example.com",
		isValidated: true,
		...overrides,
	};
}

describe("MultiServerAuthManager.updateServer", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Each new mocked provider reports back whatever controlPlaneUrl it was constructed with.
		mockGetControlPlaneUrl.mockImplementation((config: { controlPlaneUrl: string }) => config.controlPlaneUrl);
	});

	test("clears stored auth when the URL changes", () => {
		const manager = new MultiServerAuthManager("vault", [
			makeServer({ id: "server-1", controlPlaneUrl: "https://old-host.example.com" }),
		]);
		mockEvict.mockClear();

		manager.updateServer(makeServer({ id: "server-1", controlPlaneUrl: "https://new-host.example.com" }));

		expect(mockEvict).toHaveBeenCalledWith("server-1");
	});

	test("does NOT clear stored auth when the URL is unchanged (e.g. renaming a server)", () => {
		const manager = new MultiServerAuthManager("vault", [
			makeServer({ id: "server-1", controlPlaneUrl: "https://cp.example.com" }),
		]);
		mockEvict.mockClear();

		manager.updateServer(makeServer({ id: "server-1", controlPlaneUrl: "https://cp.example.com", name: "Renamed" }));

		expect(mockEvict).not.toHaveBeenCalled();
	});

	test("treats a trailing-slash-only difference as unchanged", () => {
		const manager = new MultiServerAuthManager("vault", [
			makeServer({ id: "server-1", controlPlaneUrl: "https://cp.example.com" }),
		]);
		mockEvict.mockClear();

		manager.updateServer(makeServer({ id: "server-1", controlPlaneUrl: "https://cp.example.com/" }));

		expect(mockEvict).not.toHaveBeenCalled();
	});

	test("does not clear when updating a server that has no existing provider", () => {
		const manager = new MultiServerAuthManager("vault", []);
		mockEvict.mockClear();

		manager.updateServer(makeServer({ id: "server-1", controlPlaneUrl: "https://cp.example.com" }));

		expect(mockEvict).not.toHaveBeenCalled();
	});

	test("recreates the provider under the same id after a URL change", () => {
		const manager = new MultiServerAuthManager("vault", [
			makeServer({ id: "server-1", controlPlaneUrl: "https://old-host.example.com" }),
		]);

		manager.updateServer(makeServer({ id: "server-1", controlPlaneUrl: "https://new-host.example.com" }));

		expect(manager.getProvider("server-1")?.getControlPlaneUrl()).toBe("https://new-host.example.com");
	});
});
