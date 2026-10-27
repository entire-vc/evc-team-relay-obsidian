/**
 * Inbound Sync Poller (v1.9)
 *
 * Polls web_content_updated_at on folder shares present in the vault at a fixed
 * cadence; other shares are checked from the share list (see track()).
 * On detecting a bump, triggers InboundFileDownloader to pull new sync-artifact items.
 * Skips polls while an outbound sync is in flight to prevent echo loops.
 */

import { namedLogger } from "./logging";
import type { InboundFileDownloader } from "./InboundFileDownloader";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { Clock } from "./Clock";
import type { WebSyncManager } from "./WebSyncManager";

const log = namedLogger("[InboundSyncPoller]");

const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface WatchedShare {
	serverId: string;
	lastUpdatedAt: string | null;
}

export class InboundSyncPoller {
	private watchedShares: Map<string, WatchedShare> = new Map();
	private listedChecks = new Map<string, Promise<void>>();
	private intervalId: number | null = null;
	private polling = false;
	private serverBackoff = new Map<string, { failures: number; retryAt: number }>();

	constructor(
		private readonly timeProvider: Clock,
		private readonly clientManager: RelayOnPremShareClientManager,
		private readonly webSyncManager: WebSyncManager,
		private readonly fileDownloader: InboundFileDownloader,
		private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		// Persisted shareId -> last-seen web_content_updated_at.
		// Injectable so callers can back it with VaultScopedMap instead of a bare
		// in-memory Map — without persistence, every plugin restart re-registers
		// every share at lastUpdatedAt=null, which reads as "content changed"
		// unconditionally and triggers a full re-download on every open even when
		// nothing changed server-side. Defaults to a plain Map for callers
		// (incl. tests) that don't need persistence.
		private readonly persistedUpdatedAt: Map<string, string> = new Map(),
	) {}

	registerShare(shareId: string, serverId: string): void {
		const lastUpdatedAt = this.persistedUpdatedAt.get(shareId) ?? null;
		this.watchedShares.set(shareId, { serverId, lastUpdatedAt });
		log("Registered share for polling", { shareId, serverId, lastUpdatedAt });
	}

	/**
	 * Route a folder share from the share list. One whose folder is in the
	 * vault is polled; any other one is checked once against the
	 * web_content_updated_at the list already carries, so folders that are
	 * not here cost no GET /v1/shares/{id} per poll. Called again on each
	 * list load and on "Sync all shares".
	 */
	track(
		shareId: string,
		serverId: string,
		local: boolean,
		listedUpdatedAt: string | null | undefined,
	): void {
		if (local) {
			this.registerShare(shareId, serverId);
			return;
		}
		this.watchedShares.delete(shareId);
		void this.checkListedShare(shareId, serverId, listedUpdatedAt ?? null);
	}

	/**
	 * Download a share not in the poll set if its listed timestamp moved past
	 * the watermark. Checks of one share run one after another, so two list
	 * loads close together download it once and the watermark only moves
	 * forward.
	 */
	checkListedShare(
		shareId: string,
		serverId: string,
		listedUpdatedAt: string | null,
	): Promise<void> {
		const previous = this.listedChecks.get(shareId) ?? Promise.resolve();
		const check = previous.then(() => this.runListedCheck(shareId, serverId, listedUpdatedAt));
		this.listedChecks.set(shareId, check);
		void check.then(() => {
			if (this.listedChecks.get(shareId) === check) this.listedChecks.delete(shareId);
		});
		return check;
	}

