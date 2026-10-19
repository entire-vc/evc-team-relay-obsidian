"use strict";

import { TFile, TFolder, type Vault } from "obsidian";
import type { WebFolderEntry } from "./RelayOnPremShareClient";

/**
 * Obsidian's own vault root `TFolder` reports `.path === "/"` -- but the
 * relay wire protocol (and this plugin's internal `VaultShare.path`)
 * represents "the whole vault" as the empty string `""`, matching the
 * convention every other folder path already follows (never a leading
 * slash). This is the single place that translates between the two, so the
 * folder-picker UI (which reads real `TFolder.path` values) and the
 * share/VaultShare layer (which expects the wire convention) don't drift
 * out of sync with each other.
 */
export const OBSIDIAN_VAULT_ROOT_PATH = "/";

/** True if `path` is the wire/internal representation of the vault root. */
export function isRootSharePath(path: string): boolean {
	return path === "";
}

/**
 * Converts a path as reported by the Obsidian API (e.g. `TFolder.path`,
 * which is `"/"` for the vault root) into the wire/internal share-path
 * convention (`""` for the vault root, unchanged otherwise).
 */
export function toSharePath(obsidianPath: string): string {
	return obsidianPath === OBSIDIAN_VAULT_ROOT_PATH ? "" : obsidianPath;
}

/**
 * Resolves the on-disk `TFolder` a share's `.path` points at, honoring the
 * vault-root convention above.
 *
 * A naive `vault.getAbstractFileByPath(share.path)` breaks for root shares:
 * `share.path` is `""` (the wire convention), but Obsidian's real root
 * `TFolder.path` is `"/"` (`OBSIDIAN_VAULT_ROOT_PATH`) -- so the lookup finds
 * nothing and callers that don't check for that treat the share as if its
 * backing folder doesn't exist (adoption/full-sync/prune of a root share
 * silently no-ops or throws). `vault.getRoot()` is Obsidian's own documented
 * way to get the root `TFolder` without relying on path lookup at all --
 * every call site that needs "the TFolder a share's `.path` points at" should
 * go through this helper instead of `getAbstractFileByPath` directly.
 */
export function resolveShareFolder(vault: Vault, sharePath: string): TFolder | null {
	if (isRootSharePath(sharePath)) {
		return vault.getRoot();
	}
	const abstractFile = vault.getAbstractFileByPath(sharePath);
	return abstractFile instanceof TFolder ? abstractFile : null;
}

/**
 * True if `path` lies within the folder share rooted at `folderPath`,
 * honoring the vault-root convention: for a root share (`folderPath === ""`)
 * every real vault path is contained, since there's no `"<folderPath>/"`
 * prefix to check for -- no real Obsidian path ever starts with `/`, so a
 * bare `path.startsWith(folderPath + "/")` is always false for a root share
 * and silently treats every file as outside it.
 */
export function isPathWithinFolder(path: string, folderPath: string): boolean {
	return isRootSharePath(folderPath) || path.startsWith(folderPath + "/");
}

/**
 * Converts a path known to lie within the folder share rooted at `folderPath`
 * (see `isPathWithinFolder`) to its path relative to that share, honoring the
 * vault-root convention: for a root share there's no `"<folderPath>/"`
 * prefix on disk to strip, `path` IS already the relative path. Stripping
 * `folderPath.length + 1` unconditionally would chop the first character off
 * every top-level item's path instead (e.g. "readme.md" -> "eadme.md").
 */
export function toFolderRelativePath(path: string, folderPath: string): string {
	return isRootSharePath(folderPath) ? path : path.substring(folderPath.length + 1);
}

/**
 * Joins a folder share's path with a path already relative to it -- the
 * inverse of `toFolderRelativePath` -- honoring the vault-root convention:
 * for a root share there's no `folderPath` segment to prepend,
 * `relativePath` IS already the full vault path. Prepending `"" + "/"`
 * unconditionally would produce a leading-slash path (e.g. "/readme.md")
 * that `vault.getAbstractFileByPath` never resolves, since no real
 * Obsidian path starts with a separator.
 */
export function joinFolderPath(folderPath: string, relativePath: string): string {
	return isRootSharePath(folderPath) ? relativePath : `${folderPath}/${relativePath}`;
}

/**
 * Recursively lists a share folder's contents (md/canvas files + subfolders)
 * as `WebFolderEntry[]` for `web_folder_items`, honoring the vault-root path
 * convention.
 *
 * Single implementation shared by every `getFolderItems()` call site
 * (previously duplicated three times -- WebSyncManager, ShareManagementModal,
 * ShareDetailView.svelte -- with this exact bug fixed in the first two but
 * left behind in the third) so this bug class can't reappear in a fourth copy.
 */
export function collectWebFolderItems(folder: TFolder, folderPath: string): WebFolderEntry[] {
	const items: WebFolderEntry[] = [];
	const process = (f: TFolder) => {
		for (const child of f.children) {
			const rel = toFolderRelativePath(child.path, folderPath);
			if (child instanceof TFile) {
				if (child.extension === "canvas") {
					items.push({ path: rel, name: child.basename, type: "canvas" });
				} else if (child.extension === "md") {
					items.push({ path: rel, name: child.basename, type: "doc" });
				}
			} else if (child instanceof TFolder) {
				items.push({ path: rel, name: child.name, type: "folder" });
				process(child);
			}
		}
	};
	process(folder);
	return items;
}
