/**
 * Regression tests for the multi-server token-routing fix (TR·plugin defect:
 * "CRDT token layer is a plugin-wide singleton — /tokens/relay always goes
 * to the default server's control plane").
 *
 * Before this fix, RelayOnPremTokenProvider was a single instance bound to
 * ONE controlPlaneUrl (the resolved default server), so every relay-onprem
 * document's /tokens/relay request landed on that host regardless of which
 * server the document actually belonged to. RelayCredentialCache now holds one
 * provider per server and resolves the right one per document via the
 * onpremServerId threaded through getToken()/resolveFileToken().
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {},
	instanceLabels: { set: jest.fn() },
}));

jest.mock("../src/platformFetch");
import { platformFetch } from "../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

import { RelayCredentialCache } from "../src/RelayCredentialCache";
import {
	RelayOnPremTokenProvider,
	type RelayTokenResponse,
} from "../src/auth/RelayOnPremTokenProvider";
import { ResourceAddress, RemoteFolderAddress } from "../src/ResourceAddress";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import type { AuthSession } from "../src/AuthSession";
import { MockClock } from "./mocks/MockClock";

function makeAuthProvider(): IAuthProvider {
	return {
		isLoggedIn: () => true,
		getCurrentUser: () => undefined,
		getToken: () => "fake-token",
		getValidToken: async () => "fake-token",
		loginWithPassword: () => Promise.reject(new Error("unused")),
		loginWithOAuth2: () => Promise.reject(new Error("unused")),
		refreshToken: () => Promise.reject(new Error("unused")),
		logout: () => Promise.reject(new Error("unused")),
		isTokenValid: () => true,
	};
}

function mockFetchResponse(data: RelayTokenResponse) {
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
		headers: new Headers(),
	} as Response);
}

const TOKEN_RESPONSE: RelayTokenResponse = {
	relay_url: "wss://relay.example.com",
	token: "relay-token",
	expires_at: new Date(Date.now() + 60_000).toISOString(),
};

// isAuthenticated=false is deliberate: these tests exercise ONLY the relay-onprem
// branch (isRelayOnPremMode=true, gated on the provider map being non-empty),
// which never reads loginManager.isAuthenticated -- a real AuthSession can't be
// constructed here anyway (it transitively pulls in the ESM-only `pocketbase`
// package, which this repo's Jest config can't load).
const fakeLoginManager = { isAuthenticated: false } as unknown as AuthSession;

describe("RelayCredentialCache multi-server token routing", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("a document with a recorded serverId requests its token from THAT server, not the default", async () => {
		const providerA = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-a.example.com",
			authProvider: makeAuthProvider(),
		});
		const providerB = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-b.example.com",
			authProvider: makeAuthProvider(),
		});
		const store = new RelayCredentialCache(
			fakeLoginManager,
			new MockClock(),
			"test-vault",
			5,
			new Map([
				["server-a", providerA],
				["server-b", providerB],
			]),
			undefined,
			"server-a", // default
		);

		const docOnB = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", "11111111-1111-1111-1111-111111111111"));
		const pending = store.getToken(docOnB, "folder-b-path", () => {}, "server-b");
		await jest.advanceTimersByTimeAsync(0);
		await pending;

		expect(mockFetch).toHaveBeenCalledWith(
			"https://server-b.example.com/v1/tokens/relay",
			expect.anything(),
		);
	});

	test("a document with no recorded serverId falls back to the default server's provider", async () => {
		const providerA = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-a.example.com",
			authProvider: makeAuthProvider(),
		});
		const providerB = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-b.example.com",
			authProvider: makeAuthProvider(),
		});
		const store = new RelayCredentialCache(
			fakeLoginManager,
			new MockClock(),
			"test-vault",
			5,
			new Map([
				["server-a", providerA],
				["server-b", providerB],
			]),
			undefined,
			"server-a", // default
		);

		// No 4th arg -- mirrors a legacy folder with no onpremServerId recorded.
		const docWithNoServer = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", "22222222-2222-2222-2222-222222222222"));
		const pending = store.getToken(docWithNoServer, "folder-legacy-path", () => {});
		await jest.advanceTimersByTimeAsync(0);
		await pending;

		expect(mockFetch).toHaveBeenCalledWith(
			"https://server-a.example.com/v1/tokens/relay",
			expect.anything(),
		);
	});

	test("two servers logged in simultaneously: each document's request lands on its OWN control plane, never both on one", async () => {
		const providerA = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-a.example.com",
			authProvider: makeAuthProvider(),
		});
		const providerB = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://server-b.example.com",
			authProvider: makeAuthProvider(),
		});
		const store = new RelayCredentialCache(
			fakeLoginManager,
			new MockClock(),
			"test-vault",
			5,
			new Map([
				["server-a", providerA],
				["server-b", providerB],
			]),
			undefined,
			"server-a",
		);

		const docOnA = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", "33333333-3333-3333-3333-333333333333"));
		const docOnB = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", "11111111-1111-1111-1111-111111111111"));

		const pendingA = store.getToken(docOnA, "folder-a-path", () => {}, "server-a");
		const pendingB = store.getToken(docOnB, "folder-b-path", () => {}, "server-b");
		await jest.advanceTimersByTimeAsync(0);
		await Promise.all([pendingA, pendingB]);

		const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
		expect(calledUrls).toContain("https://server-a.example.com/v1/tokens/relay");
		expect(calledUrls).toContain("https://server-b.example.com/v1/tokens/relay");
		// Negative half of the same assertion: neither request doubled up on
		// the other server's host -- this is the actual bug being fixed.
		expect(
			calledUrls.filter((u) => u === "https://server-a.example.com/v1/tokens/relay").length,
		).toBe(1);
		expect(
			calledUrls.filter((u) => u === "https://server-b.example.com/v1/tokens/relay").length,
		).toBe(1);
	});

	test("regression: a single configured server (pre-multi-server shape) still routes correctly", async () => {
		const onlyProvider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://only-server.example.com",
			authProvider: makeAuthProvider(),
		});
		const store = new RelayCredentialCache(
			fakeLoginManager,
			new MockClock(),
			"test-vault",
			5,
			new Map([["only-server", onlyProvider]]),
			undefined,
			"only-server",
		);

		const doc = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", "44444444-4444-4444-4444-444444444444"));
		const pending = store.getToken(doc, "folder-x-path", () => {}, "only-server");
		await jest.advanceTimersByTimeAsync(0);
		await pending;

		expect(mockFetch).toHaveBeenCalledWith(
			"https://only-server.example.com/v1/tokens/relay",
			expect.anything(),
		);
	});
});