	private async runListedCheck(
		shareId: string,
		serverId: string,
		listedUpdatedAt: string | null,
	): Promise<void> {
		const watermark = this.persistedUpdatedAt.get(shareId) ?? null;
		if (!listedUpdatedAt || listedUpdatedAt === watermark) {
			return;
		}
		if (watermark && Date.parse(listedUpdatedAt) <= Date.parse(watermark)) {
			return;
		}
		try {
			const result = await this.fileDownloader.downloadShare(shareId, serverId);
			if (result !== "skipped") {
				this.persistedUpdatedAt.set(shareId, listedUpdatedAt);
			}
		} catch (err: unknown) {
			log("Failed to download listed share", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Stop polling every watched share `keep` rejects. */
	retainOnly(keep: (shareId: string) => boolean): void {
		for (const shareId of [...this.watchedShares.keys()]) {
			if (!keep(shareId)) this.unregisterShare(shareId);
		}
	}

	unregisterShare(shareId: string): void {
		this.watchedShares.delete(shareId);
		log("Unregistered share from polling", { shareId });
	}

	start(): void {
		if (this.intervalId !== null) return;
		this.intervalId = this.timeProvider.scheduleInterval(
			() => { void this._poll(); },
			this.pollIntervalMs,
		);
		log("Started polling", { intervalMs: this.pollIntervalMs });
	}

	private async _poll(): Promise<void> {
		if (this.polling || this.webSyncManager.isOutboundSyncing) {
			log("Skipping poll — outbound sync in flight");
			return;
		}
		this.polling = true;
		try {
			const recoveredServers = new Set<string>();
			const failedServers = new Set<string>();
			for (const [shareId, info] of this.watchedShares) {
				const backoff = this.serverBackoff.get(info.serverId);
				if (backoff && this.timeProvider.now() < backoff.retryAt) continue;
				if (await this._checkShare(shareId, info.serverId, info.lastUpdatedAt)) {
					recoveredServers.add(info.serverId);
				} else {
					failedServers.add(info.serverId);
				}
			}
			// A healthy share cannot reset failures from another share on this server.
			for (const serverId of recoveredServers) {
				if (!failedServers.has(serverId)) this.serverBackoff.delete(serverId);
			}
		} finally {
			this.polling = false;
		}
	}

	private async _checkShare(
		shareId: string,
		serverId: string,
		lastUpdatedAt: string | null,
	): Promise<boolean> {
		try {
			// Bypass the 5-min share cache so server-side bumps are detected within one poll cycle
			const share = await this.clientManager.getShare(serverId, shareId, true);
			const newUpdatedAt = share.web_content_updated_at ?? null;
			if (!newUpdatedAt) {
				return true;
			}
			if (newUpdatedAt === lastUpdatedAt) {
				log("web_content_updated_at unchanged, skipping", { shareId });
				return true;
			}
			log("web_content_updated_at bumped, triggering download", {
				shareId,
				newUpdatedAt,
			});
			// Only advance lastUpdatedAt if the download actually ran (not skipped due to
			// outbound sync in flight) so a skipped cycle retries on the next poll.
			const result = await this.fileDownloader.downloadShare(shareId, serverId);
			if (result !== "skipped") {
				// unregister/destroy may run while a network request is in flight.
				if (!this.watchedShares.has(shareId)) return true;
				this.watchedShares.set(shareId, { serverId, lastUpdatedAt: newUpdatedAt });
				// Persist the watermark too, not just the in-memory copy —
				// otherwise the very next restart is back to lastUpdatedAt=null.
				this.persistedUpdatedAt.set(shareId, newUpdatedAt);
			}
			return result !== "skipped";
		} catch (err: unknown) {
			const failures = Math.min((this.serverBackoff.get(serverId)?.failures ?? 0) + 1, 5);
			const delay = Math.min(300_000, 30_000 * 2 ** (failures - 1) *
				(0.8 + Math.random() * 0.4));
			this.serverBackoff.set(serverId, { failures, retryAt: this.timeProvider.now() + delay });
			log("Failed to check share", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	destroy(): void {
		if (this.intervalId !== null) {
			this.timeProvider.cancelInterval(this.intervalId);
			this.intervalId = null;
		}
		this.watchedShares.clear();
		this.serverBackoff.clear();
		log("InboundSyncPoller destroyed");
	}
}
