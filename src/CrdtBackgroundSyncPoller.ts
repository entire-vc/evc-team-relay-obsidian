/**
 * CRDT Background Sync Poller
 *
 * A Document only receives a peer's live content update while its own
 * per-file Y.Doc has an active WebSocket connection to the relay -- which
 * only happens while the file is open in an editor (LiveCMPluginValue), or
 * for the brief window of an outbound backgroundSync push (main.ts's
 * `vault.on("modify")` handler enqueues that push for the EDITING client
 * only). Document.ts has no Y.Text observer that flushes an incoming remote
 * update to disk on its own -- TransferQueue has the flush logic this needs
 * (see pullIfUnchanged()), but nothing was calling it for a document nobody
 * just interacted with.
 *
 * Net effect: an edit made on client B to a file that's closed on client A
 * reaches the relay (B's outbound push works even file-closed), but A never
 * re-checks that file's content once its own initial folder connect has
 * finished, so the edit never reaches A's disk. Reproduced and localized in
 *; this closes the gap.
 *
 * Fix: on each tick, for every currently-connected relay-linked
 * VaultShare, call backgroundSync.pullIfUnchanged() for each Document that
 * isn't already live-connected (i.e. not open in an editor -- an open editor
 * already gets live updates for free via its own connection) and isn't
 * already being pulled by an earlier tick that hasn't finished yet.
 *
 * Deliberately uses pullIfUnchanged(), NOT enqueueUpload()/enqueueFetch():
 * those run TransferQueue.uploadDocumentViaSocket(), which treats a vault/Y.Doc
 * mismatch as "this client has an unsynced local edit -- push it, preserve
 * the relay's prior content as a conflict copy". That's the right call for an
 * actual local edit, but wrong for an unconditional periodic re-check: a
 * mismatch this poller observes could just as easily be this client's own
 * not-yet-finished direct upload (VaultShare.publishDoc()'s raw
 * `ydoc.getText("contents").insert()`, invisible to any TransferQueue lane)
 * as a genuine conflict. Confirmed live against the self-hosted stand: doing
 * this via enqueueFetch() produced spurious conflict-copy files on a
 * freshly-created, never-locally-edited doc: pullIfUnchanged() only
 * ever writes disk when it can positively confirm, immediately before
 * writing, that the vault file is unchanged and the relay genuinely differs
 * -- it never touches the Y.Doc and never creates a conflict copy, so a race
 * with any other write path degrades to a no-op rather than corrupting
 * anything.
 *
 * Tracks its own in-flight guids (`pulling`) rather than relying on
 * TransferQueue.hasInFlight(): pullIfUnchanged() deliberately bypasses both
 * queue lanes (see its doc comment), so this poller is the only thing that
 * knows one of its own calls for a given document is still running -- e.g.
 * a slow relay response outlasting one 10s tick.
 *
 * Deliberately reads `shareRegistry` live on each tick instead of keeping a
 * separate registration list (contrast InboundSyncPoller, which needs one
 * because it persists a per-share `web_content_updated_at` watermark): there
 * is no equivalent content-version field for Documents (see ItemKinds.ts --
 * `hash`/`synctime` are only populated for attachment records, not
 * markdown), so there's nothing to keep a watermark for. The tradeoff is
 * that every unopened Document in every connected relay-linked folder gets a
 * one-shot connect/check/disconnect cycle on every tick, whether or not its
 * content actually changed -- acceptable for closing a correctness gap, but
 * a candidate for a cheaper check (e.g. a content hash in folder meta) if
 * per-tick connection volume becomes a real concern on large folders.
 *
 * Concurrency cap: pullIfUnchanged deliberately bypasses BOTH
 * TransferQueue lanes (see above), so it also bypasses their shared
 * `laneLimit` gate (TransferQueue.drainLane()) -- nothing else limits how
 * many of these run at once. Left unbounded, one tick fires a
 * connect/sync/disconnect for every unopened Document in every connected
 * folder simultaneously; on a large folder (prod-observed up to ~350 files
 * on one share) that's hundreds of concurrent per-file WebSocket round
 * trips every 10s, on every client. `drain()` below reuses the same
 * `TransferQueue.laneLimit` number the queue lanes already apply (default
 * 3) instead of inventing an independent one, and starts a queued document
 * as soon as a slot frees rather than waiting for the next full tick.
 */
import { isDocument, type Document } from "./Document";
import type { Clock } from "./Clock";
import type { ShareRegistry, VaultShare } from "./VaultShare";
import { namedLogger } from "./logging";

const log = namedLogger("[CrdtBackgroundSyncPoller]");

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** An unopened Document found on a tick, queued until a lane slot frees. */
interface PendingPull {
	folder: VaultShare;
	file: Document;
}

export class CrdtBackgroundSyncPoller {
	private intervalId: number | null = null;
	private readonly pulling = new Set<string>();
	/**
	 * Documents found on a tick that couldn't start immediately because
	 * `pulling.size` was already at the cap. Keyed by guid so a later tick
	 * doesn't queue the same document a second time while it's still
	 * waiting for its turn. Drained by `drain()` as in-flight slots free up,
	 * not just once per poll interval.
	 */
	private readonly waiting = new Map<string, PendingPull>();

	constructor(
		private readonly timeProvider: Clock,
		private readonly shareRegistry: ShareRegistry,
		private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	) {}

	start(): void {
		if (this.intervalId !== null) return;
		// Poll once immediately -- a folder that's already connected by the
		// time this starts shouldn't wait a full interval for its first
		// background check (matters most right after plugin load, when
		// several folders may already be connected).
		this._poll();
		this.intervalId = this.timeProvider.scheduleInterval(
			() => this._poll(),
			this.pollIntervalMs,
		);
		log("Started polling", { intervalMs: this.pollIntervalMs });
	}

	private _poll(): void {
		this.shareRegistry.each((folder: VaultShare) => {
			if (!folder.workspaceId || !folder.isOnline) return;
			for (const file of folder.trackedEntries.values()) {
				if (
					!isDocument(file) ||
					file.isOnline ||
					this.pulling.has(file.entityGuid) ||
					this.waiting.has(file.entityGuid)
				) {
					continue;
				}
				this.waiting.set(file.entityGuid, { folder, file });
			}
		});
		this.drain();
	}

	/**
	 * Starts queued pulls one at a time up to the cap, so `pulling.size`
	 * never exceeds it even mid-drain. Each completion re-enters `drain()`
	 * to pick up the next waiting document immediately, rather than leaving
	 * it stuck until the next 10s tick.
	 */
	private drain(): void {
		for (const [guid, { folder, file }] of this.waiting) {
			if (this.pulling.size >= folder.transfers.laneLimit) break;
			this.waiting.delete(guid);
			this.pulling.add(guid);
			log("Re-checking unopened document for remote updates", {
				path: file.entryPath,
			});
			void folder.transfers
				.pullIfUnchanged(file)
				.catch((err: unknown) => {
					log("pullIfUnchanged failed", { path: file.entryPath, err });
				})
				.finally(() => {
					this.pulling.delete(guid);
					this.drain();
				});
		}
	}

	destroy(): void {
		if (this.intervalId !== null) {
			this.timeProvider.cancelInterval(this.intervalId);
			this.intervalId = null;
		}
		this.pulling.clear();
		this.waiting.clear();
		log("CrdtBackgroundSyncPoller destroyed");
	}
}
