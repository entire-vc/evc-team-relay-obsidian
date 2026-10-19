"use strict";
import * as Y from "yjs";
import { sep, dirname } from "path-browserify";
import { v4 as uuidv4 } from "uuid";
import { Notifier } from "./notifiers/Notifier";
import { withToggle } from "./featureToggleState";
import { featureKey } from "./featureToggles";
import {
	ItemKind,
	KindRegistry,
	isDocumentRecord,
	isFolderRecord,
	makeDocumentRecord,
	makeFolderRecord,
	type ItemRecord,
} from "./ItemKinds";
import type { AttachmentSyncSettings } from "./AttachmentSyncSettings";

/**
 * True when two pieces of file/folder metadata describe the same underlying
 * object (same id/mimetype/type/hash). Used to skip no-op writes into the
 * shared Y.Map so we don't generate CRDT churn for a value that isn't
 * actually changing.
 */
function sameMeta(a: ItemRecord | undefined, b: ItemRecord): boolean {
	return (
		!!a &&
		a.id === b.id &&
		a.mimetype == b.mimetype &&
		a.type === b.type &&
		a.hash === b.hash
	);
}

/**
 * FolderIndex is the per-shared-folder index of "what path maps to what
 * document/folder id". It layers three things on top of a Yjs-backed
 * filename->metadata map:
 *
 *  - `mintedGuids`: guids minted locally for files that haven't finished
 *    their first sync round-trip yet (so local operations can reference
 *    them before the relay has confirmed anything).
 *  - `stagedWrites`/`stagedDeletes`: a local staging area for changes computed during
 *    a single file-tree diff pass, flushed into the Y.Map by `applyStaged()`.
 *  - `flatIdMap`: an older, flatter path->guid map that pre-relay clients
 *    still read/write; `upgradeLegacy()` reconciles it into the richer
 *    `filemeta_v0` map (and infers folder metadata that legacy clients never
 *    wrote at all).
 */
export class FolderIndex extends Notifier<FolderIndex> {
	/** Legacy (pre filemeta_v0) path -> document guid map, Y-backed. */
	private flatIdMap: Y.Map<string>;
	/** Canonical path -> metadata map, Y-backed. */
	private records: Y.Map<ItemRecord>;
	/** Staged writes not yet flushed into `records` (see applyStaged()). */
	stagedWrites: Map<string, ItemRecord>;
	/** Staged deletions not yet flushed into `records` (see applyStaged()). */
	stagedDeletes: Set<string>;
	kinds: KindRegistry;
	/** In-flight renames: old vpath -> new vpath, cleared by clearAlias/clearAliases. */
	aliases: Map<string, string>;

	constructor(
		public crdt: Y.Doc,
		private scopePath: string,
		public mintedGuids: Map<string, string>,
		private attachmentSettings: AttachmentSyncSettings,
	) {
		super();
		this.flatIdMap = this.crdt.getMap("docs");
		this.records = this.crdt.getMap("filemeta_v0");
		this.stagedWrites = new Map();
		this.aliases = new Map();
		this.stagedDeletes = new Set();
		this.kinds = new KindRegistry(this.attachmentSettings);
	}

	/** Guards that `path` is relative to this store's scopePath, not an absolute vault path. */
	requireVirtualPath(path: string): void {
		if (path.startsWith(this.scopePath + sep)) {
			throw new Error("not a valid virtual path: " + path);
		}
	}

	dump(): void {
		const files = Array.from(this.records.entries()).map(([path, meta]) => ({
			path,
			...meta,
		}));
		const pending = Array.from(this.mintedGuids.entries()).map(
			([path, guid]) => ({ path, guid }),
		);
		this.log("files", files);
		this.log("pending...", pending);
	}

	isSyncable(vpath: string): boolean {
		return this.kinds.supportsSync(vpath, this.recordFor(vpath));
	}

	/**
	 * Called once a filesystem rename event confirms an in-flight move
	 * actually landed. Moves are async, so the alias stays live in
	 * `renames` from `move()` until this fires.
	 */
	clearAlias(oldVPath: string): void {
		this.log("looking up alias for", oldVPath);
		this.aliases.delete(oldVPath);
	}

