/**
 * Keeps only the most-recently-created share per local `path` among
 * folder-kind shares; every other share (doc-kind, or a folder path that
 * appears only once) passes through untouched.
 *
 * Exists for `loadRelayOnPremShares()`'s per-share migrate/create loop
 * (`main.ts`, both the multi-server and legacy single-server branches):
 * that loop matches an existing local `VaultShare` by path and migrates it
 * (`shareRegistry.delete()` + `shareRegistry.new()` + `connect()`) whenever
 * the share it's currently looking at doesn't match the VaultShare's guid.
 * If the control plane ever returns MORE THAN ONE folder share at the same
 * path -- confirmed live on the shared e2e stand, where a fixed
 * reproduction path accumulates a fresh `shares` row on every run without
 * ever being cleaned up (15 rows at `e2e-collab-folder` in one 30-minute
 * window) -- the loop doesn't recognize this as one folder with stale
 * duplicates: it migrates the SAME local VaultShare through EVERY matching
 * row in whatever order the API happens to return them, tearing down and
 * reconnecting a fresh instance each time.
 *
 * That churn is not just wasteful. Each intermediate VaultShare's own
 * `_onReady()` → `adoptLocalFiles()` → `uploadDocumentViaSocket()` →
 * `connect()` chain is independently async and is never cancelled by
 * `shareRegistry.delete()` -- it keeps running against whichever (now
 * abandoned) relay doc it was connecting to. If that abandoned doc holds
 * different content than the on-disk file (a near-certainty when it's a
 * stale row from an earlier run), `reconcileRelayContent()` correctly
 * detects a real divergence FOR THAT DOC and preserves it as a
 * `(relay conflict ...)` copy file -- landing on disk well after the loop
 * has already moved the vault's folder on to a different, unrelated share.
 * From the user's (or a test's) point of view, this reads as a spurious
 * conflict on a file nobody touched: ``.
 *
 * Deduplicating BEFORE the loop runs means it only ever processes the one
 * share that should win, in one step -- no intermediate VaultShare is ever
 * created for an already-superseded row, so there is nothing left in
 * flight to race the final one.
 */
export function dedupeFolderSharesByPath<
	T extends { path: string; kind: string; created_at: string },
>(shares: T[]): T[] {
	const newestFolderByPath = new Map<string, T>();
	const passthrough: T[] = [];

	for (const share of shares) {
		if (share.kind !== "folder") {
			passthrough.push(share);
			continue;
		}
		const current = newestFolderByPath.get(share.path);
		if (
			!current ||
			new Date(share.created_at).getTime() > new Date(current.created_at).getTime()
		) {
			newestFolderByPath.set(share.path, share);
		}
	}

	return [...passthrough, ...newestFolderByPath.values()];
}
