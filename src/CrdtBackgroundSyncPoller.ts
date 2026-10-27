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
import type { PullPhase, PullResult, RelayProbeSample } from "./TransferQueue";
import { textFingerprint } from "./docActivity";
import { namedLogger } from "./logging";
import { holdBackgroundTokens, tokenWaitStats, type TokenWaitSummary } from "./auth/tokenRequestClass";
import { connectGateStats, type ConnectGateStats } from "./client/connectGate";

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
/**
 * An announced pull stays connected this long for the announced text to
 * arrive (the relay pushes it), instead of disconnecting and reconnecting on
 * each re-check. A waiting pull holds no slot; at most MAX_AWAITING wait at
 * once, so an import's stream of announcements can't open a socket each.
 */
const AWAIT_CONTENT_MS = 60_000;
const MAX_AWAITING = 6;
/**
 * A share with more announced pulls than this queued or running is
 * importing. While another share has an edit waiting, it keeps at most one
 * regular slot: on 0.1.15 our own import slowed the relay to 16-19s per
 * document, and the edits waited on the same relay.
 *
 * Re-checks and pulls waiting connected for their text don't count: they are
 * edits that were slow to arrive, not new work. On 0.1.21 they took a share
 * with one edit every 10 s over the line during an import (up to 6 can wait
 * connected), and its edits then waited behind the import as background work
 * for 40-108 s.
 */
const IMPORT_BACKLOG = 5;
const RELAY_PROBE_SAMPLES = 60;
const STATS_LOG_EVERY_MS = 60_000;
const LATENCY_SAMPLES = 200;

/**
 * One announced pull into a share that isn't importing, for a load test to
 * line up with the edit that caused it. `announcedAt` is wall-clock ms; the
 * other times are ms after the pull started.
 */
export interface EditPullTrace {
	path: string;
	announcedAt: number;
	queuedMs: number;
	express: boolean;
	awaits: boolean;
	phases: Partial<Record<PullPhase, number>>;
	totalMs: number;
	outcome: string;
	matched: boolean;
}