	clearAliases(): void {
		this.aliases.clear();
	}

	/** Redirects every place a path can be tracked (aliases/uploads/deletes/stagedWrites/records) from oldVPath to newVPath. */
	repath(oldVPath: string, newVPath: string): void {
		this.log("file move", oldVPath, "->", newVPath);
		this.requireVirtualPath(oldVPath);
		this.requireVirtualPath(newVPath);
		this.aliases.set(oldVPath, newVPath);
		this.relocateMapKey(this.mintedGuids, oldVPath, newVPath);
		this.relocateSetKey(this.stagedDeletes, oldVPath, newVPath);
		this.relocateMapKey(this.stagedWrites, oldVPath, newVPath);

		const existing = this.records.get(oldVPath);
		if (isFolderRecord(existing)) {
			this.repathFolder(oldVPath, newVPath);
		} else if (existing) {
			this.put(newVPath, existing);
			this.delete(oldVPath);
		}
	}

	private relocateMapKey<V>(map: Map<string, V>, from: string, to: string): void {
		if (!map.has(from)) return;
		map.set(to, map.get(from) as V);
		map.delete(from);
	}

	private relocateSetKey(set: Set<string>, from: string, to: string): void {
		if (!set.has(from)) return;
		set.delete(from);
		set.add(to);
	}

	new(vpath: string): string {
		this.requireVirtualPath(vpath);
		const guid = uuidv4();
		this.mintedGuids.set(vpath, guid);
		return guid;
	}

	/**
	 * Discard a locally-minted-but-never-published guid for `vpath` (-
	 * follow-up): `guidFor` checks `mintedGuids` BEFORE the synced
	 * `records`/`flatIdMap` maps, so a mintedGuids entry left behind after
	 * losing the upload-claim race for this vpath would permanently shadow
	 * the winner's guid once it syncs in. Deliberately narrower than
	 * `delete()` — this must NOT touch `records`/`flatIdMap`, which may already
	 * hold (or be about to receive) the winner's entry.
	 */
	clearPendingUpload(vpath: string): void {
		this.requireVirtualPath(vpath);
		this.mintedGuids.delete(vpath);
	}

	/**
	 * Ensure a file has a Y.Map metadata entry (filemeta_v0 + flatIdMap).
	 * Called from adoptLocalFiles() to write metadata that noteUploaded() would
	 * normally write after background sync completes. This ensures the relay
	 * has file metadata even if individual document syncs haven't finished.
	 */
	ensureMeta(vpath: string, meta: ItemRecord): boolean {
		this.requireVirtualPath(vpath);
		if (this.records.has(vpath)) {
			return false; // already in Y.Map
		}
		this.put(vpath, meta);
		return true;
	}

	/**
	 * Check if a path has an entry in the Y.Map (filemeta_v0),
	 * as opposed to just being in mintedGuids or stagedWrites.
	 */
	hasYMapEntry(vpath: string): boolean {
		return this.records.has(vpath);
	}

	eachRecord(callbackFn: (meta: ItemRecord, path: string) => void): void {
		for (const [path, meta] of this.records.entries()) {
			if (!this.stagedDeletes.has(path)) callbackFn(meta, path);
		}
		for (const [path, meta] of this.stagedWrites.entries()) {
			if (!this.stagedDeletes.has(path)) callbackFn(meta, path);
		}
	}

	tracks(path: string): boolean {
		const resolved = this.aliases.get(path) ?? path;
		if (this.stagedDeletes.has(resolved)) return false;
		return (
			this.records.has(resolved) ||
			this.flatIdMap.has(resolved) ||
			this.stagedWrites.has(resolved) ||
			this.mintedGuids.has(resolved)
		);
	}

	wouldChange(vpath: string, meta: ItemRecord): boolean {
		this.requireVirtualPath(vpath);
		if (isDocumentRecord(meta) && this.flatIdMap.get(vpath) !== meta.id) {
			this.log(
				"vpath already tracked under a different legacy ID",
				this.flatIdMap.get(vpath),
				meta.id,
			);
			return true;
		}
		const existing = this.records.get(vpath);
		if (sameMeta(existing, meta)) {
			return false;
		}
		this.log("meta changed", existing, meta);
		return true;
	}

