const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");
const loadBadge = () => loadSvelteComponent(path.resolve(__dirname, "../src/components/TextBadge.svelte"));

test("production options no longer accept the Svelte 4 class constructor", async () => {
	const { dom, default: Component } = await loadBadge();
	try {
		expect(() => new Component({ target: dom.window.document.body, props: { pillText: "before", ariaLabel: "initial" } }))
			.toThrow(/component_api_invalid_new/);
	} finally { dom.window.close(); }
});

test("props passed to a bare mount() are read once (negative control for update)", async () => {
	const { dom, default: Component, mount, flushSync } = await loadBadge();
	const target = dom.window.document.body;
	try {
		const props = { pillText: "before", ariaLabel: "initial" };
		mount(Component, { target, props });
		flushSync();
		props.pillText = "after";
		flushSync();
		expect(target.textContent).toBe("before");
	} finally { dom.window.close(); }
});

test("mountComponent mounts, updates (including keys absent at mount) and destroys in a real DOM", async () => {
	const { dom, default: Component, mountComponent, flushSync } = await loadBadge();
	const target = dom.window.document.body;
	let component;
	try {
		component = mountComponent(Component, { target, props: { pillText: "before" } });
		expect(target.textContent).toBe("before");
		expect(target.firstElementChild.hasAttribute("aria-label")).toBe(false);
		component.update({ pillText: "after", ariaLabel: "updated" });
		flushSync();
		expect(target.textContent).toBe("after");
		expect(target.firstElementChild.getAttribute("aria-label")).toBe("updated");
		component.destroy();
		component = undefined;
		expect(target.textContent).toBe("");
		expect(target.children).toHaveLength(0);
	} finally {
		component?.destroy();
		dom.window.close();
	}
});
