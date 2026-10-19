"use strict";

/**
 * Splits a list of local files into ones this client already has a guid
 * for (safe to process regardless of whether a fresh sync just landed) and
 * ones it doesn't (would need a fresh guid minted this round).
 *
 * Extracted as a pure function so `VaultShare._onReady()`'s 30s sync-timeout
 * gate is testable without constructing a full VaultShare: a
 * timed-out sync means "no metadata for this vpath anywhere" and "this vpath
 * genuinely isn't tracked yet" read as the same local `false` -- an
 * already-shared file this client just hasn't heard about yet would
 * otherwise be minted a fresh, disjoint guid instead of waiting
 * to learn the real one. Files already in `hasEntry` are unaffected either
 * way; only genuinely-unknown files are held back.
 */
export function partitionByKnownGuid<T>(
	files: T[],
	getVPath: (file: T) => string,
	hasEntry: (vpath: string) => boolean,
): { known: T[]; unknown: T[] } {
	const known: T[] = [];
	const unknown: T[] = [];
	for (const file of files) {
		(hasEntry(getVPath(file)) ? known : unknown).push(file);
	}
	return { known, unknown };
}