	put(vpath: string, meta: ItemRecord): void {
		this.requireVirtualPath(vpath);
		if (isDocumentRecord(meta) && this.flatIdMap.get(vpath) !== meta.id) {
			this.flatIdMap.set(vpath, meta.id);
		}
		const existing = this.records.get(vpath);
		if (sameMeta(existing, meta)) {
			return;
		}
		this.log("writing metadata", vpath, existing, meta);
		this.records.set(vpath, meta);
		this.mintedGuids.delete(vpath);
	}

	/**
	 * Detects a folder rename from a paired delete+add in the same Y.Map
	 * transaction (a "new-client" rename, as opposed to the flatIdMap-driven
	 * detection in findFolderRenames()) and queues an alias for every child
	 * path under that folder.
	 */
	applyRemoteChange(event: Y.YMapEvent<ItemRecord>): void {
		const removedFolderIds = new Map<string, string>();
		const addedFolderIds = new Map<string, string>();

		event.changes.keys.forEach((change, path) => {
			if (change.action === "delete") {
				const oldMeta = change.oldValue as ItemRecord;
				if (oldMeta?.type === ItemKind.Folder) {
					removedFolderIds.set(oldMeta.id, path);
				}
			} else {
				const currentMeta = this.records.get(path);
				if (currentMeta?.type === ItemKind.Folder) {
					addedFolderIds.set(currentMeta.id, path);
				}
			}
		});

		for (const [folderId, oldFolderPath] of removedFolderIds) {
			const newFolderPath = addedFolderIds.get(folderId);
			if (!newFolderPath || newFolderPath === oldFolderPath) continue;

			this.log(`Detected folder move from ${oldFolderPath} to ${newFolderPath}`);
			this.aliases.set(oldFolderPath, newFolderPath);
			this.log("recording alias", oldFolderPath, newFolderPath);

			const childPrefix = newFolderPath + sep;
			for (const path of this.records.keys()) {
				if (!path.startsWith(childPrefix)) continue;
				const oldChildPath = oldFolderPath + path.slice(newFolderPath.length);
				this.aliases.set(oldChildPath, path);
				this.log("setting alias", oldChildPath, path);
			}
		}
	}

	observe(): void {
		withToggle(featureKey.enableDeltaLogging, () => this.attachDeltaLoggers());

		const syncFileObserver = (event: Y.YMapEvent<ItemRecord>) => {
			if (event.changes.keys.size === 0) {
				this.log("nothing changed, skipping");
				return;
			}
			if (event.transaction.origin === this) return;
			this.applyRemoteChange(event);
			this.notifySubscribers();
		};
		const legacyListener = () => {
			this.upgradeLegacy();
			this.notifySubscribers();
		};

		this.flatIdMap.observe(legacyListener);
		this.records.observe(syncFileObserver);
		this.unsubscribes.push(() => this.flatIdMap.unobserve(legacyListener));
		this.unsubscribes.push(() => this.records.unobserve(syncFileObserver));
		this.unsubscribes.push(
			this.kinds.subscribe(() => {
				this.log("type registry updated");
				this.notifySubscribers();
			}),
		);
	}

	/** Renders a Y.Map change event into a human-readable delta for `this.debug()`. */
	private describeDelta<T>(event: Y.YMapEvent<T>): string {
		const origin = event.transaction.origin as
			| { constructor?: { name?: string } }
			| null
			| undefined;
		let out = `Transaction origin: ${String(event.transaction.origin)}${origin?.constructor?.name ?? ""}\n`;
		event.changes.keys.forEach((change, key) => {
			if (change.action === "add") out += `Added ${key}: ${this.guidFor(key)}\n`;
			if (change.action === "update") out += `Updated ${key}: ${this.guidFor(key)}\n`;
			if (change.action === "delete") out += `Deleted ${key}\n`;
		});
		return out;
	}

