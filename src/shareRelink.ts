import { findNestingConflictPath } from "./vaultShareNesting";
import { isRootSharePath } from "./vaultRootPath";

/**
 * Why `target` cannot back the share currently recorded at `sharePath`, or
 * null when it can. `otherSharePaths` are the paths of every OTHER share.
 * The vault root is refused: re-linking a share to it would sync the whole
 * vault.
 */
export function relinkTargetError(
	target: string,
	sharePath: string,
	otherSharePaths: readonly string[],
	sep = "/",
): string | null {
	if (isRootSharePath(target)) return "The vault root cannot be used.";
	if (target === sharePath) return "This is already the folder of this share.";
	if (otherSharePaths.includes(target)) return "Another shared folder uses this folder.";
	const conflict = findNestingConflictPath(target, [...otherSharePaths], sep);
	if (conflict !== null) return `Nested shared folders are not supported (${conflict}).`;
	return null;
}

/** Folder paths a share at `sharePath` can be re-linked to, sorted. */
export function relinkCandidates(
	folderPaths: readonly string[],
	sharePath: string,
	otherSharePaths: readonly string[],
	sep = "/",
): string[] {
	return folderPaths
		.filter((p) => relinkTargetError(p, sharePath, otherSharePaths, sep) === null)
		.sort((a, b) => a.localeCompare(b));
}
