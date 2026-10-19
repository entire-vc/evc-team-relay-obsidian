import { firstDifference, excerptAround } from "../src/textMismatch";

/**
 * These two back the resync() mismatch report: when the CRDT document and the
 * open editor disagree, the log says WHERE, with a bounded excerpt, instead of
 * dumping both note bodies into a log file that ships with bug reports.
 */
describe("firstDifference", () => {
	it("is the common length when the strings are identical", () => {
		expect(firstDifference("hello", "hello")).toBe(5);
	});

	it("is the shorter length when one is a prefix of the other", () => {
		expect(firstDifference("hello", "hello world")).toBe(5);
		expect(firstDifference("hello world", "hello")).toBe(5);
	});

	it("is 0 when they differ at the first character", () => {
		expect(firstDifference("abc", "xbc")).toBe(0);
	});

	it("is the index of the first differing character", () => {
		expect(firstDifference("the same, then not", "the same, then NOT")).toBe(15);
	});

	it("handles empty input on either side", () => {
		expect(firstDifference("", "")).toBe(0);
		expect(firstDifference("", "abc")).toBe(0);
		expect(firstDifference("abc", "")).toBe(0);
	});
});

describe("excerptAround", () => {
	const text = "0123456789".repeat(20); // 200 chars

	it("returns a window on both sides of the index", () => {
		expect(excerptAround(text, 100)).toBe(text.slice(60, 140));
	});

	it("clamps at the start rather than wrapping to the end", () => {
		// A negative slice start would silently return the TAIL of the string,
		// which would be actively misleading in a divergence report.
		expect(excerptAround(text, 5)).toBe(text.slice(0, 45));
	});

	it("stops at the end of the string", () => {
		expect(excerptAround(text, 195)).toBe(text.slice(155));
	});

	it("is bounded — never returns the whole document for a long one", () => {
		const long = "x".repeat(1_000_000);
		expect(excerptAround(long, 500_000).length).toBeLessThanOrEqual(80);
	});
});
