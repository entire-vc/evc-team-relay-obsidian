/**
 * Unit tests: dedupeFolderSharesByPath
 *
 * Covers:
 *   (a) multiple folder shares at the same path collapse to the newest one
 *   (b) non-folder (doc) shares always pass through, even at a colliding path
 *   (c) a folder path with only one share passes through unchanged
 *   (d) unrelated paths are all kept
 *   (e) ties on created_at keep exactly one (no duplicate survives)
 *   (f) input order doesn't matter -- the newest wins regardless of position
 */

import { describe, test, expect } from "@jest/globals";
import { dedupeFolderSharesByPath } from "src/dedupeFolderSharesByPath";

interface FakeShare {
	id: string;
	path: string;
	kind: "folder" | "doc";
	created_at: string;
}

function share(overrides: Partial<FakeShare> = {}): FakeShare {
	return {
		id: "id-1",
		path: "shared/note.md",
		kind: "folder",
		created_at: "2026-08-27T08:00:00.000Z",
		...overrides,
	};
}

describe("dedupeFolderSharesByPath", () => {
	test("collapses multiple folder shares at the same path to the newest one", () => {
		const oldest = share({ id: "old", path: "e2e-collab-folder", created_at: "2026-08-27T08:27:00.000Z" });
		const middle = share({ id: "mid", path: "e2e-collab-folder", created_at: "2026-08-27T08:35:00.000Z" });
		const newest = share({ id: "new", path: "e2e-collab-folder", created_at: "2026-08-27T08:49:00.000Z" });

		const result = dedupeFolderSharesByPath([oldest, middle, newest]);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("new");
	});

	test("input order doesn't matter -- the newest wins regardless of position", () => {
		const oldest = share({ id: "old", path: "p", created_at: "2026-08-27T08:00:00.000Z" });
		const newest = share({ id: "new", path: "p", created_at: "2026-08-27T09:00:00.000Z" });

		// newest listed FIRST this time
		const result = dedupeFolderSharesByPath([newest, oldest]);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("new");
	});

	test("doc-kind shares always pass through, even at a colliding path", () => {
		const doc1 = share({ id: "doc-1", kind: "doc", path: "same-path.md", created_at: "2026-08-27T08:00:00.000Z" });
		const doc2 = share({ id: "doc-2", kind: "doc", path: "same-path.md", created_at: "2026-08-27T08:01:00.000Z" });

		const result = dedupeFolderSharesByPath([doc1, doc2]);

		expect(result).toHaveLength(2);
		expect(result.map((s) => s.id).sort()).toEqual(["doc-1", "doc-2"]);
	});

	test("a folder path with only one share passes through unchanged", () => {
		const only = share({ id: "solo", path: "solo-folder" });

		const result = dedupeFolderSharesByPath([only]);

		expect(result).toEqual([only]);
	});

	test("unrelated paths are all kept", () => {
		const a = share({ id: "a", path: "folder-a" });
		const b = share({ id: "b", path: "folder-b" });
		const c = share({ id: "c", path: "folder-c" });

		const result = dedupeFolderSharesByPath([a, b, c]);

		expect(result).toHaveLength(3);
		expect(result.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
	});

	test("ties on created_at keep exactly one survivor, not both", () => {
		const tied1 = share({ id: "t1", path: "tied", created_at: "2026-08-27T08:00:00.000Z" });
		const tied2 = share({ id: "t2", path: "tied", created_at: "2026-08-27T08:00:00.000Z" });

		const result = dedupeFolderSharesByPath([tied1, tied2]);

		expect(result).toHaveLength(1);
		expect(["t1", "t2"]).toContain(result[0].id);
	});

	test("mixed folders (with a collision) and docs and a lone folder all resolve correctly", () => {
		const oldFolder = share({ id: "old-folder", path: "e2e-collab-folder", created_at: "2026-08-27T08:27:00.000Z" });
		const newFolder = share({ id: "new-folder", path: "e2e-collab-folder", created_at: "2026-08-27T08:49:00.000Z" });
		const lonelyFolder = share({ id: "lonely", path: "other-folder", created_at: "2026-08-27T08:10:00.000Z" });
		const doc = share({ id: "a-doc", kind: "doc", path: "note.md", created_at: "2026-08-27T08:05:00.000Z" });

		const result = dedupeFolderSharesByPath([oldFolder, doc, newFolder, lonelyFolder]);

		expect(result.map((s) => s.id).sort()).toEqual(["a-doc", "lonely", "new-folder"]);
	});
});
