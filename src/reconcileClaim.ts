import * as Y from "yjs";
import { META_MAP, awaitClaimSettled, type AwaitClaimSettledOptions } from "./initContentClaim";

const RECONCILE_CLAIM_KEY = "reconcileClaim";

interface ReconcileClaim {
	clientID: number;
	claimedAt: number;
}

function isReconcileClaim(value: unknown): value is ReconcileClaim {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ReconcileClaim).clientID === "number" &&
		typeof (value as ReconcileClaim).claimedAt === "number"
	);
}

/**
 * Closes the two-client race in TransferQueue.reconcileRelayContent()'s
 * "safe, no-conflict-copy" fast path (; the fast path itself
 * is's fix for a DIFFERENT, single-client race).
 *
 * That fast path's safety condition -- `base === syncedText`, i.e. "the
 * relay hasn't moved since I last agreed with it, so this divergence must be
 * MY OWN unsynced edit" -- is a purely LOCAL, point-in-time read. Two
 * clients editing the same file at genuinely the same moment (one mid vault
 * restart, say) can BOTH observe `base === syncedText` against the SAME
 * stale shared history, because neither has yet received the other's
 * concurrent write. Both then call `applyDiffToYText()` -- a raw CRDT bulk
 * insert of their own full edit at the same anchor position -- and Yjs,
 * which has no causal link between the two, orders them sequentially
 * instead of merging or flagging a conflict: the file ends up with both
 * edits concatenated, no separator, no conflict-copy on either side.
 * Reproduced live 2/2 with a two-client restart probe before this
 * fix, confirmed via injected instrumentation: client B's own reconcile read
 * `syncedText` as the pre-race base a full ~3.5s AFTER client A's insert had
 * already reached the shared doc, because B's local replica hadn't received
 * A's broadcast yet -- exactly the gap this claim closes.
 *
 * Same fix shape as `initContentClaim.ts`'s claim for the sibling
 * "two clients seed the same brand-new empty doc" race: claim intent in a
 * shared Y.Map key, give a competing claim a real settle window to arrive
 * (not a fixed delay), then let Yjs's Y.Map last-writer-wins resolution --
 * which converges identically on every replica -- pick ONE deterministic
 * winner. Unlike that claim, this one is NOT one-shot/permanently-done:
 * reconciliation legitimately happens many times over a document's life, so
 * every attempt takes a fresh claim rather than checking a "done" flag.
 *
 * Caller contract: call `claimReconcile()`, then `awaitReconcileSettled()`,
 * then `wonReconcileClaim()`. The WINNER may proceed with the safe fast-path
 * apply. The LOSER must NOT apply via the fast path -- its edit is still
 * real and unsynced, so the caller re-reads the (now possibly different,
 * post-settle) syncedText and falls through to `reconcileWithConflictCopy()`
 * instead, which correctly diffs against whatever the winner just committed
 * and preserves the loser's own content as a conflict-copy rather than
 * silently concatenating it in.
 */
export function claimReconcile(ydoc: Y.Doc, now: () => number = Date.now): void {
	const meta = ydoc.getMap(META_MAP);
	ydoc.transact(() => {
		meta.set(RECONCILE_CLAIM_KEY, { clientID: ydoc.clientID, claimedAt: now() });
	});
}

/** True iff this replica's clientID is the one the shared claim converged on. */
export function wonReconcileClaim(ydoc: Y.Doc): boolean {
	const meta = ydoc.getMap(META_MAP);
	const claim = meta.get(RECONCILE_CLAIM_KEY);
	return isReconcileClaim(claim) && claim.clientID === ydoc.clientID;
}

/** Thin wrapper over `awaitClaimSettled` pinned to this module's own claim
 * key, so a settle-wait here can never be satisfied by traffic on
 * initContentClaim's unrelated init-claim round. */
export async function awaitReconcileSettled(
	ydoc: Y.Doc,
	options: Omit<AwaitClaimSettledOptions, "claimKey"> = {},
): Promise<void> {
	await awaitClaimSettled(ydoc, { ...options, claimKey: RECONCILE_CLAIM_KEY });
}
