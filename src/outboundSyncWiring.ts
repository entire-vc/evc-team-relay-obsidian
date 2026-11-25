/**
 * Binds the OutboundSyncWriter to the plugin: folder shares, the vault, the
 * CRDT documents and the relay control plane.
 */

import { TFile } from "obsidian";
import * as Y from "yjs";
import type { Vault } from "obsidian";
import type { Clock } from "./Clock";
import { isCanvasDocument } from "./CanvasDocument";
import { sha256Hex } from "./contentDigest";
import { isDocument } from "./Document";
import { namedLogger } from "./logging";
import {
	OutboundSyncWriter,
	isOutboundSyncPath,
	type OutboundTarget,
	type ServerSyncItem,
} from "./OutboundSyncWriter";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import { sameTextContent } from "./textEquivalence";
import { joinFolderPath, toFolderRelativePath } from "./vaultRootPath";
import { applyDiffToYText } from "./ytextDiff";
import { waitForBufferFlush } from "./websocketFlush";
import { ResourceAddress } from "./ResourceAddress";
import type { LiveText } from "./InboundFileDownloader";
import type { ShareRegistry, VaultShare } from "./VaultShare";
import { isAttachBackupPath } from "./attachReview";

const log = namedLogger("[OutboundSyncWiring]");

/** How often folder connection state is looked at to catch a (re)connect. */
export const RECONNECT_CHECK_MS = 15_000;

export function resolveOutboundTarget(
	shareRegistry: ShareRegistry,
	vaultPath: string,
): OutboundTarget | null {
	// The attach check's backups stay on this device (GH #114), also when the
	// shared folder is the vault root.
	if (isAttachBackupPath(vaultPath)) return null;
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder) return null;
	const shareId = folder.entityGuid;
	const serverId = folder.config.onpremServerId;
	if (!shareId || !serverId) return null;
	const relativePath = toFolderRelativePath(vaultPath, folder.path);
	if (!relativePath) return null;
	return { shareId, serverId, relativePath };
}

/**
 * The file's text, but only once it is synced with the relay: an open note
 * whose live CRDT is connected, synced and saved to disk, or a closed note
 * whose disk text is the base this client last agreed on with the relay.
 */
export async function readRelaySyncedText(
	vault: Vault,
	shareRegistry: ShareRegistry,
	vaultPath: string,
): Promise<string | null> {
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder || !folder.isOnline) return null;
	const tfile = vault.getAbstractFileByPath(vaultPath);
	if (!(tfile instanceof TFile)) return null;
	const entry = folder.rootRelative.entryFor(tfile);
	if (!entry) return null;
	const disk = await vault.read(tfile);
	if (isDocument(entry)) {
		if (entry.isOnline && entry.isSynced && sameTextContent(entry.content, disk)) return disk;
		const base = await entry.getSyncBase();
		return base !== undefined && sameTextContent(base, disk) ? disk : null;
	}
	if (isCanvasDocument(entry)) {
		return entry.isSynced ? disk : null;
	}
	return null;
}

/** Transaction origin of "Use server version", distinct from any editor or document. */
export const TAKE_SERVER_ORIGIN = "take-server-version";

/** Longest wait for a closed note to connect and sync before "Use server version" gives up. */
export const TAKE_SERVER_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Connections tried before "Use server version" gives up on a relay room
 * that is still loading, and the pause before each retry. A room the relay
 * has not loaded yet in its process lifetime answers the sync off an empty
 * placeholder and never sends the stored text to that connection
 * a diff taken then is against this device's own copy and
 * misses what other members added, so the members end up with mixed text.
 */
export const TAKE_SERVER_CONNECT_ROUNDS = 4;
export const TAKE_SERVER_COLD_RETRY_MS = 2_000;

/** Longest wait for the replacement to leave the socket's send buffer. */
export const TAKE_SERVER_FLUSH_MAX_MS = 10_000;

/**
 * True when the relay's sync came from the stored room, not a placeholder:
 * its sync step 1 named at least one writer. Unknown (no step 1 seen) counts
 * as loaded so a relay that skips it still works as before.
 */
function relayRoomLoaded(stateVector: Uint8Array | null | undefined): boolean {
	if (!stateVector) return true;
	return Y.decodeStateVector(stateVector).size > 0;
}

