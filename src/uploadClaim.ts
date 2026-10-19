import * as Y from "yjs";
import { waitForBufferFlush, type BufferedAmountSource } from "./websocketFlush";

const CLAIMS_MAP = "uploadClaims";

/**
 * A claim is stale — safe to steal — once it's older than this AND (when
 * awareness data is available) its claimant is no longer connected. Same
 * scale as initContentClaim.ts's CLAIM_TTL_MS — this module reuses that
 * claim/settle/decide shape, just keyed per-vpath instead of a single fixed
 * key (see module doc comment below for why).
 */
const CLAIM_TTL_MS = 30_000;

interface VpathClaim {
	clientID: number;
	claimedAt: number;
}

function isClaim(value: unknown): value is VpathClaim {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as VpathClaim).clientID === "number" &&
		typeof (value as VpathClaim).claimedAt === "number"
	);
}

/** Minimal shape of y-protocols' Awareness this module needs — kept narrow
 * so this stays dependency-free and testable with a plain fake, matching
 * initContentClaim.ts's AwarenessStates. */
export interface AwarenessStates {
	getStates(): Map<number, unknown>;
}

function isClaimStale(
	claim: VpathClaim,
	awareness: AwarenessStates | null | undefined,
	now: () => number,
): boolean {
	if (awareness) {
		return !awareness.getStates().has(claim.clientID);
	}
	return now() - claim.claimedAt > CLAIM_TTL_MS;
}

/**
 * Idempotent "who gets to be canonical for this brand-new vpath" claim
 *.
 *
 * (initContentClaim.ts) fixed a race where two clients opening the
 * SAME newly-shared folder both insert into an already-shared, already-
 * identified empty Y.Text. VaultShare.publishDoc()/publishCanvas() have a
 * DEEPER version of the same race: for a vpath neither client has seen
 * before, FolderIndex.new() mints the file's `guid` as a random uuidv4() into
 * `uploadClaims`, a per-DEVICE `VaultScopedMap` — never a Y.Map, never
 * replicated to peers. Two clients racing on the same new vpath each mint a
 * DIFFERENT guid before either publishes to the shared `meta` map, so
 * initContentClaim.ts's guid-keyed claim has nothing to claim ON — the two
 * clients aren't even contending for the same key.
 *
 * This claims the vpath itself, one level up, on the VaultShare's OWN
 * already-synced `ydoc` (not a per-document Y.Doc, which doesn't exist yet
 * for the loser) — same claim→settle→decide shape and TTL/awareness-reclaim
 * logic as initContentClaim.ts, generalized to a Y.Map of many keys (one
 * per racing vpath) instead of a single fixed key, since many files can be
 * discovered new at once (e.g. initial sync of a folder with pre-existing
 * local files on both sides).
 *
 * Callers: `claimVpathIfUnclaimed` immediately, then `awaitVpathClaimSettled`,
 * then `wonVpathClaim`. The loser never mints/publishes its own guid for
 * this vpath — see VaultShare.adoptWinnerDoc/adoptWinnerCanvas.
 */
export function claimVpathIfUnclaimed(
	ydoc: Y.Doc,
	vpath: string,
	awareness?: AwarenessStates | null,
	now: () => number = Date.now,
): void {
	const claims = ydoc.getMap<VpathClaim>(CLAIMS_MAP);
	const existing = claims.get(vpath);
	if (isClaim(existing) && !isClaimStale(existing, awareness, now)) {
		return;
	}
	ydoc.transact(() => {
		// Re-check inside the transaction: Yjs transactions aren't a
		// distributed lock, so a concurrent reclaim from another client can
		// still race this one — same CRDT tie-break (last-writer-wins,
		// converges identically on every replica) the claim already relies
		// on, just re-armed for reclaim.
		const current = claims.get(vpath);
		if (!isClaim(current) || isClaimStale(current, awareness, now)) {
			claims.set(vpath, { clientID: ydoc.clientID, claimedAt: now() });
		}
	});
}

export interface AwaitVpathClaimSettledOptions {
	/** Real per-protocol signal that OUR OWN claim write has left the local
	 * socket buffer before we start watching for a competing one. */
	socket?: BufferedAmountSource | null;
	/** How long to wait, after the LAST observed change to THIS vpath's
	 * claim, before treating it as settled — re-armed on every competing
	 * write. */
	quietMs?: number;
	/** Absolute ceiling so a flapping claim can't hang the caller forever. */
	maxWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Waits until `vpath`'s claim entry has been quiet for `quietMs` (or
 * `maxWaitMs` elapses) — same real-signal shape as initContentClaim.ts's
 * awaitClaimSettled, watching only the ONE key this call cares about so
 * concurrent claims on OTHER vpaths don't reset each other's quiet period.
 */
export async function awaitVpathClaimSettled(
	ydoc: Y.Doc,
	vpath: string,
	options: AwaitVpathClaimSettledOptions = {},
): Promise<void> {
	const {
		socket = null,
		quietMs = 300,
		maxWaitMs = 3000,
		sleep = defaultSleep,
		now = Date.now,
	} = options;

	const deadline = now() + maxWaitMs;

	await waitForBufferFlush(socket, {
		maxWaitMs: Math.max(0, deadline - now()),
		sleep,
		now,
	});

	const claims = ydoc.getMap<VpathClaim>(CLAIMS_MAP);
	let lastChange = now();
	const onChange = (event: Y.YMapEvent<VpathClaim>) => {
		if (event.keysChanged.has(vpath)) {
			lastChange = now();
		}
	};
	claims.observe(onChange);
	try {
		while (now() - lastChange < quietMs && now() < deadline) {
			await sleep(Math.min(quietMs, Math.max(0, deadline - now())));
		}
	} finally {
		claims.unobserve(onChange);
	}
}

/**
 * True iff THIS replica's clientID is the one `vpath`'s claim converged on.
 * Callers are expected to have already confirmed the vpath wasn't already
 * resolved before claiming (FolderIndex.tracks(vpath)) — unlike initContentClaim's
 * wonInitClaim, there's no separate "done" featureKey here: folderIndex.tracks(vpath)
 * becoming true (once the winner publishes) IS the completion signal, and
 * candidate detection already filters on it before a claim is ever attempted.
 */
export function wonVpathClaim(ydoc: Y.Doc, vpath: string): boolean {
	const claims = ydoc.getMap<VpathClaim>(CLAIMS_MAP);
	const claim = claims.get(vpath);
	return isClaim(claim) && claim.clientID === ydoc.clientID;
}
