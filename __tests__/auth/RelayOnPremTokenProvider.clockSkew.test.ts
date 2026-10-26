/**
 * The control-plane returns `expires_at` as an absolute server
 * time, and every consumer (CredentialCache.needsRefresh/tokenIsValid,
 * ProviderBacked.hasUsableProviderToken) compares it with the client's own
 * clock. A client whose clock lags the server by S > renewal margin (60s)
 * kept treating a dead relay token as live for S-60s and dialled the WS
 * handshake with it — the 1-10s overshoot peak of 401 "expired" in prod.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
	RelayOnPremTokenProvider,
	type RelayTokenResponse,
	type FileTokenApiResponse,
} from "../../src/auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { CredentialCache } from "../../src/CredentialCache";
import type { DocumentGrant } from "../../src/relay/TokenShapes";
import { MockClock } from "../mocks/MockClock";

jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
	instanceLabels: new WeakMap(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/platformFetch");
import { platformFetch } from "../../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

const SECOND_MS = 1000;
const TTL_MS = 300 * SECOND_MS; // relay_token_ttl_minutes=5
const CLIENT_LAG_MS = 70 * SECOND_MS;
// A whole-second instant so the HTTP Date header round-trips exactly.
const SERVER_START_MS = Date.UTC(2026, 9, 27, 12, 0, 0);

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

// The server's clock is the client's plus CLIENT_LAG_MS; every response
// carries the server's Date header and an expires_at TTL_MS after it.
function serverResponse<T>(body: (serverNow: number) => T, dateHeader = true): Promise<Response> {
	const serverNow = Date.now() + CLIENT_LAG_MS;
	const data = body(serverNow);
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
		headers: new Headers(dateHeader ? { date: new Date(serverNow).toUTCString() } : {}),
	} as Response);
}

function relayTokenBody(serverNow: number): RelayTokenResponse {
	return {
		relay_url: "wss://relay.example.com",
		token: `relay-token-${serverNow}`,
		expires_at: new Date(serverNow + TTL_MS).toISOString(),
	};
}

describe("relay token expiry vs a lagging client clock", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(SERVER_START_MS - CLIENT_LAG_MS);
		mockFetch.mockReset();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("the cache re-issues instead of serving a token already expired on the server", async () => {
		mockFetch.mockImplementation(() => serverResponse(relayTokenBody));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});
		const clock = new MockClock();
		clock.setTime(Date.now());
		let issued = 0;
		const cache = new CredentialCache<DocumentGrant>(
			{
				logMessage: () => undefined,
				refreshToken: (_documentId, onSuccess, onError) => {
					issued++;
					provider.requestToken("relay1", "folder1", "doc1", "write").then(onSuccess, onError);
				},
				getClock: () => clock,
				getTokenExpiry: (grant) => grant.expiryTime ?? 0,
			},
			1,
		);

		const first = cache.acquireToken("doc1", "doc1", () => undefined);
		await jest.advanceTimersByTimeAsync(0);
		await first;
		expect(issued).toBe(1);

		// Server time is now expires_at + 5s: the server rejects this token.
		const serverExpiredPlus5 = SERVER_START_MS + TTL_MS + 5 * SECOND_MS;
		jest.setSystemTime(serverExpiredPlus5 - CLIENT_LAG_MS);
		clock.setTime(Date.now());

		const second = cache.acquireToken("doc1", "doc1", () => undefined);
		await jest.advanceTimersByTimeAsync(0);
		await second;
		expect(issued).toBe(2); // re-issued, not served from cache
		provider.destroy();
	});

	test("expiryTime keeps the server-granted lifetime on the local clock", async () => {
		mockFetch.mockImplementation(() => serverResponse(relayTokenBody));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const pending = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		const grant = await pending;

		const remaining = (grant.expiryTime ?? 0) - Date.now();
		expect(remaining).toBeLessThanOrEqual(TTL_MS);
		expect(remaining).toBeGreaterThanOrEqual(TTL_MS - 2 * SECOND_MS);
		provider.destroy();
	});

	test("file tokens are re-anchored the same way", async () => {
		mockFetch.mockImplementation(() =>
			serverResponse<FileTokenApiResponse>((serverNow) => ({
				token: "file-token",
				base_url: "https://cp.example.com/files/x",
				expires_at: new Date(serverNow + TTL_MS).toISOString(),
			})),
		);
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const grant = await provider.requestFileToken("relay1", "folder1", "file1", "hash", "text/plain", 1);

		const remaining = (grant.expiryTime ?? 0) - Date.now();
		expect(remaining).toBeLessThanOrEqual(TTL_MS);
		expect(remaining).toBeGreaterThanOrEqual(TTL_MS - 2 * SECOND_MS);
		provider.destroy();
	});

	test("an explicit expires_in wins over expires_at and the Date header", async () => {
		mockFetch.mockImplementation(() =>
			serverResponse((serverNow) => ({ ...relayTokenBody(serverNow), expires_in: 120 }), false),
		);
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const pending = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		const grant = await pending;

		expect((grant.expiryTime ?? 0) - Date.now()).toBe(119 * SECOND_MS);
		provider.destroy();
	});

	test("without a Date header the server's expires_at is used as before", async () => {
		mockFetch.mockImplementation(() => serverResponse(relayTokenBody, false));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const pending = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		const grant = await pending;

		expect(grant.expiryTime).toBe(SERVER_START_MS + TTL_MS);
		provider.destroy();
	});
});