const EDIT_TRACE_SAMPLES = 100;

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
	/** Aborts the pull and frees its slot (set once it has started). */
	release?: () => void;
	/** Started with leave to wait for the announced text (see AWAIT_CONTENT_MS). */
	awaits: boolean;
	/** Ends this pull's background token class (set for sweep and import pulls). */
	releaseTokens?: () => void;
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
	/** Late re-checks that gave the express slot up to a fresh edit. */
	preempted: number;
	/** How the pulls so far ended. */
	outcomes: Partial<Record<PullResult["outcome"] | "deadline", number>>;
	/** The most recent given-up documents and how their last pull ended. */
	givenUp: { path: string; outcome: string; attempts: number }[];
	/** Pulls connected and waiting for announced text right now. */
	awaiting: number;
	/** Shares currently ranked as importing. */
	importing: string[];
	/** Relay probe samples (startRelayProbe()), oldest first, with a summary. */
	relayProbe: {
		path?: string;
		samples: RelayProbeSample[];
		connectMs: { p50: number; p95: number; max: number };
		syncMs: { p50: number; p95: number; max: number };
		failed: number;
	};
	/** Relay-token waits in the request throttle, per class (tokenRequestClass.ts). */
	tokenWait: { normal: TokenWaitSummary; background: TokenWaitSummary; backgroundDocs: number };
	/** Socket handshakes: turn waits per class, handshake times, timeouts. */
	connectGate: ConnectGateStats;
	/** Announced pulls outside an import, newest last. */
	edits: EditPullTrace[];
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
	private readonly editTrace: EditPullTrace[] = [];
	private readonly deliveries: number[] = [];
	private completed = 0;
	private failed = 0;
	private recheckScheduled = 0;
	private recheckGivenUp = 0;
	private recheckSwept = 0;
	private preempted = 0;
	private readonly outcomes: PollerStats["outcomes"] = {};
	private readonly givenUpDocs: PollerStats["givenUp"] = [];
	private probe?: { path: string; timer: number };
	/** The document a relay probe has connected right now, across stop/start. */
	private probing?: string;
	/** Announced pulls that came up while their document was being probed. */
	private readonly heldByProbe = new Map<string, { pull: PendingPull; lane: keyof ShareQueues }>();
	private readonly probeSamples: RelayProbeSample[] = [];
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
				if (!isDocument(file) || !this.canQueue(file) || file.entityGuid === this.probing) continue;
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

	/** Not open in the editor. The probed document is online only for the probe. */
	private isClosed(file: Document): boolean {
		return !file.isOnline || file.entityGuid === this.probing;
	}

	private canQueue(file: Document): boolean {
		return (
			this.isClosed(file) &&
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
		if (!file || !isDocument(file) || !this.isClosed(file)) return;
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
		const importing = this.importingShares();
		const editsWaiting = this.editsWaiting(importing);
		const shares = [...this.queues.keys()];
		for (let i = 0; i < shares.length; i++) {
			const index = (this.cursor + i) % shares.length;
			const queues = this.queues.get(shares[index]);
			if (!queues) continue;
			if (editsWaiting && importing.has(shares[index]) && this.regularPulls(shares[index]) >= 1) continue;
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

	/** Shares with more than IMPORT_BACKLOG announced pulls queued or running. */
	private importingShares(): Set<VaultShare> {
		const counts = new Map<VaultShare, number>();
		for (const [share, queues] of this.queues) counts.set(share, queues.priority.size);
		for (const inFlight of this.pulling.values()) {
			if (!inFlight.announced || inFlight.phase === "await-content") continue;
			const share = inFlight.pull.folder;
			counts.set(share, (counts.get(share) ?? 0) + 1);
		}
		const importing = new Set<VaultShare>();
		for (const [share, n] of counts) if (n > IMPORT_BACKLOG) importing.add(share);
		return importing;
	}

	/** Whether a share that isn't importing has announced work queued or running. */
	private editsWaiting(importing: Set<VaultShare>): boolean {
		for (const [share, queues] of this.queues) {
			if (!share.isOnline || importing.has(share)) continue;
			if (queues.priority.size > 0 || queues.late.size > 0) return true;
		}
		for (const inFlight of this.pulling.values()) {
			if ((inFlight.announced || inFlight.late) && !importing.has(inFlight.pull.folder)) return true;
		}
		return false;
	}

	private regularPulls(share: VaultShare): number {
		let n = 0;
		for (const inFlight of this.pulling.values()) {
			if (inFlight.pull.folder === share && !inFlight.express && inFlight.phase !== "await-content") n++;
		}
		return n;
	}

	/**
	 * A late re-check holding the express slot gives it up to a fresh edit
	 * (it is re-checked again later); one already writing is left to finish.
	 */
	private preemptLateExpress(): PendingPull | undefined {
		const holder = [...this.pulling.values()].find(
			(inFlight) => inFlight.express && inFlight.phase !== "await-content",
		);
		if (!holder?.late || holder.phase === "write" || !holder.release) return undefined;
		const announcing = new Set<VaultShare>();
		for (const inFlight of this.pulling.values()) {
			if (inFlight.announced) announcing.add(inFlight.pull.folder);
		}
		const pull = this.takeFrom("priority", (share) => !announcing.has(share));
		if (!pull) return undefined;
		this.preempted++;
		holder.release();
		return pull;
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
	 * Starts queued pulls one at a time up to the cap. A pull waiting for
	 * announced text (await-content) holds no slot; when its text lands it
	 * finishes its compare/write on top of the cap, so the count can briefly
	 * exceed the cap by at most MAX_AWAITING, and nothing new starts until it
	 * is back under. Each completion (or deadline) re-enters
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
				if (inFlight.phase === "await-content") continue;
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
			} else {
				const pull = this.preemptLateExpress();
				if (pull) next = { pull, lane: "priority", express: true };
			}
			if (!next) return;
			// Re-validated at start: the editor may have opened it, or another
			// path may have started pulling it, while it sat in the queue.
			if (!next.pull.folder.isOnline || !this.canQueue(next.pull.file)) continue;
			if (next.pull.file.entityGuid === this.probing) {
				// Picked up again once the probe disconnects (sweep pulls just wait for the next pass).
				if (next.lane !== "sweep") this.heldByProbe.set(next.pull.file.entityGuid, next);
				continue;
			}
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
		const awaits =
			pull.expected !== undefined &&
			lane !== "sweep" &&
			!this.importingShares().has(folder) &&
			[...this.pulling.values()].filter((other) => other.awaits).length < MAX_AWAITING;
		const inFlight: InFlight = {
			pull,
			phase: "queued",
			controller,
			announced: lane === "priority",
			late: lane === "late",
			express,
			awaits,
		};
		this.pulling.set(guid, inFlight);
		// A sweep pull or one into an importing share lets edits get their
		// relay tokens first (see tokenRequestClass.ts).
		const importing = this.importingShares().has(folder);
		if (lane === "sweep" || importing) inFlight.releaseTokens = holdBackgroundTokens(guid);
		const startedAt = this.timeProvider.now();
		const phaseAt: Partial<Record<PullPhase, number>> = {};
		log("Re-checking unopened document for remote updates", {
			path: file.entryPath,
			announced: pull.expected !== undefined,
			express,
			waitedMs: startedAt - pull.queuedAt,
		});

		let settled = false;
		const finish = (result: PullResult | undefined, redrain = true) => {
			if (settled) return;
			settled = true;
			inFlight.releaseTokens?.();
			if (inFlight.deadline !== undefined) this.timeProvider.cancelTimeout(inFlight.deadline);
			this.pulling.delete(guid);
			if (pull.expected !== undefined && lane !== "sweep" && !importing) {
				this.traceEdit(pull, result, { startedAt, express, awaits, phaseAt });
			}
			if (!this.destroyed) {
				this.afterPull(pull, result);
				if (redrain) this.drain();
			}
		};
		const onDeadline = () => {
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
		};
		const rearm = (ms: number) => {
			if (inFlight.deadline !== undefined) this.timeProvider.cancelTimeout(inFlight.deadline);
			inFlight.deadline = this.timeProvider.scheduleTimeout(onDeadline, ms);
		};
		inFlight.deadline = this.timeProvider.scheduleTimeout(onDeadline, this.pullDeadlineMs);

		inFlight.release = () => {
			if (settled) return;
			controller.abort();
			// Called from drain(), which hands the slot on itself.
			finish({ outcome: "aborted" }, false);
		};

		void folder.transfers
			.pullIfUnchanged(file, {
				signal: controller.signal,
				onPhase: (phase) => {
					phaseAt[phase] ??= this.timeProvider.now() - startedAt;
					const wasAwaiting = inFlight.phase === "await-content";
					inFlight.phase = phase;
					if (settled) return;
					if (phase === "await-content") {
						// Waiting for the relay to push the text is not stuck:
						// give the wait its own budget, then the usual one.
						rearm(AWAIT_CONTENT_MS + this.pullDeadlineMs);
						// The slot is free while it waits.
						this.drain();
					} else if (wasAwaiting) {
						// Back to the usual budget for compare/write.
						rearm(this.pullDeadlineMs);
					}
				},
				...(awaits
					? {
							expected: () => this.announcedWhilePulling.get(guid)?.expected ?? pull.expected,
							awaitContentMs: AWAIT_CONTENT_MS,
						}
					: {}),
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

	private traceEdit(
		pull: PendingPull,
		result: PullResult | undefined,
		run: { startedAt: number; express: boolean; awaits: boolean; phaseAt: Partial<Record<PullPhase, number>> },
	): void {
		const now = this.timeProvider.now();
		const announcedAt = pull.announcedAt ?? pull.queuedAt;
		const expected = this.announcedWhilePulling.get(pull.file.entityGuid)?.expected ?? pull.expected;
		const remote = result?.remoteText;
		this.editTrace.push({
			path: pull.file.entryPath,
			announcedAt: Date.now() - (now - announcedAt),
			queuedMs: run.startedAt - pull.queuedAt,
			express: run.express,
			awaits: run.awaits,
			phases: { ...run.phaseAt },
			totalMs: now - run.startedAt,
			outcome: result?.outcome ?? "deadline",
			matched: remote !== undefined && textFingerprint(remote) === expected,
		});
		if (this.editTrace.length > EDIT_TRACE_SAMPLES) this.editTrace.shift();
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

	/**
	 * Every intervalMs, connect one closed control document and time its
	 * connect and first sync. Run next to a load test, it separates relay
	 * latency from client scheduling: a slow probe means the relay is slow.
	 */
	startRelayProbe(path: string, intervalMs = 10_000): void {
		this.stopRelayProbe();
		const probe: { path: string; timer: number; guid?: string } = {
			path,
			timer: this.timeProvider.scheduleInterval(() => void this.runRelayProbe(probe), intervalMs),
		};
		this.probe = probe;
		this.probeSamples.length = 0;
		void this.runRelayProbe(probe);
	}

	stopRelayProbe(): void {
		if (!this.probe) return;
		this.timeProvider.cancelInterval(this.probe.timer);
		this.probe = undefined;
	}

	private async runRelayProbe(probe: { path: string }): Promise<void> {
		if (this.probe !== probe || this.probing !== undefined) return;
		const found = this.findDocument(probe.path);
		if (!found || this.pulling.has(found.file.entityGuid)) return;
		const guid = found.file.entityGuid;
		this.probing = guid;
		try {
			const sample = await found.folder.transfers.probeRelay(found.file);
			if (sample && this.probe === probe) {
				this.probeSamples.push(sample);
				if (this.probeSamples.length > RELAY_PROBE_SAMPLES) this.probeSamples.shift();
			}
		} catch (err: unknown) {
			log("Relay probe failed", { path: probe.path, err });
		} finally {
			this.probing = undefined;
			const held = this.heldByProbe.get(guid);
			this.heldByProbe.delete(guid);
			if (held && !this.destroyed) {
				const queues = this.queuesFor(held.pull.folder);
				if (!queues.priority.has(guid) && !queues.late.has(guid)) queues[held.lane].set(guid, held.pull);
				this.drain();
			}
		}
	}

	private findDocument(path: string): { folder: VaultShare; file: Document } | undefined {
		let found: { folder: VaultShare; file: Document } | undefined;
		this.shareRegistry.each((folder: VaultShare) => {
			if (found) return;
			for (const file of folder.trackedEntries.values()) {
				if (!isDocument(file)) continue;
				if (file.entryPath === path || `${folder.path}/${file.entryPath}` === path) {
					found = { folder, file };
					return;
				}
			}
		});
		return found;
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
			preempted: this.preempted,
			outcomes: { ...this.outcomes },
			givenUp: [...this.givenUpDocs],
			delivery: {
				count: sorted.length,
				p50Ms: percentile(sorted, 50),
				p95Ms: percentile(sorted, 95),
				maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
			},
			awaiting: [...this.pulling.values()].filter((inFlight) => inFlight.phase === "await-content").length,
			importing: [...this.importingShares()].map((folder) => folder.path ?? folder.entityGuid),
			relayProbe: this.relayProbeStats(),
			tokenWait: tokenWaitStats(),
			connectGate: connectGateStats(),
			edits: [...this.editTrace],
		};
	}

	private relayProbeStats(): PollerStats["relayProbe"] {
		const summary = (values: number[]) => {
			const sorted = [...values].sort((a, b) => a - b);
			return {
				p50: percentile(sorted, 50),
				p95: percentile(sorted, 95),
				max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
			};
		};
		const ok = this.probeSamples.filter((sample) => sample.ok);
		return {
			path: this.probe?.path,
			samples: [...this.probeSamples],
			connectMs: summary(ok.map((sample) => sample.connectMs)),
			syncMs: summary(ok.map((sample) => sample.syncMs)),
			failed: this.probeSamples.length - ok.length,
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
		this.stopRelayProbe();
		if (this.intervalId !== null) {
			this.timeProvider.cancelInterval(this.intervalId);
			this.intervalId = null;
		}
		// Aborting makes each in-flight pull drop the connection it opened as
		// soon as its current await returns, and write nothing further.
		for (const { controller, deadline, phase, releaseTokens } of this.pulling.values()) {
			if (deadline !== undefined) this.timeProvider.cancelTimeout(deadline);
			releaseTokens?.();
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
		this.heldByProbe.clear();
		log("CrdtBackgroundSyncPoller destroyed");
	}
}
