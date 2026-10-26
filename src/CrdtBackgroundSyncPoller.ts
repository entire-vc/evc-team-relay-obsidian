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
 * finished, so the edit never reaches A's disk. This closes the gap.
 *
 * Fix: for every currently-connected relay-linked VaultShare, call
 * backgroundSync.pullIfUnchanged() for each Document that isn't already
 * live-connected (i.e. not open in an editor -- an open editor already gets
 * live updates for free via its own connection) and isn't already queued or
 * being pulled.
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
 * Concurrency cap: pullIfUnchanged() deliberately bypasses BOTH
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
 *
 * Scheduling (a closed-note edit took
 * >45s to arrive with ~830 documents queued). With the cap above, a sweep
 * over every unopened document costs roughly (documents / laneLimit) x
 * (connect + PULL_SYNC_GRACE_MS) -- minutes on a large vault -- and one
 * global FIFO let a big share starve a small one. So:
 *
 *  - Each pull runs under one overall deadline (PULL_DEADLINE_MS) covering
 *    EVERY phase, including the ones before pullIfUnchanged()'s own 15s
 *    connect timeout (awaitFirstSync()/IndexedDB, parent folder sync,
 *    provider-token request). When it fires the slot is freed at once and the
 *    pull is aborted: its continuation starts no write and drops the
 *    connection it opened. The one exception is a pull already in its final
 *    "write" phase -- an overwrite handed to the vault can't be taken back,
 *    so it completes together with its sync-base update and its document is
 *    not pulled again until it does.
 *  - Two lanes per share. `priority` holds documents another client
 *    announced as changed (docActivity.ts); `sweep` holds one pass over
 *    every unopened document, refilled only once that share's previous pass
 *    has been fully dispatched -- so every document is visited once per pass
 *    and a pass is bounded by the share's size, not by how often it ticks.
 *    Free slots go to priority work first, and within each lane round-robin
 *    across shares, so no share waits behind another share's backlog.
 *  - One express slot on top of `laneLimit` (found in load testing of
 *    0.1.9: closed-note edits in one share took up to ~100s to arrive while
 *    an 800+ document bulk sync kept every regular slot in `connect` on
 *    another share). It only takes announced work from a share that has no
 *    announced pull in flight yet (or a late re-check from a share with
 *    nothing in flight), so a single edit starts at once instead
 *    of waiting up to PULL_DEADLINE_MS for a regular slot, while a share
 *    with a large announced backlog (the bulk itself) can't occupy it. Bulk
 *    throughput is unchanged: the regular slots stay at `laneLimit`.
 *  - The sweep stays as the fallback for writers that don't announce
 *    changes (older clients, server-side edits); the announcement is the
 *    fast path that makes a single edit in a large vault arrive in seconds.
 *
 * `stats()` exposes oldest wait, per-share queue sizes, in-flight count,
 * timeouts by phase and announced-change delivery latencies; a summary is
 * logged once a minute while there is work queued.
 */
import { isDocument, type Document } from "./Document";
import type { Clock } from "./Clock";
import type { ShareRegistry, VaultShare } from "./VaultShare";
import type { PullPhase, PullResult } from "./TransferQueue";
import { textFingerprint } from "./docActivity";
import { namedLogger } from "./logging";

const log = namedLogger("[CrdtBackgroundSyncPoller]");

const DEFAULT_POLL_INTERVAL_MS = 10_000;
/**
 * Hard ceiling on one pull, start to finish. Above pullIfUnchanged()'s own
 * 15s connect wait + 2s grace so a healthy-but-slow pull isn't cut short;
 * its job is to bound the phases that have no timeout of their own.
 */
export const PULL_DEADLINE_MS = 25_000;
/**
 * An announced change whose pulled text doesn't match the announced
 * fingerprint yet (the marker can beat the content to this client) is
 * pulled again after these delays, then after the backed-off
 * LATE_RECHECK_DELAYS_MS until RECHECK_WINDOW_MS after the announcement,
 * then once a minute from the front of the share's sweep until
 * RECHECK_LIMIT_MS, and only then left to the regular sweep. The marker travels on the live folder connection
 * while the sender's upload opens the document's own: under an 800+
 * document import that upload took up to ~60s, and three re-checks
 * (~40-57s) gave up on 18 of 80 edits.
 */
