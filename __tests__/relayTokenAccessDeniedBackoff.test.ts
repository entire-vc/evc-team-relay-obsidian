/**
 * A share the signed-in account cannot open (POST /v1/tokens/relay answers
 * 401, or 403 even for read) used to be retried on a fixed short floor
 * forever: bringOnline() failed, rescheduled itself through ReconnectGate,
 * and asked the control plane again (seen in production: one client, 60 x 401
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
import { RemoteDocumentAddress, RemoteFolderAddress } from "../src/ResourceAddress";
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

/** Answer token requests after `latencyMs`, recording how many overlap. */
let inFlight = 0;
let maxInFlight = 0;
function respondSlowly(status: number, latencyMs: number): Promise<Response> {
	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	return new Promise((resolve) => {
		window.setTimeout(() => {
			inFlight--;
			resolve(respond(status));
		}, latencyMs);
	});
}

/** The `mode` each token request asked for, in order. */
function tokenModes(): string[] {
	return mockFetch.mock.calls
		.filter(([url]) => String(url).endsWith("/v1/tokens/relay"))
		.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { mode: string }).mode);
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
	const clock = new MockClock();
	const cache = new RelayCredentialCache(
		{ isAuthenticated: false } as unknown as AuthSession,
		clock,
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
	return { cache, clock, pb, docIn: (docGuid: string) => new ProviderBacked(
		docGuid,
		new RemoteDocumentAddress("relay-onprem", G, docGuid),
		cache,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	) };
}

describe("tokens/relay 401/403: back off instead of retrying on a fixed floor", () => {
	const RealWS = (testGlobal as { WebSocket?: unknown }).WebSocket;
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockReset();
		inFlight = 0;
		maxInFlight = 0;
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

	const DOCS = [
		"66666666-6666-4666-8666-666666666661",
		"66666666-6666-4666-8666-666666666662",
		"66666666-6666-4666-8666-666666666663",
	];

	test.each([401, 403])("%i: documents of a refused share ask one at a time: at most 4 requests in 10 minutes, never two in flight", async (status) => {
		// Latency well above the 2.4 s throttle spacing, so unserialized
		// requests would overlap.
		mockFetch.mockImplementation(() => respondSlowly(status, 5_000));
		const { pb, docIn } = build();

		for (const p of [pb, ...DOCS.map(docIn)]) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBe(1);
	});

	test("CONTROL: after the share's first grant its documents ask concurrently", async () => {
		mockFetch.mockImplementation(() => respondSlowly(200, 5_000));
		const { pb, docIn } = build();
		const first = pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);
		expect(await first).toBe(true);
		maxInFlight = 0;

		for (const p of DOCS.map(docIn)) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(30_000);

		expect(maxInFlight).toBeGreaterThan(1);
	});

	test("10 minutes of 403 (write, then read) cost at most 4 token requests", async () => {
		mockFetch.mockImplementation(() => respond(403));
		const { pb } = build();

		void pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(2);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
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

	test.each([401, 403])("%i: the renewal sweep backs off too once a granted share is refused", async (status) => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, clock, docIn } = build();
		const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => `77777777-7777-4777-8777-77777777777${n}`);
		for (const p of docs.map(docIn)) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);
		const granted = tokenCalls();
		expect(granted).toBeGreaterThanOrEqual(7);

		// Access is revoked; tokens come up for renewal and the sweep runs every minute.
		mockFetch.mockImplementation(() => respondSlowly(status, 5_000));
		maxInFlight = 0;
		// Off the sweep's minute grid, so a renewal comes up before the token lapses.
		clock.setTime(clock.now() + 30_000);
		cache.startSweeping();
		for (let minute = 0; minute < 10; minute++) {
			clock.setTime(clock.now() + MINUTE);
			await jest.advanceTimersByTimeAsync(MINUTE);
		}
		cache.stopSweeping();

		// The sweep refreshes up to maxConnections (3 here) at once, so the
		// refusal can cost that many requests before the share is backed off.
		expect(tokenCalls() - granted).toBeLessThanOrEqual(3 + 3);
		expect(docIn(docs[0]).accessDenied).toBe(true);
	});

	test("a reset asks for write again after a share refused write", async () => {
		mockFetch.mockImplementation(() => respond(403));
		const { cache, pb } = build();
		await online(pb);
		expect(tokenModes()).toEqual(["write", "read"]);

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		await online(pb);

		expect(tokenModes().slice(2)).toEqual(["write"]);
	});

	test("after a reset, a refusal is retried on the new window, not on the old long one", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		void pb.bringOnline();
		// 2 + 4 + 8 minutes: the next automatic retry is now 16 minutes out.
		await jest.advanceTimersByTimeAsync(15 * MINUTE);
		const before = tokenCalls();

		cache.clearAccessDenied();
		await online(pb);
		expect(tokenCalls()).toBe(before + 1);
		// The share is refused again on a fresh window: 2 minutes, not 16.
		await jest.advanceTimersByTimeAsync(3 * MINUTE);
		expect(tokenCalls()).toBe(before + 2);
	});
});
