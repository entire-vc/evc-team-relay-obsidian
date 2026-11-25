/**
 * Inbound File Downloader (v1.9)
 *
 * Fetches sync-artifact items from the server files index and writes them
 * to the local vault. Called by InboundSyncPoller when web_content_updated_at bumps.
 */

import { normalizePath, Notice, TFile, Vault } from "obsidian";
import { dirname, join } from "path-browserify";
import { namedLogger } from "./logging";
import { isTransientRelayFailure } from "./relayRequestErrors";
import { sha256Hex } from "./contentDigest";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { WebSyncManager } from "./WebSyncManager";
import { normalizeLineEndings } from "./textEquivalence";

const log = namedLogger("[InboundFileDownloader]");

/** A file the downloader refused to overwrite because the local content diverged
 * from what we last wrote (user edit, or unknown provenance). Surfaced by
 * `getConflicts()` for the "Team Relay: Show sync conflicts" command. */
export interface SyncConflict {
	shareId: string;
	serverId: string;
	relativePath: string;
	vaultPath: string;
	localHash: string;
	serverHash: string;
	detectedAt: number;
	/** Where the local text came from: "relay" = it is the shared
	 * live note exactly as the relay has it, not an edit made on this device;
	 * "device" = it differs from the relay too; undefined = unknown. */
	localSource?: "relay" | "device";
}

/** Text files whose content the downloader may compare line by line. */
function isComparableTextPath(path: string): boolean {
	return /\.(md|canvas)$/i.test(path);
}

/**
 * True when every non-empty line of `server` appears in `local`, whole and in
 * the same order: the local text is the server's text plus added
 * lines, so adopting the server version as the base and pushing the local
 * text over it loses no line of the server version. Blank lines carry no
 * content and are ignored. A line edited or deleted on either side fails the
 * check; then the user decides. The one case it cannot tell apart is a line
 * the server deleted that the local text still has: it is kept, i.e. text is
 * restored rather than lost.
 */
export function containsAllLinesInOrder(local: string, server: string): boolean {
	const localLines = normalizeLineEndings(local).split("\n");
	let at = 0;
	for (const line of normalizeLineEndings(server).split("\n")) {
		if (line.trim() === "") continue;
		while (at < localLines.length && localLines[at] !== line) at++;
		if (at === localLines.length) return false;
		at++;
	}
	return true;
}

/**
 * A note's live CRDT text, connected to the relay for "Use server version"
 * `replace` sets the text as an ordinary edit and resolves once
 * the update had time to leave this device; `release` drops a connection that
 * was opened only for this and may be called more than once.
 */
export interface LiveText {
	replace(text: string): Promise<void>;
	release(): void;
}

export class InboundFileDownloader {
	private vault: Vault;
	private clientManager: RelayOnPremShareClientManager;
	private webSyncManager: WebSyncManager;

	// Map<shareId, Record<relativePath, sha256>> — last sha256 we wrote per file.
	// Injectable so callers can back it with VaultScopedMap
	// (vault-scoped, persisted) instead of a bare in-memory Map — an in-memory-only
	// manifest resets to empty on every plugin reload, which made the "is this a
	// user edit?" guard below never fire right after a restart. Defaults to a plain
	// Map for callers (incl. tests) that don't need persistence.
	private lastWrittenHash: Map<string, Record<string, string>>;
	// Vault paths currently being written — echo-loop guard for vault "modify" events
	private writingPaths: Set<string> = new Set();

	// Unresolved user-edit/unknown-provenance conflicts, keyed by `${shareId}:${relativePath}`.
	// Deliberately in-memory only (not persisted like lastWrittenHash): a conflict still
	// live after a plugin reload SHOULD surface once more on the next sync pass, that's
	// not a bug. Cleared on resolution (either resolve method below) and on a successful
	// download for the same key (belt-and-braces, in case the file started matching again
	// without going through either resolve path).
	private conflicts: Map<string, SyncConflict> = new Map();

	// Called after every completed pass over a share (and after "keep local"),
	// so the outbound writer can retry paths that waited for an external
	// version to be pulled first.
	private passListener: ((shareId: string) => void) | null = null;

	// Whether the local file is the shared live note exactly as the relay has
	// it; only used to tell the user where a conflict's local text
	// came from.
	private relayTextProbe: ((vaultPath: string) => Promise<boolean>) | null = null;

