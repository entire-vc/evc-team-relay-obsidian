/**
 * A share the signed-in account cannot open (POST /v1/tokens/relay answers
 * 401, or 403 even for read) used to be retried on a fixed short floor
 * forever: bringOnline() failed, rescheduled itself through ReconnectGate,
 * and asked the control plane again (prod log 27.10: one client, 60 x 401
 * per hour, 0 successes). Drives the REAL ProviderBacked + RelayCredentialCache
 * + RelayOnPremTokenProvider; only the network (platformFetch) is faked.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
		protected setLoggers(): void {}
	},
	instanceLabels: { set: jest.fn() },
}));

jest.mock("../src/platformFetch");
import { platformFetch } from "../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

import { ProviderBacked } from "../src/ProviderBacked";
import { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../src/auth/RelayOnPremTokenProvider";
import { RemoteFolderAddress } from "../src/ResourceAddress";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import type { AuthSession } from "../src/AuthSession";
import { MockClock } from "./mocks/MockClock";
import { testGlobal } from "./mocks/testGlobal";

/** A successful token leads to a socket; keep it off the network. */
class FakeWS {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FakeWS.CONNECTING;
	binaryType = "";
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onclose: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	constructor(public url: string) {}
	send(): void {}
	close(): void {
		this.readyState = FakeWS.CLOSED;
	}
}

const G = "55555555-5555-4555-8555-555555555555";
const MINUTE = 60_000;

const authProvider: IAuthProvider = {
	isLoggedIn: () => true,
	getCurrentUser: () => undefined,
	getToken: () => "user-jwt",
	getValidToken: async () => "user-jwt",
	loginWithPassword: () => Promise.reject(new Error("unused")),
	loginWithOAuth2: () => Promise.reject(new Error("unused")),
	refreshToken: () => Promise.reject(new Error("unused")),
	logout: () => Promise.reject(new Error("unused")),
	isTokenValid: () => true,
};

function respond(status: number): Promise<Response> {
	const body = status === 200
		? { relay_url: "wss://relay.example.com", token: "relay-token", expires_at: new Date(Date.now() + 5 * MINUTE).toISOString() }
		: { detail: "Not authenticated" };
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		json: async () => body,
		headers: new Headers(),
	} as Response);
}

function tokenCalls(): number {
	return mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/tokens/relay")).length;
}

/** bringOnline() waits on the token throttle's timer, so let fake time run. */
async function online(pb: ProviderBacked): Promise<boolean> {
	const done = pb.bringOnline();
	await jest.advanceTimersByTimeAsync(3_000);
	return done;
}

function build() {
	const cache = new RelayCredentialCache(
		{ isAuthenticated: false } as unknown as AuthSession,
		new MockClock(),
		"vault",
		3,
		new Map([["server-a", new RelayOnPremTokenProvider({ controlPlaneUrl: "https://cp.example.com", authProvider })]]),
		undefined,
		"server-a",
	);
	const pb = new ProviderBacked(
		G,
		new RemoteFolderAddress("relay-onprem", G),
		cache,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
	return { cache, pb };
}

describe("tokens/relay 401/403: back off instead of retrying on a fixed floor", () => {
	const RealWS = (testGlobal as { WebSocket?: unknown }).WebSocket;
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockReset();
		(testGlobal as { WebSocket?: unknown }).WebSocket = FakeWS;
	});
	afterEach(() => {
		jest.useRealTimers();
		(testGlobal as { WebSocket?: unknown }).WebSocket = RealWS;
	});

	test("10 minutes of 401 cost at most 4 token requests", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { pb } = build();

		void pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
	});

	test("403 on the read fallback backs off the same way", async () => {
		mockFetch.mockImplementation(() => respond(403));
		const { pb } = build();

		void pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		// each attempt is write -> 403 -> read -> 403: two requests
		expect(tokenCalls()).toBeLessThanOrEqual(8);
	});

	test("the share reports no access while backed off, and a manual reset retries at once", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();

		await online(pb);
		expect(pb.accessDenied).toBe(true);
		const before = tokenCalls();

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		expect(pb.accessDenied).toBe(false);
		await online(pb);

		expect(tokenCalls()).toBe(before + 1);
		expect(pb.accessDenied).toBe(false);
	});

	test("CONTROL: a 500 is not treated as no access", async () => {
		mockFetch.mockImplementation(() => respond(500));
		const { pb } = build();

		await online(pb);
		expect(pb.accessDenied).toBe(false);
	});
});
