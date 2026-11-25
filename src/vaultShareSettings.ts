import { AttachmentSyncSettings } from "./AttachmentSyncSettings";
import { ResourceAddress } from "./ResourceAddress";
import { SettingsScope, type Settings } from "./SettingsPersistence";
import type { VaultShareSettings } from "./VaultShare";

/**
 * The literal string a JS `undefined` guid becomes once it is interpolated
 * into the `sharedFolders/[guid=${guid}]` settings path. SettingsScope's
 * array-item writer stamps the path's match value onto the entry it creates,
 * so this string -- not a missing field -- is what lands in data.json (GH #116).
 */
export const UNDEFINED_GUID_LITERAL = "undefined";

/**
 * A share guid is usable only if it is a real UUID. `undefined`, `""` and the
 * literal string "undefined" all fail here; a looser "non-empty string" check
 * would let the last one through.
 */
export function isValidShareGuid(guid: unknown): guid is string {
	return typeof guid === "string" && ResourceAddress.isValidUUID(guid);
}

/**
 * Binds a folder's settings slice by its guid and writes the folder's base
 * record into `sharedFolders`. The guid is checked first: an invalid one would
 * be template-coerced into the settings path, SettingsScope would fail to
 * match any existing entry and would append a `{guid: "undefined", path}`
 * record next to the real one (GH #116). Throws instead of writing.
 */
export function bindVaultShareSettings(
	settingsRoot: Settings<unknown>,
	path: string,
	guid: string,
	workspaceId?: string,
	// The attach check (GH #114) is pending: written in this same mutate so
	// a restart before the user decides restores the folder held again.
	attachPending = false,
): SettingsScope<VaultShareSettings> {
	if (!isValidShareGuid(guid)) {
		throw new Error(`Refusing to save shared folder ${path}: it has no valid share id`);
	}
	const folderSettings = new SettingsScope<VaultShareSettings>(
		settingsRoot,
		`sharedFolders/[guid=${guid}]`,
	);
	void folderSettings.mutateValue((current) => {
		return {
			...current,
			path,
			guid,
			...(workspaceId ? { relay: workspaceId } : {}),
			...{
				sync: current.sync ? current.sync : AttachmentSyncSettings.defaultCategoryFlags,
			},
			...(attachPending ? { attachReview: "pending" as const } : {}),
		};
	}, true);
	return folderSettings;
}

/**
 * Drops `sharedFolders` records whose guid is the literal string "undefined"
 * -- leftovers of GH #116 that can never be restored. Other invalid guids are
 * kept: ShareRegistry still warns about them so the user can reconnect.
 */
export function withoutUndefinedGuidShares(folders: VaultShareSettings[]): VaultShareSettings[] {
	return folders.filter((folder) => folder.guid !== UNDEFINED_GUID_LITERAL);
}