/**
 * The note's live CRDT text for "Use server version": the relay
 * carries the replacement to every member of the share and an open editor
 * follows it.
 *
 * A note that is not open in an editor has no relay connection, and nothing
 * else connects it soon: the background sweep visits it once per pass
 * (CrdtBackgroundSyncPoller, 15 min) and its own change marker only sends
 * OTHER clients to pull it. Text set in such a Y.Doc stayed on this device,
 * so the note split between members. The document is therefore connected
 * and synced with the relay's stored room BEFORE anything changes (see
 * TAKE_SERVER_CONNECT_ROUNDS), so the diff is taken against the text every
 * member has, and the connection is closed only after the update has left
 * the send buffer. When the relay does not answer or keeps answering off a
 * placeholder, this throws and nothing is changed.
 *
 * Resolves null when the path has no CRDT document (not in a folder share,
 * not a note); the caller then writes the file instead.
 */
export async function liveTextTarget(
	vault: Vault,
	shareRegistry: ShareRegistry,
	clock: Clock,
	vaultPath: string,
): Promise<LiveText | null> {
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder) return null;
	const tfile = vault.getAbstractFileByPath(vaultPath);
	if (!(tfile instanceof TFile)) return null;
	const entry = folder.rootRelative.entryFor(tfile);
	if (!entry || !isDocument(entry)) return null;
	await entry.awaitFirstSync();
	// The replacement is what this client now agrees with the relay on: record
	// it as the sync base, or the next closed-file edit compares against the
	// pre-replacement base, reads "the relay moved" and writes a conflict copy.
	const apply = async (text: string) => {
		applyDiffToYText(entry.crdtDoc, text, TAKE_SERVER_ORIGIN);
		await entry.setSyncBase(text);
	};
	if (entry.isOnline) {
		return {
			replace: (text) => apply(text),
			release: () => {},
		};
	}

	const sleep = (ms: number) => new Promise<void>((resolve) => clock.scheduleTimeout(resolve, ms));
	const intent = entry.connectionIntent;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		// Same rule as the background transfers: only a connection opened here
		// is dropped, never one an editor opened meanwhile.
		if (intent === "disconnected" && !entry.editLock) {
			entry.goOffline();
			entry.vaultShare.credentialCache.dropFromQueue(ResourceAddress.serialize(entry.resourceAddress));
		}
	};
	for (let round = 1; ; round++) {
		const synced =
			(await entry.bringOnline()) &&
			(await within(clock, TAKE_SERVER_CONNECT_TIMEOUT_MS, entry.onceFreshlySynced()));
		if (!synced) {
			release();
			throw new Error("the relay did not answer for this note; nothing was changed");
		}
		if (relayRoomLoaded(entry._liveProvider.relayStateVector)) break;
		if (round >= TAKE_SERVER_CONNECT_ROUNDS) {
			// A room that stays empty while this device has nothing either is
			// simply empty: the replacement is the whole text, nothing to mix.
			if (Y.decodeStateVector(Y.encodeStateVector(entry.crdtDoc)).size === 0) break;
			release();
			throw new Error("the relay is still loading this note; nothing was changed, try again");
		}
		if (entry.editLock) {
			// An editor opened meanwhile owns this connection; it is not cut
			// to retry. Retrying the action uses the editor's connection.
			throw new Error("the note was opened while the relay was loading it; nothing was changed, try again");
		}
		// Only a new connection gets the stored text once the room has loaded.
		entry.goOffline();
		await sleep(TAKE_SERVER_COLD_RETRY_MS);
	}
	return {
		replace: async (text) => {
			await apply(text);
			// A fixed pause before the socket closes dropped a large update
			// on a slow link; wait for the send buffer to drain.
			await waitForBufferFlush(entry._liveProvider.ws, {
				maxWaitMs: TAKE_SERVER_FLUSH_MAX_MS,
				sleep,
				now: clock.now,
			});
		},
		release,
	};
}

/** True when `promise` settles within `ms`, false on timeout; never rejects. */
async function within(clock: Clock, ms: number, promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => false,
		),
		new Promise<boolean>((resolve) => clock.scheduleTimeout(() => resolve(false), ms)),
	]);
}

