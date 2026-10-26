/**
 * Web Sync Manager
 *
 * Handles automatic synchronization of documents to web when shares have auto-sync enabled.
 */

import { Notice, TFile, Vault, debounce } from "obsidian";
import { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { WebFolderEntry } from "./RelayOnPremShareClient";
import { namedLogger } from "./logging";
import { RelayHttpError, isTransientRelayFailure } from "./relayRequestErrors";
import {
	collectWebFolderItems,
	isPathWithinFolder,
	resolveShareFolder,
	toFolderRelativePath,
} from "./vaultRootPath";

const log = namedLogger("[WebSyncManager]");

// Auto-sync folder shares only publish text content via the /files JSON
// endpoint. Any other extension (images, PDFs, etc.) read as text
// via vault.read() corrupts binary data as UTF-8 and POSTs garbage — skip
// them instead. Matches the extension set getFolderItems() already tracks
// in the folder's web index below.
const SYNCABLE_FOLDER_FILE_EXTENSIONS = new Set(["md", "canvas"]);

// web_folder_items pushes (PATCH /v1/shares/{id} with the folder's full item
// list) are coalesced per folder share: a background pull of N
// documents fires N create events, and pushing on each one sent N PATCHes
// with an O(N) body, enough to overload the server. Pushes
// now wait for a quiet period (capped by a max wait so a long pull still
// publishes progress), run at most one at a time per share with the latest
// state winning, skip lists identical to the last one the server accepted,
// and back off on 429/5xx instead of retrying in a loop.
const FOLDER_ITEMS_DEBOUNCE_MS = 3000;
const FOLDER_ITEMS_MAX_WAIT_MS = 30_000;
const FOLDER_ITEMS_BACKOFF_BASE_MS = 5000;
const FOLDER_ITEMS_BACKOFF_MAX_MS = 300_000;

interface FolderItemsPushState {
	shareId: string;
	timer: number | null;
	// When the oldest unsent change arrived; bounds how long a steady stream
	// of events can keep postponing the push.
	firstPendingAt: number | null;
	// The PATCH currently running for this share (scheduled or manual), if any.
	inFlight: Promise<void> | null;
	dirty: boolean;
	// JSON of the last item list the server accepted for this share.
	lastSentFingerprint: string | null;
	// Backoff gate after a 429/5xx: no push before this time.
	notBefore: number;
	failures: number;
}

interface ShareInfo {
	shareId: string;
	serverId: string;
	lastSync: number;
	kind: "doc" | "folder";
	webSlug?: string;
}

export class WebSyncManager {
	private vault: Vault;
	private clientManager: RelayOnPremShareClientManager;
	private autoSyncShares: Map<string, ShareInfo> = new Map();
	private syncDebounceMs = 2000; // Wait 2 seconds after last change
	private minSyncIntervalMs = 5000; // Minimum 5 seconds between syncs (rate limiting)

	// True while ANY outbound push is in flight; read by InboundSyncPoller /
	// InboundFileDownloader to avoid echo loops. Ref-counted rather
	// than a plain featureKey — two outbound pushes for different shares can race
	// each other, and a naive boolean would be cleared by whichever finishes
	// first while the other is still uploading, defeating the guard. Set via
	// _beginOutboundSync()/_endOutboundSync(); never write it directly.
	private _outboundSyncCount = 0;
	get isOutboundSyncing(): boolean {
		return this._outboundSyncCount > 0;
	}

	private _beginOutboundSync(): void {
		this._outboundSyncCount++;
	}

	private _endOutboundSync(): void {
		this._outboundSyncCount = Math.max(0, this._outboundSyncCount - 1);
	}

	/**
	 * Run an outbound content push under the echo-guard, for callers OUTSIDE
	 * this class's own debounced auto-sync paths
	 * — manual "Sync All"/"Sync Current File" commands, the stale-share
	 * startup catch-up, and the Settings/Detail-view "sync now" actions all
	 * push content directly via the share client, bypassing syncFile()/
	 * syncFolderFile() (those methods only handle pre-registered auto-sync
	 * shares). Without this, InboundSyncPoller/InboundFileDownloader could
	 * race a manual push the same way fixed for the debounced path.
	 */
	async runOutboundSync<T>(fn: () => Promise<T>): Promise<T> {
		this._beginOutboundSync();
		try {
			return await fn();
		} finally {
			this._endOutboundSync();
		}
	}

	// Debounced sync function per file path (doc shares — keyed by the doc's own path)
	private debouncedSyncMap: Map<string, () => void> = new Map();

	// Debounced sync function per individual file inside a folder share.
	// Keyed by the file's path, NOT the folder's — folder shares don't have a
	// pre-registered debouncer per file (files aren't known at registration
	// time), and re-using the folder-keyed debouncedSyncMap here would resync
	// the folder itself (getAbstractFileByPath on a folder path returns a
	// TFolder, which syncFile() rejects — the rate-limited edit is silently lost).
	private debouncedFolderFileSyncMap: Map<string, () => void> = new Map();

	// Coalesced web_folder_items push state per folder share, keyed by folder path.
	private folderItemsPush: Map<string, FolderItemsPushState> = new Map();

	constructor(
		vault: Vault,
		clientManager: RelayOnPremShareClientManager
	) {
		this.vault = vault;
		this.clientManager = clientManager;
	}

	/**
	 * Register a share for automatic synchronization
	 */
	registerAutoSyncShare(
		filePath: string,
		shareId: string,
		serverId: string,
		kind: "doc" | "folder" = "doc",
		webSlug?: string
	): void {
		log("Registering auto-sync share", { filePath, shareId, kind, webSlug });
		this.autoSyncShares.set(filePath, {
			shareId,
			serverId,
			lastSync: 0,
			kind,
			webSlug,
		});

		const pushState = this.folderItemsPush.get(filePath);
		if (pushState && (kind !== "folder" || pushState.shareId !== shareId)) {
			this.dropFolderItemsPush(filePath);
		}

		// Create debounced sync function for this file/folder
		if (!this.debouncedSyncMap.has(filePath)) {
			this.debouncedSyncMap.set(
				filePath,
				debounce(
					() => this.syncFile(filePath),
					this.syncDebounceMs,
					true
				)
			);
		}
	}

	/**
	 * Unregister a share from automatic synchronization
	 */
	unregisterAutoSyncShare(filePath: string): void {
		log("Unregistering auto-sync share", { filePath });
		this.autoSyncShares.delete(filePath);
		this.debouncedSyncMap.delete(filePath);
		this.dropFolderItemsPush(filePath);
		for (const key of Array.from(this.debouncedFolderFileSyncMap.keys())) {
			if (key === filePath || isPathWithinFolder(key, filePath)) {
				this.debouncedFolderFileSyncMap.delete(key);
			}
		}
	}

	/**
	 * Handle file modification event
	 */
	async onFileModified(file: TFile): Promise<void> {
		// First check for direct doc share match
		let shareInfo = this.autoSyncShares.get(file.path);
		let matchedPath = file.path;

		// If no direct match, check if file is inside a folder share
		if (!shareInfo) {
			for (const [folderPath, info] of this.autoSyncShares.entries()) {
				if (info.kind === "folder" && isPathWithinFolder(file.path, folderPath)) {
					shareInfo = info;
					matchedPath = folderPath;
					log("File is inside auto-sync folder", { filePath: file.path, folderPath });
					break;
				}
			}
		}

		if (!shareInfo) return;

		// For folder shares, non-text files never sync — bail before any
		// rate-limit bookkeeping or debounce scheduling happens for them.
		if (shareInfo.kind === "folder" && !SYNCABLE_FOLDER_FILE_EXTENSIONS.has(file.extension)) {
			log("Skipping non-text file in auto-sync folder (unsupported extension)", {
				path: file.path,
				extension: file.extension,
			});
			return;
		}

		// Rate limiting check
		const now = Date.now();
		if (now - shareInfo.lastSync < this.minSyncIntervalMs) {
			log("Rate limited, scheduling sync", {
				path: file.path,
				timeSinceLastSync: now - shareInfo.lastSync,
			});
			// Schedule sync after rate limit expires. Folder shares debounce the
			// specific FILE that was rate-limited — debouncedSyncMap is
			// keyed by the folder path and drives syncFile(), which expects a
			// TFile at that path and silently no-ops on the folder itself.
			if (shareInfo.kind === "folder") {
				const debouncedSync = this.getOrCreateFolderFileDebounce(file.path, shareInfo);
				debouncedSync();
			} else {
				const debouncedSync = this.debouncedSyncMap.get(matchedPath);
				if (debouncedSync) debouncedSync();
			}
			return;
		}

		log("File modified, triggering sync", { path: file.path, kind: shareInfo.kind });

		// For folder shares, sync just the modified file
		if (shareInfo.kind === "folder") {
			await this.syncFolderFile(file, shareInfo);
		} else {
			const debouncedSync = this.debouncedSyncMap.get(matchedPath);
			if (debouncedSync) debouncedSync();
		}
	}

	/**
	 * Get (or lazily create) the debounced resync for one file inside a folder
	 * share. Re-resolves the TFile by path at fire time rather than closing
	 * over the TFile passed in now, so a debounce created by an earlier edit
	 * still syncs current content if it fires after further edits.
	 */
	private getOrCreateFolderFileDebounce(filePath: string, shareInfo: ShareInfo): () => void {
		let fn = this.debouncedFolderFileSyncMap.get(filePath);
		if (!fn) {
			fn = debounce(
				() => {
					void this.syncFolderFileByPath(filePath, shareInfo);
				},
				this.syncDebounceMs,
				true
			);
			this.debouncedFolderFileSyncMap.set(filePath, fn);
		}
		return fn;
	}

	/**
	 * Resolve filePath to a live TFile and sync it as a folder-share file.
	 * Used by the debounced folder-file retry, where the original TFile
	 * reference may be stale by the time the debounce fires.
	 */
	private async syncFolderFileByPath(filePath: string, shareInfo: ShareInfo): Promise<void> {
		// No rate-limit re-check here (unlike syncFile()'s doc-share equivalent):
		// syncDebounceMs (2s) < minSyncIntervalMs (5s), so a strict re-check would
		// often still be inside the rate-limit window when this fires — and since
		// nothing reschedules after a drop here, that would silently re-lose the
		// exact edit is fixing. This debounce firing IS the delivery
		// mechanism for a rate-limited edit; let it always go out.
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			log("Folder-share file not found or not a TFile at debounced sync time", { filePath });
			return;
		}
		await this.syncFolderFile(file, shareInfo);
	}

	/**
	 * Synchronize a single file within a folder share to web
	 */
	private async syncFolderFile(file: TFile, shareInfo: ShareInfo): Promise<void> {
		if (!shareInfo.webSlug) {
			log("No web_slug for folder share, fetching...", { shareId: shareInfo.shareId });
			// Try to get the slug from the share
			const client = this.clientManager.getClient(shareInfo.serverId);
			if (client) {
				const share = await client.getShare(shareInfo.shareId);
				if (share?.web_slug) {
					shareInfo.webSlug = share.web_slug;
				} else {
					log("Share has no web_slug, skipping sync");
					return;
				}
			}
		}

		this._beginOutboundSync();
		try {
			const content = await this.vault.read(file);

			// Find the relative path within the folder. A root share's folderPath
			// is "" (the wire convention) -- an empty string is falsy in JS, so a
			// bare `if (!folderPath)` would wrongly treat a found-but-root match
			// the same as "no match found" and bail before ever syncing. Check
			// against `undefined` (what `.find()` returns on no match) instead.
			const folderPath = Array.from(this.autoSyncShares.entries())
				.find(([_, info]) => info === shareInfo)?.[0];

			if (folderPath === undefined) {
				log("Could not find folder path for share info");
				return;
			}

			const relativePath = toFolderRelativePath(file.path, folderPath);

			log("Syncing folder file", {
				folderPath,
				relativePath,
				slug: shareInfo.webSlug,
			});

			await this.clientManager.syncFolderFileContent(
				shareInfo.serverId,
				shareInfo.webSlug!,
				relativePath,
				content
			);

			shareInfo.lastSync = Date.now();
			log("Auto-synced folder file to web", {
				filePath: file.path,
				relativePath,
				slug: shareInfo.webSlug,
			});
		} catch (error: unknown) {
			log("Failed to auto-sync folder file", {
				filePath: file.path,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this._endOutboundSync();
		}
	}

	/**
	 * Synchronize a file to web
	 */
	private async syncFile(filePath: string): Promise<void> {
		const shareInfo = this.autoSyncShares.get(filePath);
		if (!shareInfo) {
			log("Share info not found for path", { filePath });
			return;
		}

		// Rate limiting check (in case debounce fired early)
		const now = Date.now();
		if (now - shareInfo.lastSync < this.minSyncIntervalMs) {
			log("Rate limited on sync", {
				filePath,
				timeSinceLastSync: now - shareInfo.lastSync,
			});
			return;
		}

		this._beginOutboundSync();
		try {
			const file = this.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				log("File not found or not a TFile", { filePath });
				return;
			}

			const content = await this.vault.read(file);
			const client = this.clientManager.getClient(shareInfo.serverId);
			if (!client) {
				log("Client not found for server", {
					serverId: shareInfo.serverId,
				});
				return;
			}

			// Get share to find slug
			const share = await client.getShare(shareInfo.shareId);
			if (!share?.web_slug) {
				log("Share not found or missing web_slug", {
					shareId: shareInfo.shareId,
				});
				return;
			}

			// Sync content to web
			await client.updateShare(shareInfo.shareId, {
				web_content: content,
			});
			shareInfo.lastSync = Date.now();

			log("Auto-synced file to web", {
				filePath,
				slug: share.web_slug,
			});
		} catch (error: unknown) {
			log("Failed to auto-sync file", {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this._endOutboundSync();
		}
	}

	/**
	 * Handle file creation — update web_folder_items for affected folder shares
	 */
	onFileCreated(file: TFile): void {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			if (!isPathWithinFolder(file.path, folderPath)) continue;

			// Only md/canvas files appear in web_folder_items.
			if (!SYNCABLE_FOLDER_FILE_EXTENSIONS.has(file.extension)) return;

			log("File created in auto-sync folder, scheduling web_folder_items update", {
				filePath: file.path,
				folderPath,
				shareId: shareInfo.shareId,
			});
			this.scheduleFolderItemsPush(folderPath, shareInfo);
			return;
		}
	}

	/**
	 * Handle file rename — update web_folder_items for affected folder shares
	 */
	onFileRenamed(newPath: string, oldPath: string): void {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			// File moved into, out of, or within this folder
			if (
				!isPathWithinFolder(newPath, folderPath) &&
				!isPathWithinFolder(oldPath, folderPath)
			) continue;

			log("File renamed in auto-sync folder, scheduling web_folder_items update", {
				oldPath,
				newPath,
				folderPath,
				shareId: shareInfo.shareId,
			});
			this.scheduleFolderItemsPush(folderPath, shareInfo);
			// Don't return early — file could affect multiple folder shares (moved between)
		}

		// Doc shares are keyed by the file's own path. A rename leaves
		// the registration under the old key, so onFileModified()'s lookup by
		// the new path always misses — editing the renamed note silently stops
		// syncing, with no error or Notice. Re-key the registration, and the
		// debounce (which closes over the old path), to follow the file.
		const docShareInfo = this.autoSyncShares.get(oldPath);
		if (docShareInfo && docShareInfo.kind === "doc") {
			log("Doc share renamed, re-keying auto-sync registration", {
				oldPath,
				newPath,
				shareId: docShareInfo.shareId,
			});
			this.autoSyncShares.delete(oldPath);
			this.autoSyncShares.set(newPath, docShareInfo);
			this.debouncedSyncMap.delete(oldPath);
			this.debouncedSyncMap.set(
				newPath,
				debounce(() => this.syncFile(newPath), this.syncDebounceMs, true)
			);
		}
	}

	/**
	 * Handle file deletion — update web_folder_items for affected folder shares
	 */
	onFileDeleted(filePath: string): void {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			if (!isPathWithinFolder(filePath, folderPath)) continue;

			log("File deleted from auto-sync folder, scheduling web_folder_items update", {
				filePath,
				folderPath,
				shareId: shareInfo.shareId,
			});
			this.scheduleFolderItemsPush(folderPath, shareInfo);
			return;
		}

		// Doc shares are keyed by their own path. Once the file is
		// gone, syncFile() would keep silently no-op'ing ("File not found")
		// forever on a lingering registration. Unregister it, and tell the
		// user the web share is still published even though the note is gone.
		const docShareInfo = this.autoSyncShares.get(filePath);
		if (docShareInfo && docShareInfo.kind === "doc") {
			log("Doc share file deleted, unregistering auto-sync", {
				filePath,
				shareId: docShareInfo.shareId,
			});
			this.unregisterAutoSyncShare(filePath);
			const { serverId, shareId } = docShareInfo;
			const fragment = createFragment((el: DocumentFragment) => {
				el.createSpan({
					text: `Team Relay: "${filePath}" was deleted, but its web share is ` +
						`still published. `,
				});
				const unpublishBtn = el.createEl("button", {
					text: "Unpublish",
					cls: "mod-warning",
				});
				unpublishBtn.onclick = (evt: MouseEvent) => {
					evt.stopPropagation();
					void this._unpublishAfterDelete(serverId, shareId, filePath, notice);
				};
			});
			const notice = new Notice(fragment, 8000);
		}
	}

	/** "Unpublish" button handler for the post-delete Notice above. */
	private async _unpublishAfterDelete(
		serverId: string,
		shareId: string,
		filePath: string,
		notice: Notice,
	): Promise<void> {
		try {
			await this.clientManager.updateShare(serverId, shareId, { web_published: false });
			notice.hide();
			new Notice(`Team Relay: web share for "${filePath}" unpublished.`);
		} catch (error: unknown) {
			log("Failed to unpublish share after file deletion", {
				filePath,
				shareId,
				error: error instanceof Error ? error.message : String(error),
			});
			new Notice(
				`Team Relay: failed to unpublish "${filePath}" — ` +
					`${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
	}

	/**
	 * Scan folder for current items (md/canvas files and subfolders)
	 */
	private getFolderItems(folderPath: string): WebFolderEntry[] {
		const folder = resolveShareFolder(this.vault, folderPath);
		if (!folder) return [];
		return collectWebFolderItems(folder, folderPath);
	}

	/**
	 * Mark a folder share's web_folder_items as changed and (re)arm its push
	 * timer. The push itself happens in flushFolderItemsPush().
	 */
	private scheduleFolderItemsPush(folderPath: string, shareInfo: ShareInfo): void {
		const state = this.getFolderItemsPushState(folderPath, shareInfo.shareId);
		state.dirty = true;
		if (state.firstPendingAt === null) state.firstPendingAt = Date.now();
		// An in-flight push re-arms the timer when it settles.
		if (state.inFlight !== null) return;
		this.armFolderItemsTimer(folderPath, state);
	}

	private getFolderItemsPushState(folderPath: string, shareId: string): FolderItemsPushState {
		let state = this.folderItemsPush.get(folderPath);
		if (state && state.shareId !== shareId) {
			this.dropFolderItemsPush(folderPath);
			state = undefined;
		}
		if (!state) {
			state = {
				shareId,
				timer: null,
				firstPendingAt: null,
				inFlight: null,
				dirty: false,
				lastSentFingerprint: null,
				notBefore: 0,
				failures: 0,
			};
			this.folderItemsPush.set(folderPath, state);
		}
		return state;
	}

	/**
	 * Run one web_folder_items PATCH as this share's single in-flight request,
	 * recording the accepted list on success. Callers must check
	 * state.inFlight first.
	 */
	private async sendFolderItems(
		state: FolderItemsPushState,
		serverId: string,
		items: WebFolderEntry[],
		fingerprint: string,
	): Promise<void> {
		const request = this.clientManager.updateShare(serverId, state.shareId, {
			web_folder_items: items,
		});
		state.inFlight = request.then(
			() => undefined,
			() => undefined,
		);
		try {
			await request;
			state.lastSentFingerprint = fingerprint;
			state.failures = 0;
		} finally {
			state.inFlight = null;
		}
	}

	private armFolderItemsTimer(folderPath: string, state: FolderItemsPushState): void {
		const now = Date.now();
		const trailing = Math.min(
			now + FOLDER_ITEMS_DEBOUNCE_MS,
			(state.firstPendingAt ?? now) + FOLDER_ITEMS_MAX_WAIT_MS,
		);
		const fireAt = Math.max(trailing, state.notBefore);
		if (state.timer !== null) window.clearTimeout(state.timer);
		state.timer = window.setTimeout(() => {
			state.timer = null;
			void this.flushFolderItemsPush(folderPath, state);
		}, Math.max(0, fireAt - now));
	}

	private async flushFolderItemsPush(folderPath: string, state: FolderItemsPushState): Promise<void> {
		// Unregistered (or re-registered as another share) since scheduling.
		if (this.folderItemsPush.get(folderPath) !== state) return;
		const shareInfo = this.autoSyncShares.get(folderPath);
		if (!shareInfo || shareInfo.kind !== "folder") return;
		if (state.inFlight !== null || !state.dirty) return;

		const items = this.getFolderItems(folderPath);
		const fingerprint = JSON.stringify(items);
		state.dirty = false;
		state.firstPendingAt = null;
		if (fingerprint === state.lastSentFingerprint) {
			log("web_folder_items unchanged since last push, skipping", { folderPath });
			return;
		}

		try {
			await this.sendFolderItems(state, shareInfo.serverId, items, fingerprint);
			log("Updated web_folder_items", { folderPath, itemCount: items.length });
		} catch (error: unknown) {
			if (isTransientRelayFailure(error)) {
				state.failures++;
				const retryAfterMs = error instanceof RelayHttpError ? error.retryAfterMs : undefined;
				// A server-sent Retry-After is honoured as is; the cap only
				// bounds our own exponential fallback.
				const delay = retryAfterMs ?? Math.min(
					FOLDER_ITEMS_BACKOFF_BASE_MS * 2 ** (state.failures - 1),
					FOLDER_ITEMS_BACKOFF_MAX_MS,
				);
				state.notBefore = Date.now() + delay;
				state.dirty = true;
				if (state.firstPendingAt === null) state.firstPendingAt = Date.now();
				log("Transient failure updating web_folder_items, backing off", {
					folderPath,
					delayMs: delay,
					error: error instanceof Error ? error.message : String(error),
				});
			} else {
				// Not retried; the next change in the folder pushes again.
				log("Failed to update web_folder_items", {
					folderPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (state.dirty && this.folderItemsPush.get(folderPath) === state) {
				this.armFolderItemsTimer(folderPath, state);
			}
		}
	}

	private dropFolderItemsPush(folderPath: string): void {
		const state = this.folderItemsPush.get(folderPath);
		if (!state) return;
		if (state.timer !== null) window.clearTimeout(state.timer);
		this.folderItemsPush.delete(folderPath);
	}

	/**
	 * Sync folder structure (web_folder_items) to web for a specific share.
	 * Called from context menu "Sync" to ensure deleted files are reflected on web-publish.
	 */
	async syncFolderStructureToWeb(
		folderPath: string,
		serverId: string,
		shareId: string,
	): Promise<void> {
		// Shares the scheduler's state so a manual sync never overlaps an
		// event-driven PATCH and later unchanged events see what it sent.
		const state = this.getFolderItemsPushState(folderPath, shareId);
		while (state.inFlight !== null) await state.inFlight;
		const items = this.getFolderItems(folderPath);
		try {
			await this.sendFolderItems(state, serverId, items, JSON.stringify(items));
		} finally {
			if (state.dirty && this.folderItemsPush.get(folderPath) === state) {
				this.armFolderItemsTimer(folderPath, state);
			}
		}
		log("Synced folder structure to web", { folderPath, itemCount: items.length });
	}

	/**
	 * Get all registered auto-sync paths
	 */
	getAutoSyncPaths(): string[] {
		return Array.from(this.autoSyncShares.keys());
	}

	/**
	 * Check if a path is registered for auto-sync
	 */
	isAutoSync(filePath: string): boolean {
		return this.autoSyncShares.has(filePath);
	}

	/**
	 * Clean up resources
	 */
	destroy(): void {
		log("Destroying WebSyncManager");
		this.autoSyncShares.clear();
		this.debouncedSyncMap.clear();
		for (const folderPath of Array.from(this.folderItemsPush.keys())) {
			this.dropFolderItemsPush(folderPath);
		}
		this.debouncedFolderFileSyncMap.clear();
	}
}

/**
 * Run an outbound content push under the WebSyncManager echo-guard if one is
 * available, else just run it. Callers — main.ts's
 * manual/full-sync commands, ShareManagementModal.ts, ShareDetailView.svelte —
 * may run before webSyncManager is initialized (or in a context that never
 * constructs one), so this degrades gracefully rather than throwing.
 */
export async function withOutboundSyncGuard<T>(
	webSyncManager: WebSyncManager | undefined,
	fn: () => Promise<T>
): Promise<T> {
	if (webSyncManager) {
		return webSyncManager.runOutboundSync(fn);
	}
	return fn();
}