const RECHECK_DELAYS_MS = [2_000, 5_000, 10_000];
/**
 * Re-checks past the first three back off and wait in their own lane: served
 * after fresh announcements and before the sweep, but always leaving the
 * sweep one regular slot. An import announces hundreds of documents whose
 * content lags; their repeat re-checks must neither hold a fresh edit back
 * nor starve the sweep.
 */
const LATE_RECHECK_DELAYS_MS = [15_000, 30_000, 60_000];
const RECHECK_WINDOW_MS = 180_000;
/**
 * A change still not visible after the window keeps being re-checked, at the
 * capped delay and behind every fresh edit, for this long. On the stand a
 * note given up at 180s stayed diverged until the end of the run.
 */
const RECHECK_LIMIT_MS = 600_000;
const GIVEN_UP_SAMPLES = 20;
const STATS_LOG_EVERY_MS = 60_000;
const LATENCY_SAMPLES = 200;

/** A document waiting for a lane slot. */
interface PendingPull {
	folder: VaultShare;
	file: Document;
	queuedAt: number;
	/** Set for announced changes: what the relay text should fingerprint to. */
	expected?: string;
	/** When the announcement arrived -- the start of the delivery measurement. */
	announcedAt?: number;
	attempt: number;
}

interface ShareQueues {
	priority: Map<string, PendingPull>;
	late: Map<string, PendingPull>;
	sweep: Map<string, PendingPull>;
}

interface InFlight {
	pull: PendingPull;
	phase: PullPhase | "queued";
	controller: AbortController;
	deadline?: number;
	/** Started from the priority lane (an announced change or its re-check). */
	announced: boolean;
	/** Started from the late re-check lane. */
	late: boolean;
	/** Runs in the express slot, outside the `laneLimit` regular slots. */
	express: boolean;
}

