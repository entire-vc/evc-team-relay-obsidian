/** Anything addressed by a vault-relative entry path — see `SyncableEntry`. */
interface PathRef {
	entryPath: string;
}

function firstInt(segment: string): number | null {
	const match = segment.match(/\d+/);
	return match ? parseInt(match[0], 10) : null;
}

/** Ordering rule itself, over two raw path strings. */
export function comparePathStrings(a: string, b: string): number {
	const aSegments = a.split("/");
	const bSegments = b.split("/");

	// Top-level files always sort after anything nested one folder deep.
	if (aSegments.length === 2 && bSegments.length > 2) return 1;
	if (bSegments.length === 2 && aSegments.length > 2) return -1;

	const shared = Math.min(aSegments.length, bSegments.length);
	for (let depth = 0; depth < shared; depth++) {
		const aPart = aSegments[depth];
		const bPart = bSegments[depth];
		if (aPart === bPart) continue;

		if (depth === aSegments.length - 1) {
			const aNum = firstInt(aPart);
			const bNum = firstInt(bPart);
			if (aNum !== null && bNum !== null && aNum !== bNum) {
				return aNum - bNum;
			}
		}
		return aPart.localeCompare(bPart);
	}

	// Everything matched up to the shorter path — the shorter one wins.
	return aSegments.length - bSegments.length;
}

/** Same ordering, for anything carrying a `SyncableEntry`-style entry path. */
export function compareVaultPaths(a: PathRef, b: PathRef): number {
	return comparePathStrings(a.entryPath, b.entryPath);
}