	/** Debug-only mirrors of every Y.Map write to `this.debug()`, gated behind `enableDeltaLogging`. */
	private attachDeltaLoggers(): void {
		const legacyObserver = (event: Y.YMapEvent<string>) => this.debug(this.describeDelta(event));
		const metaObserver = (event: Y.YMapEvent<ItemRecord>) => this.debug(this.describeDelta(event));
		this.flatIdMap.observe(legacyObserver);
		this.records.observe(metaObserver);
		this.unsubscribes.push(() => this.flatIdMap.unobserve(legacyObserver));
		this.unsubscribes.push(() => this.records.unobserve(metaObserver));
	}

	guidFor(vpath: string): string | undefined {
		this.requireVirtualPath(vpath);
		const resolved = this.aliases.get(vpath) ?? vpath;
		if (this.stagedDeletes.has(resolved)) return undefined;

		const pending = this.mintedGuids.get(resolved);
		if (pending) return pending;

		return this.recordFor(resolved)?.id;
	}

	recordFor(vpath: string): ItemRecord | undefined {
		this.requireVirtualPath(vpath);
		const resolved = this.aliases.get(vpath) ?? vpath;
		if (this.stagedDeletes.has(resolved)) return undefined;

		const existing = this.records.get(resolved) ?? this.stagedWrites.get(resolved);
		if (existing) {
			// Legacy migration: if filemeta_v0 has an entry but "docs" map doesn't,
			// auto-populate the legacy map instead of deleting the entry.
			// Previously this deleted the entry, breaking externally-created files
			// (e.g. via REST API) that only write to filemeta_v0.
			if (isDocumentRecord(existing) && !this.flatIdMap.has(resolved)) {
				this.flatIdMap.set(resolved, existing.id);
			}
			return existing;
		}

		const legacyGuid = this.flatIdMap.get(resolved);
		if (legacyGuid !== undefined) {
			const inferred = makeDocumentRecord(legacyGuid);
			this.stagedWrites.set(resolved, inferred);
			return inferred;
		}

		return undefined;
	}

	delete(vpath: string) {
		this.requireVirtualPath(vpath);
		this.flatIdMap.delete(vpath);
		this.mintedGuids.delete(vpath);
		this.stagedWrites.delete(vpath);
		this.stagedDeletes.delete(vpath);
		return this.records.delete(vpath);
	}

	/** Remove a complete tree, including legacy-only and not-yet-published paths. */
	deleteTree(vpath: string): void {
		this.requireVirtualPath(vpath);
		const inTree = (path: string) => path === vpath || path.startsWith(vpath + sep);
		const paths = new Set([
			...this.records.keys(),
			...this.flatIdMap.keys(),
			...this.mintedGuids.keys(),
			...this.stagedWrites.keys(),
			...this.stagedDeletes,
		]);
		for (const path of paths) {
			if (inTree(path)) this.delete(path);
		}
		for (const [from, to] of this.aliases) {
			if (inTree(from) || inTree(to)) this.aliases.delete(from);
		}
	}

	public get knownGuids(): Set<string> {
		const ids = new Set<string>();
		this.eachRecord((meta) => ids.add(meta.id));
		return ids;
	}

	applyStaged(): void {
		if (this.stagedWrites.size > 0) {
			this.log("flushing staged entries", [...this.stagedWrites.keys()]);
			for (const [path, meta] of this.stagedWrites) {
				this.put(path, meta);
				if (meta.type === ItemKind.Document && this.flatIdMap.get(path) !== meta.id) {
					this.flatIdMap.set(path, meta.id);
				}
			}
			this.stagedWrites = new Map();
		}

		if (this.stagedDeletes.size > 0) {
			this.log("flushing pending deletes", [...this.stagedDeletes]);
			for (const path of this.stagedDeletes) this.delete(path);
			this.stagedDeletes = new Set<string>();
		}
	}