export function createOutboundSyncWriter(opts: {
	vault: Vault;
	clock: Clock;
	shareRegistry: ShareRegistry;
	clientManager: RelayOnPremShareClientManager;
	baseStore: Map<string, Record<string, string>>;
}): OutboundSyncWriter {
	const { vault, clock, shareRegistry, clientManager, baseStore } = opts;
	return new OutboundSyncWriter({
		clock,
		baseStore,
		resolveTarget: (vaultPath) => resolveOutboundTarget(shareRegistry, vaultPath),
		readSyncedText: (vaultPath) => readRelaySyncedText(vault, shareRegistry, vaultPath),
		supportsSyncOrigin: async (serverId) => {
			const client = clientManager.getClient(serverId);
			if (!client) return false;
			const info = await client.getServerInfo();
			return info.features?.sync_write_origin === true;
		},
		getFilesIndex: async (serverId, shareId): Promise<ServerSyncItem[]> =>
			clientManager.getFilesIndex(serverId, shareId),
		syncWrite: (target, content, precondition, mime) =>
			clientManager.syncWriteFile(
				target.serverId,
				target.shareId,
				target.relativePath,
				content,
				precondition,
				mime,
				{ origin: "crdt" },
			),
		sha256: (text) => sha256Hex(new TextEncoder().encode(text).buffer),
		supportsSyncDelete: async (serverId) => {
			const client = clientManager.getClient(serverId);
			if (!client) return false;
			const info = await client.getServerInfo();
			return info.features?.sync_delete === true;
		},
		syncDelete: (target, ifMatchSha256) =>
			clientManager.syncDeleteFile(target.serverId, target.shareId, target.relativePath, ifMatchSha256),
		existsInVault: (vaultPath) => vault.getAbstractFileByPath(vaultPath) !== null,
	});
}


/**
 * Reconcile each folder share when it comes online: at start and after every
 * reconnect, once its CRDT has freshly synced. Returns a stop function.
 */
export function watchShareReconnects(opts: {
	vault: Vault;
	clock: Clock;
	shareRegistry: ShareRegistry;
	writer: OutboundSyncWriter;
}): () => void {
	const { vault, clock, shareRegistry, writer } = opts;
	const online = new WeakMap<VaultShare, boolean>();

	const reconcileFolder = (folder: VaultShare): void => {
		void folder
			.onceFreshlySynced()
			.then(async () => {
				const paths = vault
					.getFiles()
					.map((file) => file.path)
					.filter((path) => isOutboundSyncPath(path) && shareRegistry.shareFor(path) === folder);
				log("Reconciling share with the sync protocol", { folder: folder.path, files: paths.length });
				writer.reconcile(paths);
				// Deletes made while offline: an entry neither on disk nor in the
				// CRDT goes from the sync protocol too.
				const shareId = folder.entityGuid;
				const serverId = folder.config.onpremServerId;
				if (!shareId || !serverId) return;
				const toVaultPath = (relativePath: string): string => joinFolderPath(folder.path, relativePath);
				// A share that left this vault meanwhile counts as live: a retried
				// scan must never read an unloaded share as "everything deleted".
				const stillShared = (): boolean => !!shareRegistry.locate((sf) => sf === folder);
				await writer.reconcileDeletes({ shareId, serverId }, toVaultPath, (relativePath) =>
					!stillShared() ||
					vault.getAbstractFileByPath(toVaultPath(relativePath)) !== null ||
					folder.folderIndex.recordFor(relativePath) !== undefined,
				);
			})
			.catch((err: unknown) => {
				log("Reconcile skipped", { error: err instanceof Error ? err.message : String(err) });
			});
	};

	const check = (): void => {
		shareRegistry.each((folder) => {
			// Held by the attach check (GH #114): counts as offline, so the
			// reconnect reconcile runs once the user has decided.
			const isOnline = folder.isOnline && !folder.attachHeld;
			const wasOnline = online.get(folder) ?? false;
			online.set(folder, isOnline);
			if (isOnline && !wasOnline) reconcileFolder(folder);
		});
	};

	const timer = clock.scheduleInterval(check, RECONNECT_CHECK_MS);
	check();
	return () => clock.cancelInterval(timer);
}
