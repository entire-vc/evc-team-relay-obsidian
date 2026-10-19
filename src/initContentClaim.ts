import * as Y from "yjs";
import { waitForBufferFlush, type BufferedAmountSource } from "./websocketFlush";

/** Exported so a sibling coordination round (reconcileClaim.ts, a repeatable
 * claim for a DIFFERENT race than this module's one-shot init claim) can
 * share the same Y.Map without duplicating the map name as a second literal
 * that could drift from this one. */
export const META_MAP = "meta";
const CLAIM_KEY = "initClaim";
const DONE_KEY = "initDone";

/**
 * A claim is stale — safe to steal — once it's older than this AND (when
 * awareness data is available) its claimant is no longer connected. 30s is
 * generous relative to the claim→insert→markInitDone window (milliseconds
 * once settled) but short enough that a genuinely crashed claimant doesn't
 * leave a folder unseeded for long (matches this repo's existing ~30s scale,
 * e.g. InboundSyncPoller's DEFAULT_POLL_INTERVAL_MS).
 */
const CLAIM_TTL_MS = 30_000;

interface InitClaim {
	clientID: number;
	claimedAt: number;
}

function isClaim(value: unknown): value is InitClaim {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as InitClaim).clientID === "number" &&
		typeof (value as InitClaim).claimedAt === "number"
	);
}

/** Minimal shape of y-protocols' Awareness this module needs — kept narrow
 * so this stays dependency-free and testable with a plain fake. */
export interface AwarenessStates {
	getStates(): Map<number, unknown>;
}

function isClaimStale(
	claim: InitClaim,
	awareness: AwarenessStates | null | undefined,
	now: () => number,
): boolean {
	// Awareness, when available, is treated as authoritative in BOTH
	// directions: a claimant missing from it is reclaimed immediately (no
	// need to wait out the TTL), and a claimant it reports as still connected
	// is never reclaimed regardless of the TTL — TTL is a fallback for when
	// we have no liveness data, not a ceiling that overrides liveness data we
	// do have. This is contingent on the awareness view itself being caught
	// up: this codebase's own awareness resend logic (client/provider.ts,
	// ) documents that the first broadcast after connect can lag behind
	// content sync, so a just-arrived claimant could theoretically be
	// (wrongly) reclaimed if their claim write is visible before their
	// awareness presence is. `awaitClaimSettled`'s quiet-period watches the
	// same reliable channel the claim itself travels over (not awareness),
	// which is the actual backstop against a resulting double-insert — this
	// function alone is a heuristic, not a standalone correctness guarantee.
	if (awareness) {
		return !awareness.getStates().has(claim.clientID);
	}
	return now() - claim.claimedAt > CLAIM_TTL_MS;
}

/**
 * Idempotent "who seeds this brand-new Y.Doc with the local file's content"
 * claim (with TTL/reclaim and a real-signal settle).
 *
 * Two clients opening the SAME newly-shared folder for the first time (typical
 * team onboarding) can both observe an empty relay-side Y.Text and both insert
 * their local file's content — Yjs has no causal link between the two inserts,
 * so it merges them as two contiguous blocks instead of one (duplicated text).
 *
 * Fix shape: claim a slot in a shared Y.Map, give a concurrently-connecting
 * client's own claim a settle window to arrive over the relay, then let only
 * the deterministic winner (Yjs Y.Map's built-in last-writer-wins conflict
 * resolution converges every replica on the SAME winning clientID once both
 * claims have been exchanged) perform the insert. The loser never inserts —
 * it picks up the winner's content via ordinary CRDT sync once it arrives.
 *
 * A claim now carries a timestamp and is reclaimable: if the client that won
 * the claim dies/disconnects before `insert`/`markInitDone()`, the original
 * design pinned CLAIM_KEY to that dead clientID FOREVER — no future client,
 * including a fresh session, could ever win the claim again, so the document
 * silently never got seeded. `claimInitIfUnclaimed` now re-claims a stale
 * claim (dead per awareness, or just old per the TTL) instead of treating any
 * existing claim as final.
 *
 * Callers: `claimInitIfUnclaimed` immediately, then `awaitClaimSettled` (a
 * real signal, not a fixed delay — see its own doc comment), then
 * `wonInitClaim`.
 */
export function claimInitIfUnclaimed(
	ydoc: Y.Doc,
	awareness?: AwarenessStates | null,
	now: () => number = Date.now,
): void {
	const meta = ydoc.getMap(META_MAP);
	if (meta.get(DONE_KEY)) {
		return;
	}
	const existing = meta.get(CLAIM_KEY);
	if (isClaim(existing) && !isClaimStale(existing, awareness, now)) {
		return;
	}
	ydoc.transact(() => {
		// Re-check inside the transaction: Yjs transactions aren't a
		// distributed lock, so a concurrent reclaim from another client can
		// still race this one — that's fine, it's the same CRDT tie-break
		// (last-writer-wins, converges identically on every replica) the
		// original claim already relied on, just re-armed for reclaim.
		const current = meta.get(CLAIM_KEY);
		if (!isClaim(current) || isClaimStale(current, awareness, now)) {
			meta.set(CLAIM_KEY, { clientID: ydoc.clientID, claimedAt: now() });
		}
	});
}

