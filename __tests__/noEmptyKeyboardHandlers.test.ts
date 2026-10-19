import * as fs from "fs";
import * as path from "path";

/**
 * Guards the defect class fixed in IssueReportModalContent.svelte: a
 * `role="checkbox"` div carried `on:keypress={() => {}}`, an empty handler
 * whose only effect was to silence Svelte's a11y-click-events-have-key-events
 * warning. The lint went quiet, the control stayed mouse-only, and the code
 * read as deliberate to everyone who saw it afterwards.
 *
 * An empty handler is never a legitimate suppression either: it calls neither
 * preventDefault() nor stopPropagation(), so it cannot cancel anything. If a
 * key event genuinely needs to be swallowed, the handler must say so by
 * calling one of those — which this check allows.
 */
const SRC = path.join(__dirname, "..", "src");
// on:keydown / on:keyup / on:keypress, with or without modifiers, bound to an
// arrow function whose body is empty (`{}` or `{ }` or nothing but whitespace).
const EMPTY_KEY_HANDLER =
	/on:key(?:down|up|press)(?:\|[a-zA-Z|]+)?=\{\s*\(\s*[^)]*\)\s*=>\s*\{\s*\}\s*\}/;

function svelteFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return svelteFiles(full);
		return e.isFile() && e.name.endsWith(".svelte") ? [full] : [];
	});
}

describe("svelte components", () => {
	it("has no empty keyboard handlers standing in for real key support", () => {
		const offenders = svelteFiles(SRC)
			.flatMap((file) =>
				fs
					.readFileSync(file, "utf8")
					.split("\n")
					.map((line, i) => ({ file, line: i + 1, text: line.trim() }))
					// Skip comment lines — prose describing the pattern (this
					// fix's own explanatory comment, for one) is not code.
					.filter(({ text }) => !text.startsWith("//") && !text.startsWith("*"))
					.filter(({ text }) => EMPTY_KEY_HANDLER.test(text)),
			)
			.map(({ file, line, text }) => `${path.relative(SRC, file)}:${line}  ${text}`);

		expect(offenders).toEqual([]);
	});

	it("detects an empty handler when one is present", () => {
		// Negative control: without this, a broken regex would make the check
		// above pass vacuously.
		expect(EMPTY_KEY_HANDLER.test('on:keypress={() => {}}')).toBe(true);
		expect(EMPTY_KEY_HANDLER.test('on:keydown={(e) => { }}')).toBe(true);
		expect(EMPTY_KEY_HANDLER.test('on:keydown={handleCheckboxKeydown}')).toBe(false);
		expect(EMPTY_KEY_HANDLER.test('on:keypress={() => toggleIncludeLogs()}')).toBe(false);
	});
});
