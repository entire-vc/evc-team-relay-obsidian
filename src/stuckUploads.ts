/**
 * Age tracking for pending upload claims (`uploadClaims`: vpath -> guid).
 *
 * The claim map itself carries no timestamp, so the age of each claim is kept
 * in a sidecar map keyed by guid (a rename moves the claim's vpath but keeps
 * its guid, so the age survives a rename).
 */

/** A claim older than this is shown to the user as "not uploaded". */
export const STUCK_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaimMap {
	forEach(cb: (guid: string, vpath: string) => void): void;
}

export interface AgeMap {
	get(guid: string): number | undefined;
	set(guid: string, at: number): unknown;
	delete(guid: string): unknown;
	forEach(cb: (at: number, guid: string) => void): void;
}

/**
 * Stamps every claim that has no age yet with `firstSeen(vpath)` and drops
 * ages whose claim is gone. Returns true when `ages` changed.
 */
export function reconcileClaimAges(
	claims: ClaimMap,
	ages: AgeMap,
	firstSeen: (vpath: string) => number,
): boolean {
	let changed = false;
	const live = new Set<string>();
	claims.forEach((guid, vpath) => {
		live.add(guid);
		if (ages.get(guid) === undefined) {
			ages.set(guid, firstSeen(vpath));
			changed = true;
		}
	});
	const gone: string[] = [];
	ages.forEach((_at, guid) => {
		if (!live.has(guid)) gone.push(guid);
	});
	for (const guid of gone) {
		ages.delete(guid);
		changed = true;
	}
	return changed;
}

/** Vpaths whose claim is older than `thresholdMs`, sorted. */
export function stuckClaimPaths(
	claims: ClaimMap,
	ages: AgeMap,
	now: number,
	thresholdMs: number = STUCK_UPLOAD_MS,
): string[] {
	const out: string[] = [];
	claims.forEach((guid, vpath) => {
		const at = ages.get(guid);
		if (at !== undefined && now - at > thresholdMs) out.push(vpath);
	});
	return out.sort();
}
