/**
 * Pure navigation logic for SettingsPanel.svelte, split out so the
 * deep-link path parsing and the back-stack unwind (both plain data
 * transforms, no Svelte reactivity involved) are directly testable and
 * readable without the component's `let`/`$:` bookkeeping around them.
 */
import type { RelayWorkspace, RemoteFolderRecord } from "../RelayModel";
import type { VaultShare, ShareRegistry } from "../VaultShare";
import SyncedFolderManager from "./SyncedFolderManager.svelte";

export type SettingsComponent = typeof SyncedFolderManager;

export interface NavView {
	activeRelay?: RelayWorkspace;
	vaultShare?: VaultShare;
	activeRemoteFolder?: RemoteFolderRecord;
	activeComponent?: SettingsComponent;
}

/** What setPath() found for a given deep-link path. `activeComponent` is left
 * unset when the path doesn't determine one (e.g. "/shared-folders" with
 * no id) -- the caller leaves currentComponent as it already is, same as
 * the original inline implementation's implicit no-op `return`. */
export interface PathPatch {
	activeRelay?: RelayWorkspace;
	vaultShare?: VaultShare;
	activeRemoteFolder?: RemoteFolderRecord;
	activeComponent?: SettingsComponent;
}

/**
 * Only "/shared-folders?id=..." resolves to anything -- "/relays..." and the
 * bare "/" home path used to resolve to the legacy cloud Relays
 * list, which is unreachable in the shipped relay-onprem build (removed as
 * dead code). Nothing constructs a "/relays" path anywhere in the
 * tree even historically, so this was already effectively "/shared-folders"
 * or nothing.
 */
export function resolvePath(
	path: string,
	shareRegistry: ShareRegistry,
): PathPatch {
	if (!path.startsWith("/shared-folders")) {
		return {};
	}

	const urlParams = new URLSearchParams(path.split("?")[1] || "");
	const id = urlParams.get("id");
	if (!id) return {};

	const vaultShare = shareRegistry.locate((f) => f.entityGuid === id);
	return { vaultShare, activeComponent: SyncedFolderManager };
}

export type GoBackResult =
	| { action: "reset" }
	| { action: "apply"; view: NavView }
	| { action: "noop" };

/**
 * Pops `history` (in place, same array reference) looking for a view still
 * safe to show. An entry with none of activeRelay/vaultShare/activeRemoteFolder
 * set ("home") is applied but does NOT stop the unwind -- deliberately
 * matching the original inline loop, which fell through to the next pop()
 * even after recording a home entry as the current best candidate. If the
 * stack has entries but none of them (nor any home fallthrough) is ever
 * recorded, the result is "noop": the caller leaves the current view alone,
 * exactly as the original left the reactive state untouched in that case.
 */
export function popToRestorableView(
	history: NavView[],
	shareRegistry: ShareRegistry,
): GoBackResult {
	let candidate = history.pop();
	if (!candidate) {
		return { action: "reset" };
	}

	let lastHomeEntry: NavView | undefined;
	while (candidate) {
		if (!candidate.activeRelay && !candidate.vaultShare && !candidate.activeRemoteFolder) {
			lastHomeEntry = candidate;
		} else if (candidate.vaultShare && shareRegistry.contains(candidate.vaultShare)) {
			return { action: "apply", view: candidate };
		} else if (candidate.activeRemoteFolder) {
			return { action: "apply", view: candidate };
		}
		candidate = history.pop();
	}

	return lastHomeEntry ? { action: "apply", view: lastHomeEntry } : { action: "noop" };
}
