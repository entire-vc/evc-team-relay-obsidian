import * as fs from "fs";
import * as path from "path";

/**
 * Guards the defect class fixed across (six role="checkbox"
 * elements) and (five role="button" elements, one of them
 * revealing a secret on any keystroke): `on:keypress={fn}` with no key
 * filter fires on every character key, not just Enter/Space.
 *
 * This does NOT forbid on:keypress outright on these roles — several
 * components (ViewActions, Breadcrumbs, ShareListView, ShareDetailView) use
 * on:keypress deliberately with an event.key check, either inline or inside
 * the referenced handler, and are correct as written. What it forbids is a
 * keypress handler that acts unconditionally:
 * an inline arrow with no `.key` check in its body, or a bare handler
 * reference whose function body has no `.key` check either.
 */
const SRC = path.join(__dirname, "..", "src");
const TARGET_ROLE = /role\s*=\s*["'](checkbox|button)["']/;
const KEY_CHECK = /\.key\b/;

function svelteFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return svelteFiles(full);
		return e.isFile() && e.name.endsWith(".svelte") ? [full] : [];
	});
}

// Extracts opening-tag source text (e.g. `<div role="button" ... >`),
// tracking `{}` depth so an attribute expression's own `>` (inside an
// arrow function body, say) doesn't end the tag early.
function extractOpeningTags(content: string): Array<{ text: string; index: number }> {
	const tags: Array<{ text: string; index: number }> = [];
	let i = 0;
	while (i < content.length) {
		if (content[i] === "<" && /[A-Za-z]/.test(content[i + 1] ?? "")) {
			const start = i;
			let depth = 0;
			let j = i + 1;
			while (j < content.length) {
				const ch = content[j];
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
				else if (ch === ">" && depth <= 0) {
					j++;
					break;
				}
				j++;
			}
			tags.push({ text: content.slice(start, j), index: start });
			i = j;
		} else {
			i++;
		}
	}
	return tags;
}

// Given text starting right after `on:keypress=`, returns the balanced
// `{...}` expression (without the outer braces), or null if not found.
function extractBracedValue(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return text.slice(start + 1, i);
		}
	}
	return null;
}

// Given a function name, finds `function name(...) { ... }` in the file and
// returns its balanced body, or null if not found.
function findFunctionBody(content: string, name: string): string | null {
	const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`);
	const m = re.exec(content);
	if (!m) return null;
	const bodyStart = m.index + m[0].length;
	let depth = 1;
	for (let i = bodyStart; i < content.length; i++) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") {
			depth--;
			if (depth === 0) return content.slice(bodyStart, i);
		}
	}
	return null;
}

// True if this on:keypress={...} value acts unconditionally on any key —
// an inline arrow with no .key check, or a bare handler reference whose
// function body (found in the same file) has no .key check either.
function isUnfilteredKeypress(tagText: string, fileContent: string): boolean {
	const idx = tagText.indexOf("on:keypress=");
	if (idx === -1) return false;
	const value = extractBracedValue(tagText.slice(idx + "on:keypress=".length));
	if (value === null) return true; // couldn't parse — fail closed, featureKey it

	if (value.includes("=>")) {
		if (KEY_CHECK.test(value)) return false;
		// The arrow may delegate to a named function instead of checking
		// .key itself (Breadcrumbs' `(e) => handleKeypress(item, e)`) — walk
		// any function calls inside it and check their bodies too.
		const calls = [...value.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(
			(m) => m[1],
		);
		return !calls.some((name) => {
			const body = findFunctionBody(fileContent, name);
			return body !== null && KEY_CHECK.test(body);
		});
	}

	// Bare identifier reference, e.g. `on:keypress={activate}`.
	const name = value.trim();
	const body = findFunctionBody(fileContent, name);
	if (body === null) return true; // handler not found locally — fail closed
	return !KEY_CHECK.test(body);
}

describe("interactive-role elements", () => {
	it("carry no unfiltered on:keypress — role=checkbox/button must gate on Enter/Space", () => {
		const offenders = svelteFiles(SRC).flatMap((file) => {
			const content = fs.readFileSync(file, "utf8");
			return extractOpeningTags(content)
				.filter(
					(tag) =>
						TARGET_ROLE.test(tag.text) && isUnfilteredKeypress(tag.text, content),
				)
				.map((tag) => {
					const line = content.slice(0, tag.index).split("\n").length;
					return `${path.relative(SRC, file)}:${line}`;
				});
		});

		expect(offenders).toEqual([]);
	});

	it("detects an unfiltered handler and clears a filtered one", () => {
		// Negative control: without this, a broken tag-extractor or regex
		// would make the check above pass vacuously.
		const unconditionalInline = `<div\n\trole="button"\n\ttabindex="0"\n\ton:keypress={activate}\n>`;
		const src1 = `function activate() { doThing(); }`;
		const tags1 = extractOpeningTags(unconditionalInline);
		expect(isUnfilteredKeypress(tags1[0].text, src1)).toBe(true);

		const inlineNoCheck = `<div role="checkbox" on:keypress={() => toggle()}>`;
		expect(isUnfilteredKeypress(extractOpeningTags(inlineNoCheck)[0].text, "")).toBe(true);

		// A filtered inline handler must not fire.
		const inlineFiltered = `<div role="checkbox" on:keypress={(e) => { if (e.key === 'Enter') toggle(); }}>`;
		expect(isUnfilteredKeypress(extractOpeningTags(inlineFiltered)[0].text, "")).toBe(
			false,
		);

		// A filtered named handler (MembersEditToggle's pattern) must not fire.
		const namedFiltered = `<div role="button" on:keypress={handleToggle}>`;
		const src2 = `function handleToggle(event) {\n\tif (event.key === "Enter" || event.key === " ") dispatch("toggle");\n}`;
		expect(isUnfilteredKeypress(extractOpeningTags(namedFiltered)[0].text, src2)).toBe(
			false,
		);

		// A filtered inline handler that delegates to a named function
		// (Breadcrumbs' pattern) must not fire.
		const delegating = `<span role="button" on:keypress={(e) => handleKeypress(item, e)}>`;
		const src3 = `function handleKeypress(item, e) {\n\tif (e.key === "Enter") activate(item);\n}`;
		expect(isUnfilteredKeypress(extractOpeningTags(delegating)[0].text, src3)).toBe(false);

		// Same shape, but the delegate does NOT check .key — must still fire.
		const delegatingUnfiltered = `<span role="button" on:keypress={(e) => activateNow(item, e)}>`;
		const src4 = `function activateNow(item, e) {\n\tactivate(item);\n}`;
		expect(
			isUnfilteredKeypress(extractOpeningTags(delegatingUnfiltered)[0].text, src4),
		).toBe(true);

		// A fixed element (on:keydown, no on:keypress at all) must not fire.
		const fixed = `<div role="button" on:keydown={handleActivateKeydown}>`;
		expect(isUnfilteredKeypress(extractOpeningTags(fixed)[0].text, "")).toBe(false);

		// on:keypress outside role=checkbox/button is out of scope regardless.
		const outOfScope = `<button on:keypress={onRelayKeyPress} tabindex="0">`;
		expect(TARGET_ROLE.test(extractOpeningTags(outOfScope)[0].text)).toBe(false);
	});
});
