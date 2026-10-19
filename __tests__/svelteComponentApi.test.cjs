const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");
const loadBadge = (compatible) => loadSvelteComponent(path.resolve(__dirname, "../src/components/TextBadge.svelte"), {}, compatible);

test("the default Svelte 5 API rejects an existing class constructor (negative control)", async () => {
	const { dom, default: Component } = await loadBadge(false);
	try {
		expect(() => new Component({ target: dom.window.document.body, props: { pillText: "before", ariaLabel: "initial" } }))
			.toThrow(/component_api_invalid_new/);
	} finally { dom.window.close(); }
});

test("production options support new Component, $set, $on and $destroy in a real DOM", async () => {
	const { dom, default: Component, flushSync } = await loadBadge(true);
	const target = dom.window.document.body;
	let component;
	try {
		component = new Component({ target, props: { pillText: "before", ariaLabel: "initial" } });
		expect(target.textContent).toBe("before");
		const unsubscribe = component.$on("unused", () => {});
		expect(typeof unsubscribe).toBe("function");
		unsubscribe();
		component.$set({ pillText: "after", ariaLabel: "updated" });
		flushSync();
		expect(target.textContent).toBe("after");
		expect(target.firstElementChild.getAttribute("aria-label")).toBe("updated");
		component.$destroy();
		component = undefined;
		expect(target.textContent).toBe("");
		expect(target.children).toHaveLength(0);
	} finally {
		component?.$destroy();
		dom.window.close();
	}
});
