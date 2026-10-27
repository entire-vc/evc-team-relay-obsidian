/**
 * connectGate: one handshake per server at a time, sockets for documents in
 * use ahead of background ones, and a stuck handshake gives up its turn.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	connectEndpoint,
	connectGateStats,
	enqueueConnect,
	HANDSHAKE_TIMEOUT_MS,
	MAX_HANDSHAKE_TIMEOUT_MS,
	resetConnectGate,
} from "../src/client/connectGate";
import { holdBackgroundTokens, resetTokenRequestClasses } from "../src/auth/tokenRequestClass";
import { YSweetProvider } from "../src/client/provider";
import { testGlobal } from "./mocks/testGlobal";

const globalStub = testGlobal as unknown as {
	addEventListener?: () => void;
	removeEventListener?: () => void;
};
globalStub.addEventListener ??= () => {};
globalStub.removeEventListener ??= () => {};

class FakeWS {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWS[] = [];
	readyState = FakeWS.CONNECTING;
	binaryType = "";
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;
	closed = false;
	constructor(public url: string) {
		FakeWS.instances.push(this);
	}
	send(): void {}
	/** Like a browser: closing a socket that never opened fires onclose. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const wasOpen = this.readyState === FakeWS.OPEN;
		this.readyState = FakeWS.CLOSED;
		if (!wasOpen) void Promise.resolve().then(() => this.onclose?.({ code: 1006 }));
	}
	open(): void {
		this.readyState = FakeWS.OPEN;
		this.onopen?.();
	}
}
(testGlobal as unknown as { WebSocket?: unknown }).WebSocket = FakeWS;

describe("enqueueConnect", () => {
	beforeEach(() => resetConnectGate());

	test("starts one handshake per server at a time", () => {
		const started: string[] = [];
		const a = enqueueConnect("wss://relay.example.com/d/a/ws", () => "background", () => started.push("a"));
		enqueueConnect("wss://relay.example.com/d/b/ws", () => "background", () => started.push("b"));
		enqueueConnect("wss://other.example.com/d/c/ws", () => "background", () => started.push("c"));
		expect(started).toEqual(["a", "c"]);
		a.release();
		expect(started).toEqual(["a", "c", "b"]);
	});

	test("a document in use goes ahead of queued background sockets", () => {
		const started: string[] = [];
		const first = enqueueConnect("wss://relay.example.com/d/1/ws", () => "background", () => started.push("bg1"));
		enqueueConnect("wss://relay.example.com/d/2/ws", () => "background", () => started.push("bg2"));
		enqueueConnect("wss://relay.example.com/d/3/ws", () => "normal", () => started.push("edit"));
		first.release();
		expect(started).toEqual(["bg1", "edit"]);
		expect(connectGateStats().waiting).toBe(1);
	});

	test("a released waiter never starts, and a second release is a no-op", () => {
		const started: string[] = [];
		const busy = enqueueConnect("wss://relay.example.com/d/1/ws", () => "normal", () => started.push("1"));
		const gone = enqueueConnect("wss://relay.example.com/d/2/ws", () => "normal", () => started.push("2"));
		enqueueConnect("wss://relay.example.com/d/3/ws", () => "normal", () => started.push("3"));
		gone.release();
		busy.release();
		busy.release();
		expect(started).toEqual(["1", "3"]);
	});

	test("the endpoint is scheme, host and port", () => {
		expect(connectEndpoint("wss://Relay.example.com:8443/d/x/ws?token=t")).toBe("wss://relay.example.com:8443");
	});

	test("a waiter whose document came into use while queued goes first", () => {
		const started: string[] = [];
		let inUse = false;
		const busy = enqueueConnect("wss://relay.example.com/d/1/ws", () => "normal", () => started.push("1"));
		enqueueConnect("wss://relay.example.com/d/2/ws", () => "background", () => started.push("bg"));
		enqueueConnect("wss://relay.example.com/d/3/ws", () => (inUse ? "normal" : "background"), () => started.push("now-open"));
		inUse = true;
		busy.release();
		expect(started).toEqual(["1", "now-open"]);
	});

	test("a start that throws does not hold the server", () => {
		const started: string[] = [];
		const busy = enqueueConnect("wss://relay.example.com/d/1/ws", () => "normal", () => started.push("1"));
		const broken = enqueueConnect("wss://relay.example.com/d/2/ws", () => "normal", () => {
			throw new Error("SecurityError");
		});
		enqueueConnect("wss://relay.example.com/d/3/ws", () => "normal", () => started.push("3"));
		const spy = jest.spyOn(console, "error").mockImplementation(() => {});
		busy.release();
		spy.mockRestore();
		expect(broken.released).toBe(true);
		expect(started).toEqual(["1", "3"]);
	});
});

describe("YSweetProvider through the gate", () => {
	const providers: YSweetProvider[] = [];
	const make = (room: string) => {
		const provider = new YSweetProvider("wss://relay.example.com/d", room, new Y.Doc(), {
			WebSocketPolyfill: FakeWS as unknown as typeof WebSocket,
			disableBc: true,
			connect: false,
		});
		providers.push(provider);
		return provider;
	};

	beforeEach(() => {
		jest.useFakeTimers();
		FakeWS.instances = [];
		resetConnectGate();
		resetTokenRequestClasses();
	});
	afterEach(() => {
		for (const provider of providers.splice(0)) provider.destroy();
		jest.useRealTimers();
	});

	test("an edit's socket is opened before background sockets queued earlier", () => {
		holdBackgroundTokens("bg1");
		holdBackgroundTokens("bg2");
		make("bg1").connect();
		make("bg2").connect();
		make("edit").connect();
		expect(FakeWS.instances.map((w) => w.url.split("?")[0])).toEqual(["wss://relay.example.com/d/bg1"]);
		FakeWS.instances[0].open();
		expect(FakeWS.instances.map((w) => w.url.split("?")[0])).toEqual([
			"wss://relay.example.com/d/bg1",
			"wss://relay.example.com/d/edit",
		]);
		expect(connectGateStats().wait.normal.count).toBe(1);
	});

	test("a stuck handshake gives up its turn and is retried", async () => {
		const stuck = make("stuck");
		stuck.connect();
		make("next").connect();
		expect(FakeWS.instances).toHaveLength(1);
		await jest.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
		expect(FakeWS.instances[0].closed).toBe(true);
		expect(FakeWS.instances[1].url).toContain("/d/next");
		expect(connectGateStats().timeouts).toBe(1);
		FakeWS.instances[1].open();
		await jest.advanceTimersByTimeAsync(1000);
		expect(FakeWS.instances[2].url).toContain("/d/stuck");
		expect(stuck.connectTrace.failedSockets).toBe(1);
	});

	test("disconnect while waiting leaves the queue without opening a socket", () => {
		make("first").connect();
		const waiting = make("waiting");
		waiting.connect();
		waiting.disconnect();
		expect(waiting.wsconnecting).toBe(false);
		FakeWS.instances[0].open();
		expect(FakeWS.instances).toHaveLength(1);
		expect(connectGateStats().waiting).toBe(0);
	});

	test("a second connect() while waiting does not queue a second socket", () => {
		make("first").connect();
		const waiting = make("waiting");
		waiting.connect();
		waiting.connect();
		expect(waiting.connectTrace.skipped).toBe("socket-present");
		FakeWS.instances[0].open();
		expect(FakeWS.instances).toHaveLength(2);
		expect(connectGateStats().waiting).toBe(0);
	});

	test("an old socket closing after disconnect and reconnect does not keep the new one's turn", async () => {
		const p = make("doc");
		p.connect();
		p.disconnect();
		p.connect();
		expect(FakeWS.instances).toHaveLength(2);
		await Promise.resolve();
		await Promise.resolve();
		expect(p.ws).toBe(FakeWS.instances[1] as unknown as WebSocket);
		FakeWS.instances[1].close();
		await Promise.resolve();
		await Promise.resolve();
		expect(p.connectTicket).toBeNull();
		make("other").connect();
		expect(FakeWS.instances.at(-1)?.url).toContain("/d/other");
	});

	test("a socket constructor that throws is retried and frees the server", async () => {
		let fail = true;
		class ThrowingWS extends FakeWS {
			constructor(url: string) {
				if (fail) {
					fail = false;
					throw new Error("SecurityError");
				}
				super(url);
			}
		}
		const p = new YSweetProvider("wss://relay.example.com/d", "throws", new Y.Doc(), {
			WebSocketPolyfill: ThrowingWS as unknown as typeof WebSocket,
			disableBc: true,
			connect: false,
		});
		providers.push(p);
		p.connect();
		expect(p.connectTicket).toBeNull();
		expect(p.connectTrace.failedSockets).toBe(1);
		make("other").connect();
		expect(FakeWS.instances.map((w) => w.url.split("?")[0])).toEqual(["wss://relay.example.com/d/other"]);
		FakeWS.instances[0].open();
		await jest.advanceTimersByTimeAsync(1000);
		expect(FakeWS.instances.at(-1)?.url).toContain("/d/throws");
	});

	test("each handshake timeout in a row doubles the next one, up to a cap", async () => {
		const p = make("slow");
		p.connect();
		await jest.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
		expect(FakeWS.instances[0].closed).toBe(true);
		await jest.advanceTimersByTimeAsync(1000);
		expect(FakeWS.instances).toHaveLength(2);
		await jest.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
		expect(FakeWS.instances[1].closed).toBe(false);
		await jest.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
		expect(FakeWS.instances[1].closed).toBe(true);
		expect(p.handshakeTimeoutsInRow).toBe(2);
		const capped = make("slower");
		capped.handshakeTimeoutsInRow = 10;
		FakeWS.instances.at(-1)!.open();
		capped.connect();
		const last = FakeWS.instances.at(-1)!;
		expect(last.url).toContain("/d/slower");
		await jest.advanceTimersByTimeAsync(MAX_HANDSHAKE_TIMEOUT_MS - 1);
		expect(last.closed).toBe(false);
		await jest.advanceTimersByTimeAsync(1);
		expect(last.closed).toBe(true);
	});
});
