/**
 * Unit tests: findByPath + hasUnsyncedEdit
 *
 * The bug: pruneUntrackedFiles's trashLocal ran on any local file whose
 * path was no longer in the remote map (i.e. the remote deleted it),
 * regardless of whether the local file had edits the relay never received —
 * an offline edit racing a remote delete was silently destroyed, restorable
 * only from the OS trash if the user noticed in time.
 *
 * These two functions are the pure decision core of the fix: find the live
 * object (if any) still tracking a path, and decide whether its on-disk
 * content diverges from the last known synced content. Extracted
 * dependency-free (no Document.ts/pocketbase import — VaultShare.ts and
 * Document.ts transitively pull in the ESM-only `pocketbase` package, which
 * breaks ts-jest parsing) so they're directly testable; verified this
 * empirically against this exact import before extracting, same as prior
 * /extractions in this repo.
 */

import { describe, test, expect } from "@jest/globals";
import {
	findByPath,
	hasUnsyncedEdit,
	hasUnsyncedCanvasEdit,
} from "../src/preserveBeforeTrash";
import type { CanvasData } from "../src/HostCanvasView";

describe("hasUnsyncedEdit", () => {
	test("identical content — no unsynced edit", () => {
		expect(hasUnsyncedEdit("hello world", "hello world")).toBe(false);
	});

	test("differing content — unsynced edit present", () => {
		expect(hasUnsyncedEdit("hello world, edited offline", "hello world")).toBe(
			true,
		);
	});

	test("empty vs empty — no edit", () => {
		expect(hasUnsyncedEdit("", "")).toBe(false);
	});

	test("on-disk content vs empty synced doc — treated as an edit", () => {
		// The doc never had content synced (e.g. brand-new empty Y.Text), but
		// the vault file has something — must not be silently discarded.
		expect(hasUnsyncedEdit("some local content", "")).toBe(true);
	});
});

describe("hasUnsyncedCanvasEdit", () => {
	/**
	 * CanvasDocument equivalent of 's hasUnsyncedEdit (,
	 * follow-up to): a `.canvas` file is JSON, not plain text, so
	 * this must compare parsed structures rather than raw strings — the
	 * on-disk file is pretty-printed by Obsidian while the exported Y.Doc
	 * state (via CanvasDocument.exportData) isn't, so a naive string compare
	 * would false-positive on formatting alone for every unchanged canvas.
	 */
	function node(id: string, text: string): CanvasData["nodes"][number] {
		return { id, type: "text", text, x: 0, y: 0, width: 200, height: 100 };
	}

	test("identical content, different JSON formatting — no unsynced edit", () => {
		const synced: CanvasData = { nodes: [node("n1", "hello")], edges: [] };
		const onDisk = JSON.stringify(synced, null, 2); // pretty-printed, like Obsidian writes
		expect(hasUnsyncedCanvasEdit(onDisk, synced)).toBe(false);
	});

	test("differing node text — unsynced edit present", () => {
		const synced: CanvasData = { nodes: [node("n1", "hello")], edges: [] };
		const onDisk = JSON.stringify({
			nodes: [node("n1", "hello, edited offline")],
			edges: [],
		});
		expect(hasUnsyncedCanvasEdit(onDisk, synced)).toBe(true);
	});

	test("empty vs empty — no edit", () => {
		expect(hasUnsyncedCanvasEdit("", { nodes: [], edges: [] })).toBe(false);
	});

	test("on-disk content vs empty synced canvas — treated as an edit", () => {
		const onDisk = JSON.stringify({ nodes: [node("n1", "local only")], edges: [] });
		expect(hasUnsyncedCanvasEdit(onDisk, { nodes: [], edges: [] })).toBe(true);
	});

	test("unparsable on-disk JSON — fails CLOSED (treated as an edit) even against an empty synced canvas", () => {
		// Can't confirm it matches, so don't risk silently trashing it.
		expect(hasUnsyncedCanvasEdit("{not valid json", { nodes: [], edges: [] })).toBe(
			true,
		);
	});

	test("identical nodes/edges in different order — no unsynced edit (order is not content)", () => {
		// `syncedData` comes from iterating a Y.Map (order = per-key
		// first-insertion time into that CRDT map); the on-disk array is
		// whatever order Obsidian's canvas view serialized. These two
		// orderings have no reason to agree even when nothing was actually
		// edited, so a positional array comparison must not treat a mere
		// reorder as an unsynced edit.
		const synced: CanvasData = {
			nodes: [node("n1", "hello"), node("n2", "world")],
			edges: [],
		};
		const onDisk = JSON.stringify({
			nodes: [node("n2", "world"), node("n1", "hello")],
			edges: [],
		});
		expect(hasUnsyncedCanvasEdit(onDisk, synced)).toBe(false);
	});

	test("reordered AND edited — still detected as an unsynced edit", () => {
		const synced: CanvasData = {
			nodes: [node("n1", "hello"), node("n2", "world")],
			edges: [],
		};
		const onDisk = JSON.stringify({
			nodes: [node("n2", "world, edited offline"), node("n1", "hello")],
			edges: [],
		});
		expect(hasUnsyncedCanvasEdit(onDisk, synced)).toBe(true);
	});
});

describe("findByPath", () => {
	interface FakeThing {
		// `PathHolder.path` became `PathHolder.entryPath` in W10,
		// when `SyncableEntry.path` was renamed and this helper's only real
		// callers (VaultShare, over `SyncableEntry` values) moved with it.
		entryPath: string;
		kind: "document" | "other";
	}

	function fake(entryPath: string, kind: FakeThing["kind"]): FakeThing {
		return { entryPath, kind };
	}

	const isDocumentLike = (t: FakeThing) => t.kind === "document";

	test("finds the matching value by path when the predicate matches", () => {
		const values = [
			fake("a.md", "other"),
			fake("b.md", "document"),
			fake("c.md", "document"),
		];
		const found = findByPath(values, "b.md", isDocumentLike);
		expect(found).toBe(values[1]);
	});

	test("returns undefined when no value has that path", () => {
		const values = [fake("a.md", "document")];
		expect(findByPath(values, "missing.md", isDocumentLike)).toBeUndefined();
	});

	test("returns undefined when the path matches but the predicate rejects it", () => {
		// e.g. the live object at this path is a CanvasDocument/AttachmentFile, not a
		// Document — must not be mistaken for one.
		const values = [fake("a.md", "other")];
		expect(findByPath(values, "a.md", isDocumentLike)).toBeUndefined();
	});

	test("empty collection — returns undefined without throwing", () => {
		expect(findByPath([], "a.md", isDocumentLike)).toBeUndefined();
	});

	test("multiple matches at the same path — returns the LAST (most recently inserted), not the first", () => {
		// A map that's never pruned on a remote delete (VaultShare.trackedEntries)
		// can end up with a stale orphan and a live entry sharing the same
		// path after a delete-then-recreate cycle — the later insertion is
		// the live one, so returning the first match would silently compare
		// against ancient content instead.
		const stale = fake("a.md", "document");
		const live = fake("a.md", "document");
		const values = [stale, live];
		expect(findByPath(values, "a.md", isDocumentLike)).toBe(live);
	});
});