	// Resolves the note's live CRDT text, already connected to the relay
	// or null when the path has no CRDT document; then the
	// caller writes the file as an ordinary edit.
	private liveTextTarget: ((vaultPath: string) => Promise<LiveText | null>) | null = null;
	private isAttachHeld: ((shareId: string) => boolean) | null = null;

	constructor(
		vault: Vault,
		clientManager: RelayOnPremShareClientManager,
		webSyncManager: WebSyncManager,
		hashManifestStore: Map<string, Record<string, string>> = new Map(),
	) {
		this.vault = vault;
		this.clientManager = clientManager;
		this.webSyncManager = webSyncManager;
		this.lastWrittenHash = hashManifestStore;
	}

	/**
	 * Returns true while a file is being written by this downloader.
	 * main.ts checks this to suppress outbound sync echo.
	 */
	isInboundWriting(vaultPath: string): boolean {
		return this.writingPaths.has(vaultPath);
	}

	setPassListener(listener: ((shareId: string) => void) | null): void {
		this.passListener = listener;
	}

	setRelayTextProbe(probe: ((vaultPath: string) => Promise<boolean>) | null): void {
		this.relayTextProbe = probe;
	}

	setLiveTextTarget(target: ((vaultPath: string) => Promise<LiveText | null>) | null): void {
		this.liveTextTarget = target;
	}

	/**
	 * Is this share's local folder held by the attach check (GH #114)? Nothing
	 * is written into a held folder until the user has decided.
	 */
	setAttachHeldProbe(probe: ((shareId: string) => boolean) | null): void {
		this.isAttachHeld = probe;
	}

