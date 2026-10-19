import type { VaultShare } from "./VaultShare";

/** Minimal surface every syncable vault entry (file, folder, canvas) must expose. */
export interface SyncableEntry {
	/** Vault-relative path of this entry, as its VaultShare addresses it. */
	entryPath: string;
	entityGuid: string;
	goOffline(): void;
	bringOnline(): Promise<boolean> | void;
	dismantle(): void;
	dispose(): Promise<void> | void;
	relocate(newPath: string, vaultShare: VaultShare): void;
}

export interface MimeTyped {
	mimeType: string;
}
