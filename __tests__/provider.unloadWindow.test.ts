/**
 * Own presence disappeared for the rest of the session after the
 * Settings window (a separate window in Obsidian 1.15) was closed.
 *
 * The provider hooked its "unload" cleanup on `activeWindow`, which is
 * whatever window has focus at construction time. A provider created while
 * Settings was focused listened to Settings' unload; closing Settings then ran
 * removeAwarenessStates(own clientID) and the peer lost our cursor until a
 * restart, while text kept syncing. destroy() also removed the listener from
 * the then-active window, not the one it was added to.
 *
 * The listener now belongs to the main application window and is removed from
 * that same window.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import * as Y from "yjs";
import { YSweetProvider } from "../src/client/provider";
import { testGlobal } from "./mocks/testGlobal";

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: MockWebSocket[] = [];

	binaryType = "";
	readyState = MockWebSocket.CONNECTING;
	sent = 0;
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;

	constructor(public url: string) {
		MockWebSocket.instances.push(this);
	}

	send(): void {
		this.sent++;
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	succeed(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}
}

type Listener = (event: Event) => void;
type WindowLike = {
	addEventListener: (type: string, listener: Listener) => void;
	removeEventListener: (type: string, listener: Listener) => void;
};

const g = testGlobal as unknown as Record<string, unknown> & WindowLike;

/** A window stand-in that remembers its unload listeners. */
function fakeWindow() {
	const target = new EventTarget();
	const unloadListeners = new Set<Listener>();
	return {
		addEventListener: (type: string, listener: Listener) => {
			if (type === "unload") unloadListeners.add(listener);
			target.addEventListener(type, listener);
		},
		removeEventListener: (type: string, listener: Listener) => {
			if (type === "unload") unloadListeners.delete(listener);
			target.removeEventListener(type, listener);
		},
		unloadListeners,
		close: () => target.dispatchEvent(new Event("unload")),
	};
}

describe("YSweetProvider unload listener window", () => {
	let original: {
		activeWindow: unknown;
		addEventListener: WindowLike["addEventListener"];
		removeEventListener: WindowLike["removeEventListener"];
		WebSocket: unknown;
	};
	let mainWindow: ReturnType<typeof fakeWindow>;
	let settingsWindow: ReturnType<typeof fakeWindow>;
	let provider: YSweetProvider | undefined;

	beforeEach(() => {
		original = {
			activeWindow: g.activeWindow,
			addEventListener: g.addEventListener,
			removeEventListener: g.removeEventListener,
			WebSocket: g.WebSocket,
		};
		// In the test env `window` is the global object, so the global's
		// listener methods are the main window's.
		mainWindow = fakeWindow();
		g.addEventListener = mainWindow.addEventListener;
		g.removeEventListener = mainWindow.removeEventListener;
		settingsWindow = fakeWindow();
		g.WebSocket = MockWebSocket;
		MockWebSocket.instances = [];
	});

	afterEach(() => {
		provider?.destroy();
		provider = undefined;
		g.activeWindow = original.activeWindow;
		g.addEventListener = original.addEventListener;
		g.removeEventListener = original.removeEventListener;
		g.WebSocket = original.WebSocket;
	});

	function createWhileFocused(win: unknown): { doc: Y.Doc; provider: YSweetProvider } {
		g.activeWindow = win;
		const doc = new Y.Doc();
		const p = new YSweetProvider("ws://relay.example.com", "room", doc, {
			WebSocketPolyfill: MockWebSocket as unknown as typeof WebSocket,
			disableBc: true,
		});
		p.awareness.setLocalStateField("user", { name: "me" });
		// Focus returns to the main window, as after closing Settings.
		g.activeWindow = g;
		return { doc, provider: p };
	}

	test("closing the secondary window it was created under keeps own presence", () => {
		const created = createWhileFocused(settingsWindow);
		provider = created.provider;
		const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
		ws.succeed();
		const sentBefore = ws.sent;

		settingsWindow.close();

		expect(provider.awareness.getLocalState()).toEqual({ user: { name: "me" } });
		// No removal frame went out, so the peer keeps our cursor.
		expect(ws.sent).toBe(sentBefore);
	});

	test("closing the main window still withdraws own presence for peers", () => {
		const created = createWhileFocused(settingsWindow);
		provider = created.provider;
		const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
		ws.succeed();
		const removed: number[] = [];
		provider.awareness.on(
			"update",
			(changed: { removed: number[] }, origin: unknown) => {
				if (origin === "window unload") removed.push(...changed.removed);
			},
		);
		const sentBefore = ws.sent;

		mainWindow.close();

		expect(provider.awareness.getLocalState()).toBeNull();
		expect(removed).toEqual([created.doc.clientID]);
		// The removal went out over the socket, so peers drop the cursor.
		expect(ws.sent).toBeGreaterThan(sentBefore);
	});

	test("destroy removes the listener from the window it was added to", () => {
		const before = mainWindow.unloadListeners.size + settingsWindow.unloadListeners.size;
		const created = createWhileFocused(settingsWindow);
		const added =
			mainWindow.unloadListeners.size + settingsWindow.unloadListeners.size - before;
		expect(added).toBe(1);

		// Destroy while yet another window has focus.
		g.activeWindow = fakeWindow();
		created.provider.destroy();

		expect(mainWindow.unloadListeners.size + settingsWindow.unloadListeners.size).toBe(before);
	});
});
