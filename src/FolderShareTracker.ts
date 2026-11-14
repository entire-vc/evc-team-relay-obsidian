import type { Vault } from "obsidian";
import type { InboundSyncPoller } from "./InboundSyncPoller";
import type { ShareRegistry, VaultShare } from "./VaultShare";
import { resolveShareFolder } from "./vaultRootPath";

/**
 * Routes folder shares from the share list to the inbound poller (v1.9):
 * a share with a VaultShare or a folder in this vault is polled, any other
 * one is checked once from the listed timestamp, which downloads it into
 * the vault when the server has something newer.
 *
 * A dormant share (restored without its folder, listed as "Folder not
 * found") is neither: a listed check would download its files and recreate
 * the folder the user has not re-linked or recreated yet. It waits for
 * Re-link or Recreate; the next share-list load routes it again.
 */
export class FolderShareTracker {
	/**
	 * Folder shares polled because a folder sits at their path although no
	 * VaultShare was made for it; keyed by share id, valued by that path.
	 */
	private pathOnlyPolledShares = new Map<string, string>();

	constructor(
		private readonly registry: ShareRegistry,
		private readonly vault: Vault,
		private readonly poller: () => InboundSyncPoller | undefined,
	) {}

	/**
	 * The VaultShare of `shareId` unless it is dormant: pollers and the
	 * share-list load treat a dormant share as not here.
	 */
	liveShareFor(shareId: string): VaultShare | undefined {
		return this.registry.locate((sf) => sf.entityGuid === shareId && !sf.isDormant);
	}

	/** The dormant share that stands for this listed share, by guid or by path. */
	private dormantShareFor(shareId: string, sharePath: string): VaultShare | undefined {
		return this.registry.locate(
			(sf) => sf.isDormant && (sf.entityGuid === shareId || sf.path === sharePath),
		);
	}

	/** Whether a polled share still has a VaultShare, or still has its folder. */
	readonly keepPolling = (shareId: string): boolean => {
		if (this.liveShareFor(shareId)) return true;
		const path = this.pathOnlyPolledShares.get(shareId);
		return path !== undefined && !!resolveShareFolder(this.vault, path);
	};

	get hasPathOnlyShares(): boolean {
		return this.pathOnlyPolledShares.size > 0;
	}

	/** Drop polled shares that lost their VaultShare or folder. */
	retain(): void {
		this.poller()?.retainOnly(this.keepPolling);
	}

	/**
	 * After a registry change: a share polled by path that now has a
	 * VaultShare follows the VaultShare from here on, so disconnecting it
	 * stops the polling.
	 */
	onRegistryChange(): void {
		for (const shareId of [...this.pathOnlyPolledShares.keys()]) {
			if (this.liveShareFor(shareId)) this.pathOnlyPolledShares.delete(shareId);
		}
		this.retain();
	}

	/**
	 * Hand a folder share from the share list to the inbound poller: polled
	 * if it has a VaultShare or a folder in this vault, skipped while its
	 * VaultShare is dormant, otherwise checked from the listed timestamp.
	 */
	track(
		shareId: string,
		serverId: string,
		sharePath: string,
		listedUpdatedAt: string | null | undefined,
	): void {
		const poller = this.poller();
		if (!poller) return;
		if (this.dormantShareFor(shareId, sharePath)) {
			this.pathOnlyPolledShares.delete(shareId);
			poller.unregisterShare(shareId);
			return;
		}
		// Re-run after a listed check's download: once it has written the
		// folder, the share is polled.
		const isLocal = (): boolean => {
			const registered = !!this.liveShareFor(shareId);
			const pathOnly = !registered && !!resolveShareFolder(this.vault, sharePath);
			if (pathOnly) this.pathOnlyPolledShares.set(shareId, sharePath);
			else this.pathOnlyPolledShares.delete(shareId);
			return registered || pathOnly;
		};
		poller.track(shareId, serverId, isLocal(), listedUpdatedAt, isLocal);
	}
}