export interface AwaitClaimSettledOptions {
	/** Real per-protocol signal that OUR OWN claim write has left the local
	 * socket buffer (see websocketFlush.ts) before we start watching for a
	 * competing one — a null/undefined socket just skips this component. */
	socket?: BufferedAmountSource | null;
	/** How long to wait, after the LAST observed change to the claim, before
	 * treating it as settled — re-armed on every competing write. Same
	 * quiet-period shape as the fleet's alert roll-up collector: a fixed
	 * window can't tell "no competitor" from "competitor hasn't arrived yet",
	 * but a quiet period that keeps resetting while writes keep landing can.
	 */
	quietMs?: number;
	/** Absolute ceiling so a flapping doc (repeated reclaims) can't hang the
	 * caller forever — same role as maxWaitMs in waitForBufferFlush. */
	maxWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Which Y.Map key to watch for quiet. Defaults to this module's own
	 * CLAIM_KEY ("initClaim") — reconcileClaim.ts passes its own key so the
	 * two independent coordination rounds (seed-a-brand-new-doc vs.
	 * safe-reconcile-fast-path) never satisfy each other's settle-wait. */
	claimKey?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Replaces the fixed `await sleep(1000)` settle window with a real signal.
 *
 * There's no per-update delivery ack in this Yjs sync protocol (same
 * limitation `waitForBufferFlush`/documents), so there's no message
 * that means "the competing client's claim, if any, has now arrived" — but
 * `waitForBufferFlush`'s bufferedAmount signal only proves OUR OWN write left
 * OUR OWN socket, which answers a different question (can we disconnect
 * safely) than the one this call site needs (has a sibling claim had time to
 * reach us). The real signal available for THIS question is the claim key
 * itself going quiet: as long as `meta`'s CLAIM_KEY keeps changing (a
 * competing client is still reclaiming/arriving), we keep waiting; once it's
 * been quiet for `quietMs`, we treat the race as settled. A fixed
 * `maxWaitMs` ceiling still bounds the worst case (e.g. a flapping doc) the
 * way it does in `waitForBufferFlush` — the flush wait and the quiet-period
 * wait share ONE deadline computed from `maxWaitMs`, not two independent
 * budgets, so a stalled socket can't silently double the documented ceiling
 * by burning a full `maxWaitMs` in each phase.
 *
 * In the common (non-racing) case this also resolves faster than the old
 * fixed 1000ms — it only waits out one quiet period, not a blanket delay.
 */
export async function awaitClaimSettled(
	ydoc: Y.Doc,
	options: AwaitClaimSettledOptions = {},
): Promise<void> {
	const {
		socket = null,
		quietMs = 300,
		maxWaitMs = 3000,
		sleep = defaultSleep,
		now = Date.now,
		claimKey = CLAIM_KEY,
	} = options;

	const deadline = now() + maxWaitMs;

	// Make sure our own claim has actually left our socket before we start
	// watching for a sibling's — otherwise we could observe "quiet" purely
	// because our own write is still sitting in our outgoing buffer. Passes
	// the REMAINING budget against the shared deadline, not a fresh maxWaitMs.
	await waitForBufferFlush(socket, {
		maxWaitMs: Math.max(0, deadline - now()),
		sleep,
		now,
	});

	const meta = ydoc.getMap(META_MAP);
	let lastChange = now();
	const onChange = (event: Y.YMapEvent<unknown>) => {
		if (event.keysChanged.has(claimKey)) {
			lastChange = now();
		}
	};
	meta.observe(onChange);
	try {
		while (now() - lastChange < quietMs && now() < deadline) {
			await sleep(Math.min(quietMs, Math.max(0, deadline - now())));
		}
	} finally {
		meta.unobserve(onChange);
	}
}

/**
 * True iff THIS replica should perform the initial-content insert: nobody
 * has finished initializing, the text is still empty, and this client's
 * clientID is the one the shared claim converged on.
 */
export function wonInitClaim(ydoc: Y.Doc, text: Y.Text): boolean {
	const meta = ydoc.getMap(META_MAP);
	if (meta.get(DONE_KEY) === true) {
		return false;
	}
	if (text.length > 0) {
		return false;
	}
	const claim = meta.get(CLAIM_KEY);
	return isClaim(claim) && claim.clientID === ydoc.clientID;
}

/** Marks initialization complete so a later-arriving claim never re-inserts. */
export function markInitDone(ydoc: Y.Doc): void {
	ydoc.getMap(META_MAP).set(DONE_KEY, true);
}