export interface PollerStats {
	inflight: number;
	/** Pulls currently running in the express slot (0 or 1). */
	express: number;
	oldestWaitMs: number;
	queued: Record<string, { priority: number; late: number; sweep: number }>;
	timeouts: Partial<Record<PullPhase | "queued", number>>;
	completed: number;
	failed: number;
	delivery: { count: number; p50Ms: number; p95Ms: number; maxMs: number };
	/**
	 * Re-checks of announced changes: scheduled so far, moved to the front of
	 * the sweep after RECHECK_WINDOW_MS, and given up after RECHECK_LIMIT_MS.
	 */
	recheck: { scheduled: number; swept: number; givenUp: number };
	/** How the pulls so far ended. */
	outcomes: Partial<Record<PullResult["outcome"] | "deadline", number>>;
	/** The most recent given-up documents and how their last pull ended. */
	givenUp: { path: string; outcome: string; attempts: number }[];
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export class CrdtBackgroundSyncPoller {
	private intervalId: number | null = null;
	private readonly pulling = new Map<string, InFlight>();
	private readonly queues = new Map<VaultShare, ShareQueues>();
	/** Round-robin cursor into the `queues` key order. */
	private cursor = 0;
	/**
	 * Announcements that arrived while that document was already being
	 * pulled; checked against the pull's result when it settles.
	 */
	private readonly announcedWhilePulling = new Map<string, { expected: string; at: number }>();
	/**
	 * Aborted pulls that got as far as writing to disk before the deadline:
	 * the write itself isn't cancellable, so the same document isn't pulled
	 * again until that abandoned call settles.
	 */
	private readonly abandonedWrites = new Set<string>();
	private readonly subscriptions = new Map<VaultShare, () => void>();
	/** At most one pending re-check per document; a newer announcement replaces it. */
	private readonly recheckTimers = new Map<string, number>();
	private readonly timeouts: Partial<Record<PullPhase | "queued", number>> = {};
	private readonly deliveries: number[] = [];
	private completed = 0;
	private failed = 0;
	private recheckScheduled = 0;
	private recheckGivenUp = 0;
	private recheckSwept = 0;
	private readonly outcomes: PollerStats["outcomes"] = {};
	private readonly givenUpDocs: PollerStats["givenUp"] = [];
	private lastStatsLogAt = 0;
	private destroyed = false;

	constructor(
		private readonly timeProvider: Clock,
		private readonly shareRegistry: ShareRegistry,
		private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		private readonly pullDeadlineMs = PULL_DEADLINE_MS,
	) {}

	start(): void {
		if (this.intervalId !== null) return;
		this.destroyed = false;
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
		const live = new Set<VaultShare>();
		this.shareRegistry.each((folder: VaultShare) => {
			if (!folder.workspaceId || !folder.isOnline) return;
			live.add(folder);
			this.subscribe(folder);
			const queues = this.queuesFor(folder);
			// Refill this share's sweep only once its previous pass has been
			// handed out entirely: a document visited in this pass waits for
			// the next one instead of rejoining the tail every tick.
			if (queues.sweep.size > 0) return;
			const now = this.timeProvider.now();
			for (const file of folder.trackedEntries.values()) {
				if (!isDocument(file) || !this.canQueue(file)) continue;
				if (queues.priority.has(file.entityGuid) || queues.late.has(file.entityGuid)) continue;
				queues.sweep.set(file.entityGuid, { folder, file, queuedAt: now, attempt: 0 });
			}
		});
		this.forgetSharesExcept(live);
		this.drain();
		this.maybeLogStats();
	}

	private queuesFor(folder: VaultShare): ShareQueues {
		let queues = this.queues.get(folder);
		if (!queues) {
			queues = { priority: new Map(), late: new Map(), sweep: new Map() };
			this.queues.set(folder, queues);
		}
		return queues;
	}

	private canQueue(file: Document): boolean {
		return (
			!file.isOnline &&
			!this.pulling.has(file.entityGuid) &&
			!this.abandonedWrites.has(file.entityGuid)
		);
	}

	/** Drops queues and change subscriptions of shares that went offline or away. */
	private forgetSharesExcept(live: Set<VaultShare>): void {
		for (const folder of [...this.queues.keys()]) {
			if (!live.has(folder)) this.queues.delete(folder);
		}
		for (const [folder, unsubscribe] of [...this.subscriptions]) {
			if (live.has(folder)) continue;
			unsubscribe();
			this.subscriptions.delete(folder);
		}
	}

	private subscribe(folder: VaultShare): void {
		if (this.subscriptions.has(folder) || !folder.docActivity) return;
		this.subscriptions.set(
			folder,
			folder.docActivity.subscribeRemote((guid, fingerprint) =>
				this.onAnnounced(folder, guid, fingerprint),
			),
		);
	}

	/** Another client changed `guid`: pull it ahead of the sweep. */
	private onAnnounced(folder: VaultShare, guid: string, expected: string): void {
		if (this.destroyed) return;
		const file = folder.trackedEntries.get(guid);
		if (!file || !isDocument(file) || file.isOnline) return;
		const now = this.timeProvider.now();
		// A newer marker supersedes whatever re-check the older one left behind.
		this.cancelRecheck(guid);
		if (this.pulling.has(guid) || this.abandonedWrites.has(guid)) {
			this.announcedWhilePulling.set(guid, { expected, at: now });
			return;
		}
		this.enqueuePriority({ folder, file, queuedAt: now, expected, announcedAt: now, attempt: 0 });
		this.drain();
	}

	private enqueuePriority(pull: PendingPull): void {
		const queues = this.queuesFor(pull.folder);
		const guid = pull.file.entityGuid;
		const existing = queues.priority.get(guid);
		queues.sweep.delete(guid);
		queues.late.delete(guid);
		queues.priority.set(guid, {
			...pull,
			// Keep the earliest announcement of the same text so the latency
			// covers the whole wait; a different text is a new edit with its
			// own window.
			announcedAt: existing && existing.expected === pull.expected ? existing.announcedAt : pull.announcedAt,
			queuedAt: existing?.queuedAt ?? pull.queuedAt,
		});
	}

	/**
	 * Next document to start: round-robin across shares, and within the
	 * share whose turn it is, its priority lane first, then its late
	 * re-checks (while they hold fewer than `limit - 1` slots overall), then
	 * its sweep. Shares take turns before lanes do: a share receiving an
	 * import announces a new document every few seconds, and ranking every
	 * share's announcements ahead of every other share's re-checks and sweep
	 * let that stream hold all regular slots, so edits elsewhere whose
	 * content arrived after their marker were never pulled again.
	 */
	private takeNext(limit: number): { pull: PendingPull; lane: keyof ShareQueues } | undefined {
		const lateRunning = [...this.pulling.values()].filter((inFlight) => inFlight.late).length;
		const shares = [...this.queues.keys()];
		for (let i = 0; i < shares.length; i++) {
			const index = (this.cursor + i) % shares.length;
			const queues = this.queues.get(shares[index]);
			if (!queues) continue;
			for (const lane of ["priority", "late", "sweep"] as const) {
				if (lane === "late" && lateRunning >= Math.max(1, limit - 1)) continue;
				const next = queues[lane].entries().next();
				if (next.done) continue;
				const [guid, pull] = next.value;
				queues[lane].delete(guid);
				this.cursor = (index + 1) % shares.length;
				return { pull, lane };
			}
		}
		return undefined;
	}

	/**
	 * Next document for the express slot: announced work from a share none
	 * of whose announced pulls is already running; failing that, a late
	 * re-check from a share with nothing in flight at all (one starved by
	 * another share's backlog, not the share producing it).
	 */
	private takeExpress(): { pull: PendingPull; lane: keyof ShareQueues } | undefined {
		const announcing = new Set<VaultShare>();
		const active = new Set<VaultShare>();
		for (const inFlight of this.pulling.values()) {
			active.add(inFlight.pull.folder);
			if (inFlight.announced) announcing.add(inFlight.pull.folder);
		}
		const announced = this.takeFrom("priority", (share) => !announcing.has(share));
		if (announced) return { pull: announced, lane: "priority" };
		const late = this.takeFrom("late", (share) => !active.has(share));
		return late ? { pull: late, lane: "late" } : undefined;
	}

	private takeFrom(lane: keyof ShareQueues, eligible: (share: VaultShare) => boolean): PendingPull | undefined {
		const shares = [...this.queues.keys()];
		for (let i = 0; i < shares.length; i++) {
			const index = (this.cursor + i) % shares.length;
			if (!eligible(shares[index])) continue;
			const queue = this.queues.get(shares[index])?.[lane];
			const next = queue?.entries().next();
			if (!queue || !next || next.done) continue;
			const [guid, pull] = next.value;
			queue.delete(guid);
			this.cursor = (index + 1) % shares.length;
			return pull;
		}
		return undefined;
	}

	/**
	 * Starts queued pulls one at a time up to the cap, so the in-flight count
	 * never exceeds it even mid-drain. Each completion (or deadline) re-enters
	 * `drain()` to pick up the next waiting document immediately, rather than
	 * leaving it stuck until the next 10s tick.
	 */
	private drain(): void {
		while (!this.destroyed) {
			const limit = this.laneLimit();
			if (limit === undefined) return;
			let regular = 0;
			let expressBusy = false;
			for (const inFlight of this.pulling.values()) {
				if (inFlight.express) expressBusy = true;
				else regular++;
			}
			let next: { pull: PendingPull; lane: keyof ShareQueues; express: boolean } | undefined;
			if (regular < limit) {
				const taken = this.takeNext(limit);
				if (taken) next = { ...taken, express: false };
			} else if (!expressBusy) {
				const taken = this.takeExpress();
				if (taken) next = { ...taken, express: true };
			}
			if (!next) return;
			// Re-validated at start: the editor may have opened it, or another
			// path may have started pulling it, while it sat in the queue.
			if (!next.pull.folder.isOnline || !this.canQueue(next.pull.file)) continue;
			this.startPull(next.pull, next.lane, next.express);
		}
	}

	private laneLimit(): number | undefined {
		for (const folder of this.queues.keys()) return folder.transfers.laneLimit;
		return undefined;
	}

	private startPull(pull: PendingPull, lane: keyof ShareQueues, express: boolean): void {
		const { folder, file } = pull;
		const guid = file.entityGuid;
		const controller = new AbortController();
		const inFlight: InFlight = {
			pull,
			phase: "queued",
			controller,
			announced: lane === "priority",
			late: lane === "late",
			express,
		};
		this.pulling.set(guid, inFlight);
		const startedAt = this.timeProvider.now();
		log("Re-checking unopened document for remote updates", {
			path: file.entryPath,
			announced: pull.expected !== undefined,
			express,
			waitedMs: startedAt - pull.queuedAt,
		});

		let settled = false;
		const finish = (result: PullResult | undefined) => {
			if (settled) return;
			settled = true;
			if (inFlight.deadline !== undefined) this.timeProvider.cancelTimeout(inFlight.deadline);
			this.pulling.delete(guid);
			if (!this.destroyed) {
				this.afterPull(pull, result);
				this.drain();
			}
		};
		inFlight.deadline = this.timeProvider.scheduleTimeout(() => {
			if (settled) return;
			this.timeouts[inFlight.phase] = (this.timeouts[inFlight.phase] ?? 0) + 1;
			log("pullIfUnchanged exceeded its deadline; releasing the slot", {
				path: file.entryPath,
				phase: inFlight.phase,
				deadlineMs: this.pullDeadlineMs,
			});
			if (inFlight.phase === "write") {
				// Past pullIfUnchanged()'s point of no return: the overwrite is
				// already with the vault and must finish together with its
				// sync-base update, so it is NOT aborted -- only no longer
				// waited for. The guid stays blocked until it settles.
				this.abandonedWrites.add(guid);
			} else {
				controller.abort();
			}
			finish(undefined);
		}, this.pullDeadlineMs);

		void folder.transfers
			.pullIfUnchanged(file, {
				signal: controller.signal,
				onPhase: (phase) => {
					inFlight.phase = phase;
				},
			})
			.catch((err: unknown) => {
				log("pullIfUnchanged failed", { path: file.entryPath, err });
				return undefined;
			})
			.then((result) => {
				if (settled) {
					// Settles after its deadline already freed the slot.
					this.abandonedWrites.delete(guid);
					return;
				}
				finish(result ?? { outcome: "connect-failed" });
			});
	}

	private afterPull(pull: PendingPull, result: PullResult | undefined): void {
		const guid = pull.file.entityGuid;
		const ok = result !== undefined && result.outcome !== "connect-failed" && result.outcome !== "aborted";
		if (ok) this.completed++;
		else this.failed++;
		const outcome = result?.outcome ?? "deadline";
		this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;

		const lateAnnouncement = this.announcedWhilePulling.get(guid);
		this.announcedWhilePulling.delete(guid);
		const expected = lateAnnouncement?.expected ?? pull.expected;
		if (expected === undefined) return;
		// A marker that came in mid-pull starts a fresh window from its own arrival.
		const announcedAt = lateAnnouncement?.at ?? pull.announcedAt ?? pull.queuedAt;

		const remote = result?.remoteText;
		if (ok && remote !== undefined && textFingerprint(remote) === expected) {
			this.recordDelivery(this.timeProvider.now() - announcedAt);
			return;
		}
		// Not there yet (marker arrived ahead of the content, or the pull
		// failed): try again shortly, a bounded number of times.
		const attempt = lateAnnouncement ? 0 : pull.attempt;
		const delay =
			RECHECK_DELAYS_MS[attempt] ??
			LATE_RECHECK_DELAYS_MS[Math.min(attempt - RECHECK_DELAYS_MS.length, LATE_RECHECK_DELAYS_MS.length - 1)];
		if (this.timeProvider.now() + delay - announcedAt > RECHECK_LIMIT_MS) {
			this.recheckGivenUp++;
			this.givenUpDocs.push({ path: pull.file.entryPath, outcome, attempts: attempt + 1 });
			if (this.givenUpDocs.length > GIVEN_UP_SAMPLES) this.givenUpDocs.shift();
			log("announced change still not visible after re-checks; leaving it to the sweep", {
				path: pull.file.entryPath,
				attempts: attempt + 1,
				outcome,
			});
			return;
		}
		this.recheckScheduled++;
		this.cancelRecheck(guid);
		const timer = this.timeProvider.scheduleTimeout(() => {
			this.recheckTimers.delete(guid);
			if (this.destroyed) return;
			if (this.pulling.has(guid) && !this.announcedWhilePulling.has(guid)) {
				// A sweep pull of it is running: check that pull's result instead.
				this.announcedWhilePulling.set(guid, { expected, at: announcedAt });
				return;
			}
			if (!this.canQueue(pull.file)) return;
			const next: PendingPull = {
				...pull,
				expected,
				announcedAt,
				queuedAt: this.timeProvider.now(),
				attempt: attempt + 1,
			};
			if (next.attempt <= RECHECK_DELAYS_MS.length) {
				this.enqueuePriority(next);
			} else {
				const queues = this.queuesFor(pull.folder);
				// A fresh announcement already queued for it covers this re-check.
				if (queues.priority.has(guid)) return;
				if (this.timeProvider.now() - announcedAt <= RECHECK_WINDOW_MS) {
					queues.sweep.delete(guid);
					queues.late.set(guid, next);
				} else {
					// Past the window: first in line of the sweep, so it
					// doesn't take a slot from re-checks still in theirs.
					this.recheckSwept++;
					queues.late.delete(guid);
					queues.sweep.delete(guid);
					queues.sweep = new Map([[guid, next], ...queues.sweep]);
				}
			}
			this.drain();
		}, delay);
		this.recheckTimers.set(guid, timer);
	}

	private cancelRecheck(guid: string): void {
		const timer = this.recheckTimers.get(guid);
		if (timer === undefined) return;
		this.timeProvider.cancelTimeout(timer);
		this.recheckTimers.delete(guid);
	}

	private recordDelivery(ms: number): void {
		this.deliveries.push(ms);
		if (this.deliveries.length > LATENCY_SAMPLES) this.deliveries.shift();
	}

	stats(): PollerStats {
		const now = this.timeProvider.now();
		let oldest = now;
		const queued: PollerStats["queued"] = {};
		for (const [folder, { priority, late, sweep }] of this.queues) {
			queued[folder.path ?? folder.entityGuid] = { priority: priority.size, late: late.size, sweep: sweep.size };
			for (const lane of [priority, late, sweep]) {
				const first = lane.values().next();
				if (!first.done) oldest = Math.min(oldest, first.value.queuedAt);
			}
		}
		const sorted = [...this.deliveries].sort((a, b) => a - b);
		return {
			inflight: this.pulling.size,
			express: [...this.pulling.values()].filter((inFlight) => inFlight.express).length,
			oldestWaitMs: now - oldest,
			queued,
			timeouts: { ...this.timeouts },
			completed: this.completed,
			failed: this.failed,
			recheck: { scheduled: this.recheckScheduled, swept: this.recheckSwept, givenUp: this.recheckGivenUp },
			outcomes: { ...this.outcomes },
			givenUp: [...this.givenUpDocs],
			delivery: {
				count: sorted.length,
				p50Ms: percentile(sorted, 50),
				p95Ms: percentile(sorted, 95),
				maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
			},
		};
	}

	private maybeLogStats(): void {
		const now = this.timeProvider.now();
		if (now - this.lastStatsLogAt < STATS_LOG_EVERY_MS) return;
		const stats = this.stats();
		const idle =
			stats.inflight === 0 && Object.values(stats.queued).every((q) => q.priority + q.late + q.sweep === 0);
		if (idle && stats.delivery.count === 0) return;
		this.lastStatsLogAt = now;
		log("Background sync stats", stats);
	}

	destroy(): void {
		this.destroyed = true;
		if (this.intervalId !== null) {
			this.timeProvider.cancelInterval(this.intervalId);
			this.intervalId = null;
		}
		// Aborting makes each in-flight pull drop the connection it opened as
		// soon as its current await returns, and write nothing further.
		for (const { controller, deadline, phase } of this.pulling.values()) {
			if (deadline !== undefined) this.timeProvider.cancelTimeout(deadline);
			// Same point of no return as the deadline: a write in progress
			// completes with its sync-base update; nothing else proceeds.
			if (phase !== "write") controller.abort();
		}
		this.pulling.clear();
		for (const timer of this.recheckTimers.values()) this.timeProvider.cancelTimeout(timer);
		this.recheckTimers.clear();
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		this.queues.clear();
		this.announcedWhilePulling.clear();
		this.abandonedWrites.clear();
		log("CrdtBackgroundSyncPoller destroyed");
	}
}
