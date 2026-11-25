/** Unit tests of the #114 first-sync conflict-copy summary collector. */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
	AttachConflictSummary,
	formatAttachConflictSummary,
	isDivergenceCopyLabel,
} from "../src/attachConflictSummary";

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

describe("AttachConflictSummary", () => {
	test("N counts distinct files; copies arriving within the quiet period form one batch", () => {
		const shown: string[] = [];
		const summary = new AttachConflictSummary("F", (m) => shown.push(m), { quietMs: 100 });

		summary.record("a.md", "a (relay conflict 1).md");
		jest.advanceTimersByTime(50);
		summary.record("a.md", "a (upload race 2).md");
		jest.advanceTimersByTime(50);
		summary.record("b.md", "b (relay conflict 1).md");
		jest.advanceTimersByTime(99);
		expect(shown).toEqual([]);
		jest.advanceTimersByTime(1);

		expect(shown).toEqual([
			"Team Relay (F): 2 files differed between local and server; conflict copies created: " +
				"a (relay conflict 1).md, a (upload race 2).md, b (relay conflict 1).md",
		]);
		summary.close();
	});

	test("the quiet period ends the collection: a later copy is not recorded or shown", () => {
		const shown: string[] = [];
		const summary = new AttachConflictSummary("F", (m) => shown.push(m), { quietMs: 100 });

		summary.record("a.md", "a (relay conflict 1).md");
		jest.advanceTimersByTime(100);
		expect(summary.isOpen).toBe(false);
		expect(summary.record("b.md", "b (relay conflict 2).md")).toBe(false);
		jest.advanceTimersByTime(60 * 60 * 1000);

		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("1 file differed");
	});

	test("closed collector records nothing and shows nothing", () => {
		const shown: string[] = [];
		const summary = new AttachConflictSummary("F", (m) => shown.push(m));
		summary.close();

		expect(summary.record("a.md", "a (relay conflict 1).md")).toBe(false);
		jest.advanceTimersByTime(60 * 60 * 1000);
		expect(shown).toEqual([]);
	});

	test("formatting: exactly 10 copies have no '+K more'; root share has no folder name", () => {
		const ten = Array.from({ length: 10 }, (_, i) => `c${i}.md`);
		expect(formatAttachConflictSummary("", 10, ten)).toBe(
			`Team Relay: 10 files differed between local and server; conflict copies created: ${ten.join(", ")}`,
		);
	});

	test("labels: relay conflict and upload race are differences, relay deleted is not", () => {
		expect(isDivergenceCopyLabel("relay conflict 2026-11-25")).toBe(true);
		expect(isDivergenceCopyLabel("upload race 2026-11-25")).toBe(true);
		expect(isDivergenceCopyLabel("relay deleted 2026-11-25")).toBe(false);
	});
});
