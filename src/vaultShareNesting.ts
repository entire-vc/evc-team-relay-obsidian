"use strict";

/**
 * Pure nesting-conflict check for shared folders, extracted from
 * ShareRegistry.findNestingConflict so it can be unit-tested directly --
 * VaultShare.ts transitively imports Document.ts/AuthSession.ts
 * (pocketbase, ESM-only), which Jest cannot parse.
 *
 * Relay does not support nested shares: two ShareRegistry covering
 * overlapping files (e.g. share "A", then share "A/B") race on which one
 * processes a given file, non-deterministically.
 *
 * Returns the path of the existing share that conflicts with `newPath` by
 * nesting in either direction -- newPath is a subfolder of an existing
 * share, or newPath would itself contain one -- or null if sharing
 * `newPath` is safe.
 *
 * The vault root is represented as `""` (see vaultRootPath.ts) and
 * trivially contains -- and is contained by -- every other path. The
 * generic `path + sep` prefix math never matches an empty string, so root
 * has to be special-cased in both directions before falling through to it.
 */
export function findNestingConflictPath(
	newPath: string,
	existingPaths: string[],
	sep: string,
): string | null {
	if (newPath === "") {
		// Root trivially contains every OTHER existing share. An existing
		// root at the exact same path ("" === "") is a duplicate-path
		// collision, not a nesting conflict -- consistent with the
		// exact-match exclusion the non-root branches below rely on
		// (see the "exact path match is not itself a nesting conflict"
		// test case).
		const conflict = existingPaths.find((p) => p !== "");
		return conflict ?? null;
	}
	for (const existingPath of existingPaths) {
		if (existingPath === "" || newPath.startsWith(existingPath + sep)) {
			return existingPath;
		}
	}
	for (const existingPath of existingPaths) {
		if (existingPath.startsWith(newPath + sep)) {
			return existingPath;
		}
	}
	return null;
}
