/**
 * Tests for reconnect used to die after 3 failed
 * attempts (~0.7s of exponential backoff), then canReconnect() went
 * permanently false — nothing else re-armed it, so a brief relay-server
 * outage (deploy restart, 5-30s) left the editor silently dormant until
 * the user switched views or a control-plane health flap happened to
 * fire (which doesn't even observe the relay-server itself).
 *
 * Fix: maxConnectionErrors now defaults to Infinity (was 3) — retry
 * forever, bounded only by maxBackoffTime's existing interval cap.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as Y from "yjs";
import { YSweetProvider } from "../src/client/provider";
import { testGlobal } from "./mocks/testGlobal";
import { resetConnectGate } from "../src/client/connectGate";

// jest.setup.js aliases activeWindow -> global (a plain Node object), but
// provider.ts's constructor calls activeWindow.addEventListener("unload", ...)
// — stub the missing method so construction doesn't throw in this Node test
// environment (global has no DOM EventTarget API).
const globalStub = testGlobal as unknown as {
	addEventListener?: () => void;
	removeEventListener?: () => void;
};
globalStub.addEventListener ??= () => {};
globalStub.removeEventListener ??= () => {};

class MockWebSocket {
	static instances: MockWebSocket[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	binaryType = "";
	readyState = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;

	constructor(public url: string) {
		MockWebSocket.instances.push(this);
	}

	send(): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	/** Test helper: simulate this connection attempt failing outright
	 * (never reaches onopen), matching what happens when the relay
	 * server is down/restarting. */
	failToConnect(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code: 1006 });
	}

	/** Test helper: simulate a successful connection. */
	succeed(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}
}

function latestSocket(): MockWebSocket {
	const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
	if (!ws) throw new Error("no WebSocket was constructed");
	return ws;
}

// provider.ts's destroy() references the bare global WebSocket.OPEN/
// .CONNECTING directly (not the injected WebSocketPolyfill) when deciding
// whether to close the socket. Node only has a native WebSocket global on
// some versions/runtimes (present locally, absent in this repo's CI
// runner) — stub it explicitly so the test doesn't depend on that
// environment difference. Values match the mock's own (spec-standard)
// numbering, so the readyState comparison in destroy() stays correct.
(testGlobal as unknown as { WebSocket?: unknown }).WebSocket = MockWebSocket;

