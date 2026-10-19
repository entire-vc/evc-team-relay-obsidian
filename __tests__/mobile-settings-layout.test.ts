/**
 * Ratchet for the mobile (Obsidian isMobile, ~393px) settings layout fixes.
 * Runtime pixel measurements were taken on live Obsidian (emulateMobile +
 * 393x852 device metrics); jest has no layout engine, so this pins the CSS
 * rules that produced them and the class hook in SettingsPanel.svelte.
 */
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const panel = fs.readFileSync(path.join(root, "src/components/SettingsPanel.svelte"), "utf8");

interface Rule {
	selector: string;
	body: string;
}

function parseRules(source: string): Rule[] {
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripped)) !== null) {
		rules.push({ selector: m[1].trim(), body: m[2] });
	}
	return rules;
}

const mobileRules = parseRules(css).filter((r) => r.selector.includes(".is-mobile"));

function rulesFor(fragment: string): Rule[] {
	return mobileRules.filter((r) => r.selector.split(",").some((s) => s.includes(fragment)));
}

function declared(rule: Rule, prop: string): string | undefined {
	const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule.body);
	return m ? m[1].trim() : undefined;
}

function anyDeclares(fragment: string, prop: string, pred: (v: string) => boolean): boolean {
	return rulesFor(fragment).some((r) => {
		const v = declared(r, prop);
		return v !== undefined && pred(v);
	});
}

describe("mobile settings layout styles", () => {
	it("has mobile rules at all", () => {
		expect(mobileRules.length).toBeGreaterThan(5);
	});

	it("scopes every mobile selector under .is-mobile", () => {
		for (const r of mobileRules) {
			for (const sel of r.selector.split(",")) {
				expect(sel.trim()).toMatch(/^\.is-mobile\b/);
			}
		}
	});

	it("uses no !important anywhere", () => {
		expect(css).not.toMatch(/!important/);
	});

	it("collapses the nested inner scroller and doubled padding", () => {
		const hit = rulesFor(".vertical-tab-content .vertical-tab-content");
		expect(hit.length).toBeGreaterThan(0);
		expect(hit.some((r) => declared(r, "overflow") === "visible")).toBe(true);
		expect(hit.some((r) => declared(r, "padding") === "0")).toBe(true);
		expect(hit.some((r) => declared(r, "max-height") === "none")).toBe(true);
	});

	it("keeps the share list within its container with no inner scroller", () => {
		expect(anyDeclares(".evc-share-list", "min-width", (v) => v === "0")).toBe(true);
		expect(anyDeclares(".evc-share-list", "max-height", (v) => v === "none")).toBe(true);
		expect(anyDeclares(".evc-share-list", "overflow", (v) => v === "visible")).toBe(true);
		expect(anyDeclares(".evc-share-list", "overflow-wrap", (v) => v === "anywhere")).toBe(true);
		expect(
			rulesFor(".evc-share-list").some((r) => /overflow(-x)?\s*:\s*(auto|scroll)/.test(r.body)),
		).toBe(false);
	});

	it("wraps the share header and makes the create button full width and wrapping", () => {
		expect(anyDeclares(".evc-share-list-header", "flex-wrap", (v) => v === "wrap")).toBe(true);
		const btn = rulesFor(".evc-share-list-header button");
		expect(btn.some((r) => declared(r, "width") === "100%")).toBe(true);
		expect(btn.some((r) => declared(r, "white-space") === "normal")).toBe(true);
	});

	it("gives server-row buttons a visible border", () => {
		expect(
			anyDeclares(".relay-server-btn", "border", (v) =>
				/^1px solid var\(--background-modifier-border\)$/.test(v),
			),
		).toBe(true);
	});

	it("gives the nav header a solid background while the Team Relay tab is open", () => {
		const hit = rulesFor(".evc-relay-settings-open .modal-header");
		expect(hit.length).toBeGreaterThan(0);
		expect(hit.some((r) => /var\(--background-(primary|secondary)\)/.test(declared(r, "background-color") ?? ""))).toBe(true);
	});
});

describe("SettingsPanel nav-header hook", () => {
	it("adds the marker class on mount and removes it on teardown", () => {
		const onMount = /onMount\(\(\) => \{([\s\S]*?)\n\t\}\);/.exec(panel);
		expect(onMount).not.toBeNull();
		const body = onMount![1];
		expect(body).toMatch(/classList\.add\("evc-relay-settings-open"\)/);
		expect(body).toMatch(/return \(\) => [^;]*classList\.remove\("evc-relay-settings-open"\)/);
		expect(panel).toMatch(/bind:this=\{contentEl\}/);
	});
});
