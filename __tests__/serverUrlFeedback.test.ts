/** @jest-environment node */
import path from "node:path";
import type { Component as SvelteComponentType } from "svelte";
import { getLanguage, Platform } from "obsidian";
import type { RelayOnPremServer } from "../src/RelayOnPremConfig";

const notice = jest.fn();
const fetch = jest.fn();
const addServer = jest.fn();
const mutateValue = jest.fn();
import { loadSvelteComponent } from "../scripts/test/svelteDOM.cjs";
import { testGlobal } from "./mocks/testGlobal";

let Component: SvelteComponentType<Record<string, unknown>>;
let mountComponent: typeof import("../src/svelteMount").mountComponent;
let component: ReturnType<typeof mountComponent> | undefined;
let closeDom: () => void;

// Compile the real component and its browser runtime. Only host/network
// boundaries are replaced: clicks, bindings, validation and persistence paths
// run as they do in the settings UI (no source-text assertions).
beforeAll(async () => {
	const dependencies: Record<string, unknown> = {
		obsidian: { Notice: notice, Platform },
		"../platformFetch": { platformFetch: fetch },
		"../RelayOnPremConfig": await import("../src/RelayOnPremConfig"),
		"../wording/uiText": await import("../src/wording/uiText"),
		"../auth/OAuthCancelledError": await import("../src/auth/OAuthCancelledError"),
		"../inFlightGuard": await import("../src/inFlightGuard"),
		"../ui/RelayOnPremLoginModal": {},
		"../ui/dialogs": {},
		"../assets/evc-logo.png": "",
	};
	const loaded = loadSvelteComponent(path.resolve(__dirname, "../src/components/RelayOnPremServerList.svelte"), dependencies);
	closeDom = () => loaded.dom.window.close();
	Object.assign(testGlobal, { window: loaded.dom.window, document: loaded.dom.window.document,
		activeDocument: loaded.dom.window.document, Event: loaded.dom.window.Event });
	Component = loaded.default;
	mountComponent = loaded.mountComponent;
});

async function flush() {
	// Drain promise continuations and Svelte's render queue before assertions.
	await new Promise<void>((resolve) => setImmediate(resolve));
}

afterAll(() => closeDom?.());

function mount(servers: RelayOnPremServer[] = []) {
	let settings = { servers, defaultServerId: "" };
	const subscribers = new Set<(value: typeof settings) => void>();
	const subscribe = (run: (value: typeof settings) => void) => {
		subscribers.add(run);
		run(settings);
		return () => subscribers.delete(run);
	};
	mutateValue.mockImplementation(async (update) => {
		settings = update(settings);
		subscribers.forEach((run) => run(settings));
	});
	component = mountComponent(Component, { target: document.body, props: {
		live: { relayOnPremSettings: { subscribe, mutateValue },
			authSession: { addServer, updateServer: jest.fn(), isLoggedInToServer: () => false } },
	} });
}

async function click(selector: string) {
	const button = document.querySelector<HTMLButtonElement>(selector);
	expect(button).not.toBeNull();
	button!.click();
	await flush();
}

async function submit(url: string) {
	await click(".relay-server-add-btn");
	const input = document.querySelector<HTMLInputElement>("#control-plane-url")!;
	input.value = url;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await click(".relay-server-form-actions .mod-cta");
}

beforeEach(() => {
	jest.clearAllMocks();
	fetch.mockReset();
	(getLanguage as jest.Mock).mockReturnValue("en");
});
afterEach(() => {
	component?.destroy();
	component = undefined;
	document.body.innerHTML = "";
});

describe.each([
	["en", "Control Plane URL is required", "Cannot connect to server"],
	["ru", "Укажите адрес control plane", "Не удаётся подключиться к серверу"],
])("server URL feedback (%s)", (language, required, unavailable) => {
	beforeEach(() => (getLanguage as jest.Mock).mockReturnValue(language));
	test.each(["", "   "])("empty input %j stays open with one inline error", async (url) => {
		mount();
		await submit(url);
		expect(document.querySelector(".relay-server-form-error")?.textContent).toBe(required);
		expect(document.querySelector(".relay-server-form")).not.toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(notice).not.toHaveBeenCalled();
		expect(mutateValue).not.toHaveBeenCalled();
		expect(addServer).not.toHaveBeenCalled();
	});
	test.each(["network", "http"])("%s failure has one human inline message, without a toast", async (failure) => {
		if (failure === "network") fetch.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
		else fetch.mockResolvedValue({ ok: false, status: 503 });
		mount();
		await submit("https://unreachable.example.invalid");
		expect(document.querySelector(".relay-server-form-error")?.textContent).toBe(unavailable);
		expect(document.querySelectorAll(".relay-server-form-error")).toHaveLength(1);
		expect(notice).not.toHaveBeenCalled();
		expect(mutateValue).not.toHaveBeenCalled();
		expect(addServer).not.toHaveBeenCalled();
		expect(document.querySelector("#control-plane-url")).not.toBeNull();
	});
});

test("successful add saves the server and shows only the completion notice", async () => {
	fetch.mockResolvedValue({ ok: true, json: async () => ({ id: "custom", name: "My server" }) });
	mount();
	await submit("https://cp.example.com");
	expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ controlPlaneUrl: "https://cp.example.com" }));
	expect(mutateValue).toHaveBeenCalledTimes(1);
	expect(document.querySelector(".relay-server-form")).toBeNull();
	expect(notice.mock.calls).toEqual([["Server added"]]);
});

test.each([true, false])("standalone connection test still gives one notice (success=%s)", async (ok) => {
	fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
	mount([{ id: "custom", name: "My server", controlPlaneUrl: "https://cp.example.com", isValidated: true }]);
	await flush();
	if (ok) fetch.mockResolvedValue({ ok: true });
	else fetch.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
	await click(".relay-server-actions button:nth-child(2)");
	expect(notice.mock.calls).toEqual([[ok ? "Connection successful!" : "Cannot connect to server"]]);
	expect(document.querySelector(".relay-server-form-error")).toBeNull();
});
