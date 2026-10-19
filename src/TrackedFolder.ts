"use strict";
import { VaultShare } from "./VaultShare";
import { Loggable } from "./logging";
import { type Vault, type TAbstractFile, TFolder } from "obsidian";
import type { Unsubscriber } from "./notifiers/Notifier";

import { uuidv4 } from "lib0/random";
import type { SyncableEntry } from "./SyncableEntry";

export function isTrackedFolder(folder: SyncableEntry): folder is TrackedFolder {
	return folder instanceof TrackedFolder;
}

function folderName(path: string): string {
	return path.split("/").pop() || "";
}

/**
 * Vault-side mirror of a shared (or soon-to-be-shared) folder. Attaches to an
 * existing TFolder if one is already there, otherwise creates it — and if
 * creation races with something else creating the same path, falls back to
 * attaching to whatever landed there.
 */
export class TrackedFolder extends Loggable implements SyncableEntry {
	private _parent: VaultShare;
	private _node: TFolder | null = null;
	private tornDown = false;
	folderLabel: string;
	lastSyncAt = 0;
	vaultApi: Vault;
	attached = false;
	creation: Promise<TFolder> | null = null;
	linked = true;
	offStatus: Unsubscriber;

	constructor(
		public entryPath: string,
		public entityGuid: string,
		parent: VaultShare,
	) {
		super();
		this._parent = parent;
		this.folderLabel = folderName(entryPath);
		this.vaultApi = parent.vaultApi;
		this.setLoggers(`[TrackedFolder](${this.entryPath})`);

		if (!this.attachExisting()) {
			this.createIfNeeded(parent);
		}

		this.offStatus = parent.subscribe(this.entryPath, (state) => {
			if (state.intent === "disconnected") {
				this.goOffline();
			}
		});

		void (async () => {
			try {
				if (this.creation) await this.creation;
			} catch (error: unknown) {
				if (!this.tornDown) this.warn("folder creation failed", error);
				return;
			}
			if (!this.tornDown) void parent.noteUploaded(this);
		})();
		this.log("created");
	}

	/** Resolves whatever vault node currently sits at this TrackedFolder's path, if any. */
	private findInVault(): TAbstractFile | null {
		return this.vaultApi.getAbstractFileByPath(this.vaultShare.absolutePath(this.entryPath));
	}

	/**
	 * Looks for an already-existing TFolder at this path; if found, marks
	 * this TrackedFolder attached and returns true.
	 */
	private attachExisting(): boolean {
		const node = this.findInVault();
		if (!(node instanceof TFolder)) {
			return false;
		}
		this._node = node;
		this.attached = true;
		return true;
	}

	private createIfNeeded(parent: VaultShare): void {
		if (parent.isDeletePending(this.entryPath)) {
			this.warn("skipping folder creation for pending delete", this.entryPath);
			return;
		}
		this.creation = parent.createFolderForEntry(this);
		this.creation
			.then((vaultFolder) => {
				if (this.tornDown) return;
				this._node = vaultFolder;
				this.attached = true;
			})
			.catch(() => {
				if (this.tornDown) return;
				// lost the race to create it — someone else already made this folder
				this.attachExisting();
			});
	}

	static forVaultFolder(vaultShare: VaultShare, vaultFolder: TFolder) {
		const virtualPath = vaultShare.toVirtualPath(vaultFolder.path);
		console.debug("resolved virtual path for new TrackedFolder", virtualPath);
		return new TrackedFolder(virtualPath, uuidv4(), vaultShare);
	}

	goOffline() {
		this.linked = false;
	}

	relocate(newPath: string, vaultShare: VaultShare) {
		if (newPath === this.entryPath) {
			return;
		}
		this._parent = vaultShare;
		this.log("setting new path", newPath);
		this.entryPath = newPath;
		this.folderLabel = folderName(newPath);
		this.setLoggers(`[VaultShare](${this.entryPath})`);
	}

	public get vaultFolder(): TFolder {
		const node = this.findInVault();
		if (node instanceof TFolder) {
			return node;
		}
		throw new Error(`TrackedFolder: no vault folder yet at "${this.entryPath}"`);
	}

	public get parentFolder(): TFolder | null {
		return this.vaultFolder?.parent ?? null;
	}

	public get vaultShare(): VaultShare {
		return this._parent;
	}

	async bringOnline(): Promise<boolean> {
		if (!this.vaultShare.wantsConnection) {
			return false;
		}
		await this.vaultShare.bringOnline();
		this.linked = true;
		return this.linked;
	}

	public async delete(): Promise<void> {
		if (this._node) {
			await this.vaultShare.trashFile(this._node);
		}
	}

	public dispose() {}

	dismantle() {
		this.tornDown = true;
		this.offStatus?.();
		this.offStatus = null as unknown as Unsubscriber;
		this._parent = null as unknown as VaultShare;
		this._node = null;
	}
}