	/**
	 * Main entry point — called by InboundSyncPoller when web_content_updated_at bumps.
	 * Resolves the share path, fetches the files index, diffs, and writes new/updated items.
	 * Returns "skipped" when outbound sync is in flight so the poller can retry.
	 */
	async downloadShare(shareId: string, serverId: string): Promise<"ran" | "skipped"> {
		if (this.webSyncManager.isOutboundSyncing) {
			log("Skipping — outbound sync in flight", { shareId });
			return "skipped";
		}
		if (this.isAttachHeld?.(shareId)) {
			log("Skipping — folder held by the attach check", { shareId });
			return "skipped";
		}

		// Resolve share path (cached by clientManager for 5 min)
		let sharePath: string;
		try {
			const share = await this.clientManager.getShare(serverId, shareId);
			sharePath = share.path;
		} catch (err: unknown) {
			log("Failed to resolve share path", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return "ran";
		}

		let items;
		try {
			items = await this.clientManager.getFilesIndex(serverId, shareId);
		} catch (err: unknown) {
			log("Failed to fetch files index", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return "ran";
		}

		// Filter to sync-artifact type only (server may return all types)
		const syncItems = items.filter(
			(item) => !item.type || item.type === "sync-artifact",
		);

		if (syncItems.length === 0) {
			log("No sync-artifact items in files index", { shareId });
			return "ran";
		}

		const before = { ...(this.lastWrittenHash.get(shareId) ?? {}) };
		const shareManifest = { ...before };

		try {
			for (const item of syncItems) {
				await this._downloadItem(
					item.path,
					item.sha256,
					shareId,
					serverId,
					sharePath,
					shareManifest,
					item.origin,
				);
			}
		} finally {
			// Keep completed files when a transport failure stops the batch. Its
			// watermark stays unchanged so the next pass retries unfinished files.
			// Merge only what this pass changed: the outbound writer records its
			// own bases in the same store while a pass is running.
			// A key the store no longer holds at its snapshot value was written
			// by the writer during this pass; its newer base wins.
			const merged = { ...(this.lastWrittenHash.get(shareId) ?? {}) };
			for (const [path, sha] of Object.entries(shareManifest)) {
				if (before[path] !== sha && merged[path] === before[path]) merged[path] = sha;
			}
			this.lastWrittenHash.set(shareId, merged);
		}
		this.passListener?.(shareId);
		return "ran";
	}

	private async _downloadItem(
		relativePath: string,
		serverSha256: string,
		shareId: string,
		serverId: string,
		sharePath: string,
		shareManifest: Record<string, string>,
		origin?: string,
	): Promise<void> {
		const vaultPath = normalizePath(join(sharePath, relativePath));

		// Guard against path traversal: the resolved vault path must stay inside sharePath.
		// A server-supplied relativePath like "../../.obsidian/plugins/evil.js" would resolve
		// outside the share directory after join+normalize — reject it before any I/O.
		const normalizedShare = normalizePath(sharePath);
		if (normalizedShare.length === 0) {
			// sharePath is server-supplied (share.path from clientManager.getShare()); an empty
			// value would otherwise disable the containment check entirely. Fail closed.
			log("Path traversal rejected: empty sharePath", { relativePath, shareId });
			return;
		}
		const withinShare =
			vaultPath === normalizedShare || vaultPath.startsWith(normalizedShare + "/");
		if (!withinShare) {
			log("Path traversal rejected", { relativePath, vaultPath, sharePath });
			return;
		}

		const lastHash = shareManifest[relativePath];

		// Skip if sha256 unchanged since last download
		if (lastHash === serverSha256) {
			return;
		}

		const abstractFile = this.vault.getAbstractFileByPath(vaultPath);

		// A crdt-origin item is some client's mirror of the live CRDT text
		//: the relay already delivers it to this vault, and writing
		// the file here as well would duplicate lines in an open note. Only
		// adopt it as the base once the local file holds exactly that text.
		if (origin === "crdt") {
			if (abstractFile instanceof TFile) {
				const localHash = await this._localHash(abstractFile, vaultPath);
				if (localHash === serverSha256) {
					shareManifest[relativePath] = serverSha256;
					this.conflicts.delete(`${shareId}:${relativePath}`);
				}
			}
			return;
		}

		// Guard against overwriting user edits:
		// If the file exists locally, check it against `lastHash` — what we last
		// wrote for this path — regardless of whether `lastHash` is defined. It
		// used to only check `if (lastHash)`, so a manifest with no recorded
		// history for this path (in-memory manifest wiped on every plugin
		// reload, or genuinely never synced before) skipped the check entirely
		// and downloaded straight over whatever was on disk. Now: known history
		// that doesn't match local content -> user edit, skip. No history at all
		// but the local file doesn't match what we're about to write -> unknown
		// provenance, ALSO skip rather than assume it's safe to overwrite.
		if (abstractFile instanceof TFile) {
			// Only the read + hash computation is I/O that can legitimately fail;
			// the notify-and-skip decision below is not wrapped, so a bug there
			// surfaces as itself instead of being mislabeled a read failure.
			const local = await this._readLocal(abstractFile, vaultPath);
			if (local === undefined) return;
			const localHash = local.hash;
			// The vault already holds exactly the server's version (e.g. it
			// arrived through the CRDT, or this client wrote it): nothing to
			// write, only the base moves.
			if (localHash === serverSha256) {
				shareManifest[relativePath] = serverSha256;
				this.conflicts.delete(`${shareId}:${relativePath}`);
				return;
			}
			// No base yet (fresh device, reinstall, new member) and the local
			// text already holds every line of the server version, typically
			// the live note edited in Obsidian after that version was pulled
			// elsewhere: adopt it as the base without writing anything, so the
			// outbound writer can mirror the local text over it.
			// Without this the writer waits for this pass and this pass waits
			// for the user, and the edit never reaches the sync protocol.
			if (
				lastHash === undefined &&
				(await this._localExtendsServer(local.bytes, serverSha256, shareId, serverId, relativePath, vaultPath))
			) {
				shareManifest[relativePath] = serverSha256;
				this.conflicts.delete(`${shareId}:${relativePath}`);
				return;
			}
			const expectedHash = lastHash ?? serverSha256;
			if (localHash !== expectedHash) {
				const conflictKey = `${shareId}:${relativePath}`;
				const existing = this.conflicts.get(conflictKey);
				const localSource = await this._localSource(vaultPath);
				// Dedup: don't re-notify on every sync cycle while neither side of the
				// conflict has moved — that's the "toast stack grows forever" bug. Do
				// re-notify if the local edit changed again, or the server moved (a
				// genuinely new conflict state), so dedup can't silently swallow one.
				const isSameConflictAsLastNotified =
					existing !== undefined &&
					existing.localHash === localHash &&
					existing.serverHash === serverSha256;
				this.conflicts.set(conflictKey, {
					shareId,
					serverId,
					relativePath,
					vaultPath,
					localHash,
					serverHash: serverSha256,
					detectedAt: existing?.detectedAt ?? Date.now(),
					localSource,
				});
				if (isSameConflictAsLastNotified) {
					log("Sync conflict still unresolved, not re-notifying", { vaultPath });
					return;
				}
				log("Skipping user-edited (or unknown-provenance) file", {
					vaultPath,
					localHash,
					lastWritten: lastHash ?? "(none recorded)",
					serverHash: serverSha256,
				});
				new Notice(
					localSource === "relay"
						? `Team Relay: "${relativePath}" differs from the relay's sync copy. ` +
							`The note on this device is the shared live note from the relay, ` +
							`not an edit made here. Run "Team Relay: Show sync conflicts" to ` +
							`choose which version to keep.`
						: `Team Relay: skipped syncing "${relativePath}" — local changes ` +
							`would have been overwritten by the relay version. Run ` +
							`"Team Relay: Show sync conflicts" to resolve.`,
					8000,
				);
				return;
			}
		}
		// Reaching here means we're about to download: either the local file is
		// gone (deleted manually) or its content now
		// matches what we expected. Either way any previously-tracked conflict
		// for this path is stale — drop it so getConflicts() doesn't list a file
		// that's no longer actually in conflict.
		this.conflicts.delete(`${shareId}:${relativePath}`);

		// Download
		let content: ArrayBuffer;
		try {
			content = await this.clientManager.downloadFile(serverId, shareId, relativePath);
		} catch (err: unknown) {
			log("Failed to download file", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return;
		}

		// Ensure parent directory exists
		const parentDir = normalizePath(dirname(vaultPath));
		if (parentDir && parentDir !== "." && parentDir !== "/") {
			try {
				await this.vault.adapter.mkdir(parentDir);
			} catch {
				// Directory may already exist
			}
		}

		// Write to vault with echo-loop guard
		this.writingPaths.add(vaultPath);
		try {
			await this.vault.adapter.writeBinary(vaultPath, content);
			shareManifest[relativePath] = serverSha256;
			log("Wrote sync-artifact to vault", { vaultPath, sha256: serverSha256 });
		} catch (err: unknown) {
			log("Failed to write file to vault", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.writingPaths.delete(vaultPath);
		}
	}

	/** sha256 of the local file, or undefined when it cannot be read (then nothing is written). */
	private async _localHash(file: TFile, vaultPath: string): Promise<string | undefined> {
		return (await this._readLocal(file, vaultPath))?.hash;
	}

	/** The local file's bytes and sha256, or undefined when it cannot be read. */
	private async _readLocal(
		file: TFile,
		vaultPath: string,
	): Promise<{ bytes: ArrayBuffer; hash: string } | undefined> {
		try {
			const bytes = await this.vault.readBinary(file);
			return { bytes, hash: await sha256Hex(bytes) };
		} catch (err: unknown) {
			log("Could not read existing file, skipping to avoid data loss", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/**
	 * Whether the local text holds every line of the server version
	 * (`containsAllLinesInOrder`). Reads the server version without writing it;
	 * a version that moved since files-index (sha mismatch) or cannot be read
	 * counts as "no", so the ordinary conflict path decides.
	 */
	private async _localExtendsServer(
		localBytes: ArrayBuffer,
		serverSha256: string,
		shareId: string,
		serverId: string,
		relativePath: string,
		vaultPath: string,
	): Promise<boolean> {
		if (!isComparableTextPath(relativePath)) return false;
		let serverBytes: ArrayBuffer;
		try {
			serverBytes = await this.clientManager.downloadFile(serverId, shareId, relativePath);
		} catch (err: unknown) {
			log("Could not read the server version to compare", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			if (isTransientRelayFailure(err)) throw err;
			return false;
		}
		if ((await sha256Hex(serverBytes)) !== serverSha256) return false;
		const decoder = new TextDecoder();
		const extends_ = containsAllLinesInOrder(decoder.decode(localBytes), decoder.decode(serverBytes));
		if (extends_) {
			log("Local text holds every line of the server version, adopting it as the base", {
				vaultPath,
				serverHash: serverSha256,
			});
		}
		return extends_;
	}

	private async _localSource(vaultPath: string): Promise<"relay" | "device" | undefined> {
		if (!this.relayTextProbe) return undefined;
		try {
			return (await this.relayTextProbe(vaultPath)) ? "relay" : "device";
		} catch {
			return undefined;
		}
	}

	/** All currently-unresolved sync conflicts, for the "Show sync conflicts" command. */
	getConflicts(): SyncConflict[] {
		return Array.from(this.conflicts.values());
	}

	/**
	 * Resolve a conflict by taking the server version: replace the
	 * local text with the relay's sync copy in place, as an ordinary edit. The
	 * file is never trashed: a delete in a shared folder reaches the CRDT and
	 * removes the note for everyone in the share.
	 *
	 * A note with a live CRDT document is connected to the relay first (a closed
	 * note has no connection, and text set in an unconnected Y.Doc never left
	 * this device). Then it gets the same bytes on disk under the echo
	 * guard, and only once that write succeeded the server text in its
	 * CRDT (the relay carries the change to the other members): a failed write
	 * leaves the shared note and the conflict untouched. Any other file is
	 * written with an ordinary vault modify, so the usual modify handling
	 * carries it to the relay. The server hash becomes the base, so the next
	 * pass sees no conflict and the outbound writer finds local = server and
	 * pushes nothing.
	 */
	async resolveTakeServer(shareId: string, relativePath: string): Promise<void> {
		const key = `${shareId}:${relativePath}`;
		const conflict = this.conflicts.get(key);
		if (!conflict) return;
		const { vaultPath, serverId } = conflict;
		const abstractFile = this.vault.getAbstractFileByPath(vaultPath);
		if (!(abstractFile instanceof TFile)) {
			// Nothing local left to replace: the next pass writes the server copy.
			this.conflicts.delete(key);
			return;
		}

		const serverBytes = await this.clientManager.downloadFile(serverId, shareId, relativePath);
		const serverHash = await sha256Hex(serverBytes);
		// Connected before anything changes: when the relay can't be reached
		// this throws and the note and the conflict stay as they are.
		const live =
			this.liveTextTarget && isComparableTextPath(relativePath)
				? await this.liveTextTarget(vaultPath)
				: null;

		try {
			if (live) {
				// The CRDT gets this text right after; the disk write is not a new edit.
				this.writingPaths.add(vaultPath);
				try {
					await this.vault.modifyBinary(abstractFile, serverBytes);
				} finally {
					this.writingPaths.delete(vaultPath);
				}
				await live.replace(new TextDecoder().decode(serverBytes));
			} else {
				await this.vault.modifyBinary(abstractFile, serverBytes);
			}
		} finally {
			live?.release();
		}

		const shareManifest = { ...(this.lastWrittenHash.get(shareId) ?? {}) };
		shareManifest[relativePath] = serverHash;
		this.lastWrittenHash.set(shareId, shareManifest);
		this.conflicts.delete(key);
		log("Replaced local text with the server version", { vaultPath, serverHash, live: live !== null });
	}

	/**
	 * Resolve a conflict by keeping the local version: record the server's hash as
	 * if we'd already written it, WITHOUT touching the local file. The guard above
	 * short-circuits on `lastHash === serverSha256` before it ever reads the file
	 * again, so this stops the nagging without overwriting anything — and because
	 * it only acknowledges today's server hash, a later server-side change is a
	 * new mismatch and correctly re-surfaces as a fresh conflict.
	 */
	resolveKeepLocal(shareId: string, relativePath: string): void {
		const key = `${shareId}:${relativePath}`;
		const conflict = this.conflicts.get(key);
		if (!conflict) return;
		const shareManifest = this.lastWrittenHash.get(shareId) ?? {};
		shareManifest[relativePath] = conflict.serverHash;
		this.lastWrittenHash.set(shareId, shareManifest);
		this.conflicts.delete(key);
		// The server version is now this client's base, so the outbound
		// writer may push the kept local text over it.
		this.passListener?.(shareId);
	}

	destroy(): void {
		// Deliberately does NOT clear lastWrittenHash: when
		// backed by a persisted store, wiping it here on every plugin
		// unload/reload would defeat the entire point of persisting it. Only
		// transient in-flight-write tracking is reset.
		this.writingPaths.clear();
		log("InboundFileDownloader destroyed");
	}
}
