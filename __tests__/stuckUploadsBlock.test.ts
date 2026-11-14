/** @jest-environment node */
import path from "node:path";
import type { Component as SvelteComponentType } from "svelte";
import { loadSvelteComponent } from "../scripts/test/svelteDOM.cjs";

// The real block, compiled with the production preprocessor and rendered in a
// DOM. Only the Obsidian API version check is replaced (host boundary).
let Component: SvelteComponentType<Record<string, unknown>>;
let mountComponent: typeof import("../src/svelteMount").mountComponent;
let component: ReturnType<typeof mountComponent> | undefined;
let doc: Document;
let closeDom: () => void;

beforeAll(async () => {
	const loaded = loadSvelteComponent(
		path.resolve(__dirname, "../src/components/StuckUploadsBlock.svelte"),
		{
			obsidian: { requireApiVersion: () => true },
			// The interface language comes from the shared Obsidian mock (English).
			"../wording/uiText": await import("../src/wording/uiText"),
		},
	);
	closeDom = () => loaded.dom.window.close();
	doc = loaded.dom.window.document;
	Component = loaded.default;
	mountComponent = loaded.mountComponent;
});
afterAll(() => closeDom?.());
afterEach(() => {
	component?.destroy();
	component = undefined;
	doc.body.innerHTML = "";
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function mount(more: number) {
	component = mountComponent(Component, {
		target: doc.body,
		props: {
			stuckPaths: [".artifacts/a.png", ".artifacts/b.png", ".artifacts/c.png"],
			more,
			retrying: false,
			onRetry: jest.fn(),
		},
	});
}

function button(label: string): HTMLButtonElement {
	const found = [...doc.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
	expect(found).toBeDefined();
	return found as HTMLButtonElement;
}

function moreRow(): Element {
	const row = [...doc.querySelectorAll(".setting-item")].find((el) =>
		/more files? waiting to upload/.test(el.textContent ?? ""),
	);
	expect(row).toBeDefined();
	return row as Element;
}

describe("stuck uploads block", () => {
	test("expanded list sits inside the block, right under the stuck row and before 'K more'", async () => {
		mount(2);
		expect(doc.querySelector(".evc-stuck-upload-list")).toBeNull();
		button("Show files").click();
		await flush();

		const list = doc.querySelector(".evc-stuck-upload-list");
		expect(list).not.toBeNull();
		expect([...list!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			".artifacts/a.png",
			".artifacts/b.png",
			".artifacts/c.png",
		]);

		const block = doc.querySelector(".setting-items");
		expect(block).not.toBeNull();
		const rows = [...block!.children];
		const stuckRow = rows.findIndex((el) => /3 files not uploaded for more than 7 days/.test(el.textContent ?? ""));
		const listRow = rows.findIndex((el) => el.contains(list));
		const more = moreRow();
		// All three rows are direct rows of the same block, in this order, "more" last.
		expect(stuckRow).toBe(0);
		expect(listRow).toBe(1);
		expect(rows.indexOf(more)).toBe(2);
		expect(rows).toHaveLength(3);
		expect(more.textContent?.trim()).toBe("2 more files waiting to upload");
		expect(list!.compareDocumentPosition(more) & doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		button("Hide files").click();
		await flush();
		expect(doc.querySelector(".evc-stuck-upload-list")).toBeNull();
	});

	test("no 'more' row when every pending file is stuck", async () => {
		mount(0);
		button("Show files").click();
		await flush();
		const rows = [...doc.querySelector(".setting-items")!.children];
		expect(rows).toHaveLength(2);
		expect(doc.body.textContent).not.toMatch(/waiting to upload/);
	});
});