describe("YSweetProvider reconnect", () => {
	let provider: YSweetProvider;

	beforeEach(() => {
		jest.useFakeTimers();
		MockWebSocket.instances = [];
		resetConnectGate();
	});

	afterEach(() => {
		provider?.destroy();
		jest.useRealTimers();
	});

	test("keeps retrying past the old 3-attempt cap by default", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
		});

		// Fail 6 attempts in a row — more than the OLD maxConnectionErrors=3.
		for (let i = 0; i < 6; i++) {
			latestSocket().failToConnect();
			jest.advanceTimersByTime(1000);
		}

		expect(MockWebSocket.instances.length).toBeGreaterThan(3);
		expect(provider.canReconnect()).toBe(true);
		expect(provider.wsUnsuccessfulReconnects).toBe(6);
	});

	test("backoff interval never exceeds maxBackoffTime even after many failures", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 500,
			disableBc: true,
		});

		for (let i = 0; i < 10; i++) {
			latestSocket().failToConnect();
		}
		const countAfterTenFailuresNoAdvance = MockWebSocket.instances.length;

		// Advancing by exactly maxBackoffTime must be enough to trigger the
		// next attempt, however many failures preceded it — if the interval
		// were still growing unbounded (2^n*100ms), this would NOT reconnect
		// within 500ms after 10 failures (2^10*100 = 102,400ms).
		jest.advanceTimersByTime(500);

		expect(MockWebSocket.instances.length).toBe(countAfterTenFailuresNoAdvance + 1);
	});

	test("recovers automatically once the relay comes back — no external trigger needed", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
		});

		// Simulate a relay-server restart: several failed attempts, each one
		// a genuinely NEW socket construction (not a stale reused instance —
		// that's the actual thing the old 3-attempt cap broke: past attempt
		// 3 no new socket was ever scheduled again).
		let socketCountBeforeThisAttempt = MockWebSocket.instances.length;
		for (let i = 0; i < 5; i++) {
			latestSocket().failToConnect();
			jest.advanceTimersByTime(1000);
			expect(MockWebSocket.instances.length).toBeGreaterThan(socketCountBeforeThisAttempt);
			socketCountBeforeThisAttempt = MockWebSocket.instances.length;
		}
		expect(provider.wsconnected).toBe(false);

		// ...then the relay comes back and the NEXT scheduled attempt succeeds.
		latestSocket().succeed();

		expect(provider.wsconnected).toBe(true);
		expect(provider.wsUnsuccessfulReconnects).toBe(0);
	});

	test("still stops if shouldConnect is false (explicit disconnect)", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
		});

		provider.disconnect();
		const countAtDisconnect = MockWebSocket.instances.length;

		jest.advanceTimersByTime(10000);

		// disconnect() must still win — uncapping attempt COUNT doesn't mean
		// the provider ignores an explicit "stop trying" request.
		expect(MockWebSocket.instances.length).toBe(countAtDisconnect);
		expect(provider.canReconnect()).toBe(false);
	});

	test("an explicit maxConnectionErrors override is still honored", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			maxConnectionErrors: 2,
			disableBc: true,
		});

		latestSocket().failToConnect();
		jest.advanceTimersByTime(1000);
		latestSocket().failToConnect();
		jest.advanceTimersByTime(1000);

		expect(provider.canReconnect()).toBe(false);
		const countAtCap = MockWebSocket.instances.length;
		jest.advanceTimersByTime(10000);
		expect(MockWebSocket.instances.length).toBe(countAtCap);
	});

	test("connectTrace records when the socket was created and opened, and failed attempts", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
			connect: false,
		});
		const t0 = Date.now();
		provider.connect();
		expect(provider.connectTrace.calledAt).toBeGreaterThanOrEqual(t0);
		expect(provider.connectTrace.socketAt).toBeGreaterThanOrEqual(t0);
		latestSocket().failToConnect();
		jest.advanceTimersByTime(5000);
		latestSocket().succeed();
		expect(provider.connectTrace.failedSockets).toBe(1);
		expect(provider.connectTrace.openAt).toBeGreaterThanOrEqual(t0 + 5000);
		expect(provider.connectTrace.skipped).toBeUndefined();
	});

	test("connectTrace names a connect() that opened nothing because the old socket was still there", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			disableBc: true,
			connect: false,
		});
		provider.connect();
		const sockets = MockWebSocket.instances.length;
		provider.connect();
		expect(MockWebSocket.instances.length).toBe(sockets);
		expect(provider.connectTrace.skipped).toBe("socket-present");
	});

	test("connectTrace keeps the in-flight socket's failures when connect() finds it still connecting", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
			connect: false,
		});
		provider.connect();
		latestSocket().failToConnect();
		jest.advanceTimersByTime(1000);
		provider.connect();
		expect(provider.connectTrace.skipped).toBe("socket-present");
		expect(provider.connectTrace.failedSockets).toBe(1);
		expect(provider.connectTrace.socketAt).toBeDefined();
	});

	test("connectTrace clears a skip once a retry opens a socket", () => {
		const doc = new Y.Doc();
		provider = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			maxBackoffTime: 1000,
			disableBc: true,
			connect: false,
		});
		provider.connect();
		provider.connect();
		expect(provider.connectTrace.skipped).toBe("socket-present");
		latestSocket().failToConnect();
		jest.advanceTimersByTime(1000);
		expect(provider.connectTrace.skipped).toBeUndefined();
		latestSocket().succeed();
		expect(provider.connectTrace.openAt).toBeDefined();
	});
});
