/**
 * Unit tests: mintGate.partitionByKnownGuid
 *
 * VaultShare._onReady()'s sync-timeout gate used to fail OPEN: if
 * onceFreshlySynced() didn't resolve within 30s, it logged a warning and
 * fell straight through to adoptLocalFiles(), which mints a fresh guid for
 * ANY local file the folderIndex doesn't already have an entry for --
 * indistinguishable, at that moment, from "another client already
 * published a guid for this path and I just haven't received it yet"
 *. This module is the pure decision
 * VaultShare.adoptLocalFiles() now makes when it can't confirm a fresh sync:
 * split files into ones it already has a guid for (safe either way) and
 * ones it doesn't (must not be minted this round).
 */

import { describe, test, expect } from "@jest/globals";
import { partitionByKnownGuid } from "../src/mintGate";

describe("partitionByKnownGuid", () => {
	test("a file already known to the folderIndex is classified as known", () => {
		const files = ["note.md"];
		const known = new Set(["note.md"]);

		const result = partitionByKnownGuid(
			files,
			(f) => f,
			(vpath) => known.has(vpath),
		);

		expect(result.known).toEqual(["note.md"]);
		expect(result.unknown).toEqual([]);
	});

	test("a file with no folderIndex entry is classified as unknown, not silently dropped", () => {
		const files = ["brand-new.md"];

		const result = partitionByKnownGuid(
			files,
			(f) => f,
			() => false,
		);

		expect(result.known).toEqual([]);
		expect(result.unknown).toEqual(["brand-new.md"]);
	});

	test("a mixed batch splits correctly, preserving relative order within each group", () => {
		const files = ["a.md", "b.md", "c.md", "d.md"];
		const known = new Set(["b.md", "d.md"]);

		const result = partitionByKnownGuid(
			files,
			(f) => f,
			(vpath) => known.has(vpath),
		);

		expect(result.known).toEqual(["b.md", "d.md"]);
		expect(result.unknown).toEqual(["a.md", "c.md"]);
	});

	test("uses the caller's own vpath projection, not the raw file value", () => {
		// Regression shape for the real call site: files are TAbstractFile-like
		// objects, and `hasEntry` is checked against their virtual path, not
		// the object itself.
		const files = [{ path: "root/note.md" }, { path: "root/other.md" }];
		const known = new Set(["note.md"]);

		const result = partitionByKnownGuid(
			files,
			(f) => f.path.replace(/^root\//, ""),
			(vpath) => known.has(vpath),
		);

		expect(result.known).toEqual([{ path: "root/note.md" }]);
		expect(result.unknown).toEqual([{ path: "root/other.md" }]);
	});

	test("empty input yields empty output on both sides", () => {
		const result = partitionByKnownGuid(
			[] as string[],
			(f) => f,
			() => true,
		);

		expect(result.known).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	test("RED CONTROL -- a hasEntry that always returns false (as if folderIndex.tracks() were stubbed to always miss) puts every file in unknown", () => {
		// This is the failure shape the fix closes: if the caller couldn't
		// tell "not tracked" from "not synced yet" and treated everything as
		// unknown-and-mintable, every one of these would previously have been
		// minted a fresh guid regardless of whether it was already shared.
		const files = ["a.md", "b.md", "c.md"];

		const result = partitionByKnownGuid(
			files,
			(f) => f,
			() => false,
		);

		expect(result.unknown).toEqual(files);
		expect(result.known).toEqual([]);
	});
});
