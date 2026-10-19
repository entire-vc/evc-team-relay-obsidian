import { describe, test, expect } from "@jest/globals";
import { buildConflictCopyPath } from "../src/conflictCopyPath";

describe("buildConflictCopyPath", () => {
	test("inserts the label before the extension, top-level file", () => {
		expect(buildConflictCopyPath("todo.md", "relay conflict 2026-07-21")).toBe(
			"todo (relay conflict 2026-07-21).md",
		);
	});

	test("preserves the directory for nested paths", () => {
		expect(
			buildConflictCopyPath("notes/sub/todo.md", "relay conflict 2026-07-21"),
		).toBe("notes/sub/todo (relay conflict 2026-07-21).md");
	});

	test("handles a file with no extension", () => {
		expect(buildConflictCopyPath("README", "conflict")).toBe(
			"README (conflict)",
		);
	});

	test("never collides with the original path", () => {
		const original = "notes/plan.md";
		const conflict = buildConflictCopyPath(original, "relay conflict x");
		expect(conflict).not.toBe(original);
	});
});