	/**
	 * Legacy-driven folder-move detection: a legacy client only rewrites the
	 * leaf document entry in `flatIdMap`, never a folder entry, so a folder
	 * rename shows up only as "same guid, different directory". This walks
	 * every legacy entry, finds one whose directory changed relative to the
	 * canonical `records` map, and queues a repathFolder() for the deepest
	 * affected directories first (so a nested rename doesn't get partially
	 * clobbered by its parent's move).
	 */
	private findFolderRenames(): void {
		const renamedDirectories = new Map<string, string>();

		for (const [newPath, guid] of this.flatIdMap) {
			let previousPath: string | undefined;
			for (const [path, meta] of this.records) {
				if (meta.type === ItemKind.Document && meta.id === guid && path !== newPath) {
					previousPath = path;
				}
			}
			if (!previousPath) continue;

			const previousDir = dirname(previousPath);
			const currentDir = dirname(newPath);
			if (previousDir !== currentDir) {
				renamedDirectories.set(previousDir, currentDir);
			}
		}

		const handled = new Set<string>();
		const byDepth = [...renamedDirectories.entries()].sort(
			([a], [b]) => b.length - a.length,
		);
		for (const [oldFolder, newFolder] of byDepth) {
			if (handled.has(oldFolder)) continue;
			this.repathFolder(oldFolder, newFolder);
			handled.add(oldFolder);
		}
	}

	private repathFolder(oldFolder: string, newFolder: string): void {
		this.log("folder move", oldFolder, "->", newFolder);

		const childPrefix = oldFolder + sep;
		const isUnderFolder = (path: string) => path === oldFolder || path.startsWith(childPrefix);

		const affected = new Map<string, ItemRecord>();
		for (const [path, meta] of this.records) {
			if (isUnderFolder(path)) affected.set(path, meta);
		}
		for (const [path, meta] of this.stagedWrites) {
			if (isUnderFolder(path)) affected.set(path, meta);
		}

		const folderMeta = this.records.get(oldFolder);
		if (folderMeta) {
			this.records.set(newFolder, folderMeta);
			this.records.delete(oldFolder);
		}

		for (const oldPath of affected.keys()) {
			if (oldPath === oldFolder) continue; // handled above
			const newPath = newFolder + oldPath.slice(oldFolder.length);
			this.repath(oldPath, newPath);
		}
	}

	recordUpload(vpath: string, meta: ItemRecord): void {
		if (!this.tracks(vpath)) {
			// File may have been renamed, moved, or synced from another peer.
			// Warn and add gracefully instead of crashing the plugin.
			this.warn(`unexpected vpath ${vpath} marked uploaded, adding to store`);
		}
		this.put(vpath, meta);
	}

	/**
	 * Reconcile one `flatIdMap` entry into the canonical `records`/`stagedWrites`
	 * maps, inventing folder metadata for any ancestor directory a legacy
	 * client never wrote.
	 */
	upgradeEntry(guid: string, vpath: string): void {
		try {
			this.requireVirtualPath(vpath);
		} catch {
			// Path from inbound sync may not be a valid virtual path (e.g. full OS path
			// or a path outside this shared folder's scope). Skip gracefully so one
			// bad entry doesn't abort the entire flatIdMap migration and wedge the plugin.
			this.warn(`upgradeEntry: skipping invalid vpath "${vpath}"`);
			return;
		}

		if (this.records.get(vpath)?.id === guid) return;

		const knownEntry = (p: string) => this.records.has(p) || this.stagedWrites.has(p);

		if (!knownEntry(vpath) && vpath.endsWith(".md")) {
			this.warn(`rewrote legacy meta key for ${vpath}`);
			this.stagedWrites.set(vpath, makeDocumentRecord(guid));
		}

		const parts = vpath.split(sep).slice(0, -1);
		let ancestor = "";
		for (const part of parts) {
			ancestor = ancestor ? ancestor + sep + part : part;
			if (ancestor && !knownEntry(ancestor)) {
				const folderGuid = uuidv4();
				console.debug("creating folder path", ancestor, folderGuid);
				this.stagedWrites.set(ancestor, makeFolderRecord(folderGuid));
			}
		}
	}

	upgradeLegacy(): void {
		this.findFolderRenames();
		for (const [vpath, guid] of this.flatIdMap) {
			this.upgradeEntry(guid, vpath);
		}
	}

	destroy(): void {
		super.destroy();
		this.stagedWrites.clear();
		this.stagedDeletes.clear();
		this.aliases.clear();
		this.flatIdMap = null as unknown as Y.Map<string>;
		this.records = null as unknown as Y.Map<ItemRecord>;
	}
}
