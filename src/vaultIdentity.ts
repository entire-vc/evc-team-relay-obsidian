"use strict";

/**
 * Vault identity sent with create-share requests so one owner can hold a
 * whole-vault share per vault (GH #265). `vault_id` is Obsidian's stable
 * per-vault `app.appId`; `vault_name` is the human label shown in share lists.
 * Servers predating the field ignore both.
 */
export interface VaultIdentity {
	vault_id: string;
	vault_name: string;
}

export function buildVaultIdentity(appId: string, vaultName: string): Partial<VaultIdentity> {
	if (!appId) return {};
	return { vault_id: appId, ...(vaultName && { vault_name: vaultName }) };
}
