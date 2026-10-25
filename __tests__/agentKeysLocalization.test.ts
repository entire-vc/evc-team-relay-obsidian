/** @jest-environment node */
import path from "node:path";
import type { Component as SvelteComponentType } from "svelte";
import { getLanguage } from "obsidian";

import { loadSvelteComponent } from "../scripts/test/svelteDOM.cjs";
import { testGlobal } from "./mocks/testGlobal";

let Component: SvelteComponentType<Record<string, unknown>>;
let mountComponent: typeof import("../src/svelteMount").mountComponent;
let component: ReturnType<typeof mountComponent> | undefined;
let closeDom: () => void;

// Exercise the rendered component, including both entry points into the dialog.
// Only the host and key service boundaries are replaced.
beforeAll(async () => {
	const dependencies: Record<string, unknown> = {
		obsidian: { Notice: jest.fn() },
		"../wording/uiText": await import("../src/wording/uiText"),
	};
	const loaded = loadSvelteComponent(path.resolve(__dirname, "../src/components/AgentKeysView.svelte"), dependencies);
	closeDom = () => loaded.dom.window.close();
	Object.assign(testGlobal, { window: loaded.dom.window, document: loaded.dom.window.document,
		activeDocument: loaded.dom.window.document, Event: loaded.dom.window.Event });
	Component = loaded.default;
	mountComponent = loaded.mountComponent;
});

async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function click(selector: string) {
	const button = document.querySelector<HTMLButtonElement>(selector);
	expect(button).not.toBeNull();
	button!.click();
	await flush();
}

afterAll(() => closeDom?.());
afterEach(() => {
	component?.destroy();
	component = undefined;
	document.body.innerHTML = "";
});

describe.each([
	{ language: "en", title: "Agent Keys", headerButton: "+ Create agent key", shareButton: "+ Create key",
		empty: "No keys for this share.", dialog: "Create agent key", labels: ["Label", "Share", "Expiry"],
		placeholder: "e.g. ci-bot", expiry: ["Never", "30 days", "90 days", "1 year"],
		footer: ["Cancel", "Create key"] },
	{ language: "ru", title: "Ключи агента", headerButton: "+ Создать ключ агента", shareButton: "+ Создать ключ",
		empty: "Для этого общего доступа нет ключей.", dialog: "Создать ключ агента",
		labels: ["Название", "Общий доступ", "Срок действия"], placeholder: "например, ci-bot",
		expiry: ["Бессрочно", "30 дней", "90 дней", "1 год"], footer: ["Отмена", "Создать ключ"] },
])("agent key interface ($language)", (copy) => {
	beforeEach(async () => {
		(getLanguage as jest.Mock).mockReturnValue(copy.language);
		component = mountComponent(Component, { target: document.body, props: {
			server: { id: "fixture-server" },
			live: {
				shareClient: {
					listShares: async () => [{ id: "fixture-share", path: "Folder", owner_user_id: "owner" }],
					listAgentKeys: async () => [],
				},
				authSession: { getMultiServerAuthManager: () => ({ getUserForServer: () => ({ id: "owner" }) }) },
			},
		} });
		await flush();
	});

	test("heading, both create buttons, and empty state use the selected language", () => {
		expect(document.querySelector(".ak-title")?.textContent).toBe(copy.title);
		expect(document.querySelector(".ak-header-row button")?.textContent).toBe(copy.headerButton);
		expect(document.querySelector(".ak-share-header button")?.textContent).toBe(copy.shareButton);
		expect(document.querySelector(".ak-no-keys")?.textContent).toBe(copy.empty);
	});

	test.each([".ak-header-row button", ".ak-share-header button"])("%s opens a translated dialog", async (selector) => {
		await click(selector);
		expect(document.querySelector(".ak-modal-title")?.textContent).toBe(copy.dialog);
		expect(Array.from(document.querySelectorAll(".ak-field label")).map((node) => node.textContent)).toEqual(copy.labels);
		expect(document.querySelector<HTMLInputElement>("#ak-label-input")?.placeholder).toBe(copy.placeholder);
		expect(Array.from(document.querySelectorAll("#ak-expiry-select option")).map((node) => node.textContent)).toEqual(copy.expiry);
		expect(Array.from(document.querySelectorAll(".ak-modal-footer button")).map((node) => node.textContent?.trim())).toEqual(copy.footer);
		expect(document.querySelector<HTMLSelectElement>("#ak-share-select")?.value).toBe("fixture-share");
	});
});
