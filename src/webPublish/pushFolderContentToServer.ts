import { sha256Hex } from "../contentDigest";
import type { WebFolderEntry } from "../RelayOnPremShareClient";
import { joinFolderPath } from "../vaultRootPath";

/** The true external boundary this function talks to: the relay server's
 * sync-write protocol. Extracted as an interface so tests can fake exactly
 * this (and nothing else -- `sha256Hex` and the folder-walk stay real) per
 * the mocking convention (mock only at true external
 * boundaries, never internal logic). */
export interface FolderPushDeps {
	getFilesIndex(): Promise<{ path: string; sha256: string }[]>;
	syncWriteFile(
		path: string,
		content: string,
		precondition: { create: true } | { ifMatchSha256: string },
		mime: string,
	): Promise<void>;
	getDocumentContent(path: string): Promise<string | null>;
}

// The server only counts a folder share as publishable once at least one
// item's `content`/`storage_key` is populated (share_service.
// _share_has_publishable_content) -- and the ONLY endpoint that populates
// either is the per-file conditional sync-write protocol, keyed by
// share id so it works before the share has ever been published (unlike
// syncFolderFileContent, which needs an existing web_slug and so
// can only ever run AFTER a first successful publish). Without this,
// toggling "Publish to Web" on a folder share 400s forever regardless of
// how much real local content exists, because the generic
// UpdateShareRequest.web_folder_items the toggle sends is structure-only
// (path/name/type) by design.
//
// Returns the paths that could not be written (e.g.: a name the
// server's path validator rejects) so the caller can still publish
// everything else and tell the user what was skipped, instead of one bad
// file aborting the whole publish -- matching the existing per-file
// try/catch idiom in syncFolderFileContent's loop.
export async function pushFolderContentToServer(
	folderPath: string,
	items: WebFolderEntry[],
	deps: FolderPushDeps,
): Promise<string[]> {
	const syncable = items.filter((i) => i.type === "doc" || i.type === "canvas");
	if (syncable.length === 0) return [];

	let indexed = new Map<string, string>();
	try {
		const index = await deps.getFilesIndex();
		indexed = new Map(index.map((i) => [i.path, i.sha256]));
	} catch {
		// No prior index (fresh share, or the endpoint genuinely has
		// nothing yet) -- treat every item as never-before-synced below.
	}

	const skipped: string[] = [];
	for (const item of syncable) {
		const content = await deps.getDocumentContent(joinFolderPath(folderPath, item.path));
		if (content === null) continue; // file vanished between listing and read -- skip, not fatal
		const localSha = await sha256Hex(new TextEncoder().encode(content).buffer);
		const remoteSha = indexed.get(item.path);
		if (remoteSha === localSha) continue; // already in sync, don't churn a needless write

		const precondition = remoteSha ? { ifMatchSha256: remoteSha } : ({ create: true } as const);
		const mime = item.type === "canvas" ? "application/json" : "text/markdown; charset=utf-8";
		try {
			await deps.syncWriteFile(item.path, content, precondition, mime);
		} catch (e: unknown) {
			console.error(`Failed to publish "${item.path}":`, e);
			skipped.push(item.path);
		}
	}
	return skipped;
}
