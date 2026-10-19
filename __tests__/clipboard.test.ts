import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { copyToClipboard } from "../src/utils/clipboard";
import { testGlobal } from "./mocks/testGlobal";

const g = testGlobal as Record<string, unknown>;

describe("copyToClipboard", () => {
	let original: unknown;

	beforeEach(() => {
		original = g.activeWindow;
	});

	afterEach(() => {
		g.activeWindow = original;
	});

	test("writes text through the active window's clipboard", async () => {
		const writeText = jest.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
		g.activeWindow = { navigator: { clipboard: { writeText } } };

		await copyToClipboard("hello");

		expect(writeText).toHaveBeenCalledWith("hello");
	});

	test("propagates a rejected write", async () => {
		const writeText = jest.fn<(t: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
		g.activeWindow = { navigator: { clipboard: { writeText } } };

		await expect(copyToClipboard("x")).rejects.toThrow("denied");
	});

	test("throws when the clipboard API is absent", () => {
		g.activeWindow = { navigator: {} };

		expect(() => copyToClipboard("x")).toThrow();
	});

	test("falls back to window.navigator.clipboard when activeWindow is absent", async () => {
		const writeText = jest.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
		const hadWindow = "window" in g;
		const originalWindow = g.window;
		delete g.activeWindow;
		g.window = { navigator: { clipboard: { writeText } } };
		try {
			await copyToClipboard("fallback");
		} finally {
			if (hadWindow) g.window = originalWindow;
			else delete g.window;
		}

		expect(writeText).toHaveBeenCalledWith("fallback");
	});
});
