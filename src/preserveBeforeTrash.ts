/**
 * Pure decision logic for before a remote-delete cleanup
 * trashes a local file, decide whether it has unsynced edits worth
 * preserving as a conflict-copy instead of letting them be silently
 * destroyed.
 *
 * Extracted dependency-free (no Document.ts/pocketbase import) so it's
 * directly testable — VaultShare.ts/Document.ts transitively pull in the
 * ESM-only `pocketbase` package, which breaks ts-jest parsing (the same
 * wall ytextDiff.ts, vaultShareNesting.ts, and websocketFlush.ts
 * were extracted around). See VaultShare.preserveUnsyncedDocumentBeforeTrash
 * for the I/O side (reading the vault file, writing the conflict copy).
 *
 * `hasUnsyncedCanvasEdit` extends this to CanvasDocument files :
 * same underlying gap as Documents, but a `.canvas` file is JSON, not
 * plain text, so raw string comparison would false-positive on
 * formatting differences alone (Obsidian pretty-prints the on-disk file;
 * `CanvasDocument.exportData` doesn't). Uses the same deep object-comparison
 * `deepValueEquals` that TransferQueue.uploadDocumentViaSocket already
 * applies to canvas content for exactly this reason.
 */

import type * as Y from "yjs";
import { sameTextContent } from "./textEquivalence";
import type { CanvasData } from "./HostCanvasView";
import { deepValueEquals } from "./deepValueEquals";

export interface PathHolder {
	entryPath: string;
}

/**
 * Find the live object (if any) tracking `vpath` among `values`, matching an
 * arbitrary caller-supplied predicate (e.g. "is this a Document") — kept
 * generic so this module never needs to import the concrete type itself.
 *
 * Returns the LAST match by iteration order, not the first. Callers backed
 * by a `Map` iterate in insertion order, and a map that's never pruned on
 * a remote delete (VaultShare.trackedEntries is exactly this) can end up holding
 * more than one entry for the same path if it's deleted and recreated more
 * than once in a session — the most recently inserted entry is the live
 * one; an earlier entry at the same path is a stale orphan.
 */
export function findByPath<T extends PathHolder>(
	values: Iterable<T>,
	vpath: string,
	predicate: (value: T) => boolean,
): T | undefined {
	let found: T | undefined;
	for (const value of values) {
		if (predicate(value) && value.entryPath === vpath) {
			found = value;
		}
	}
	return found;
}

/**
 * Whether `doc` holds updates it cannot integrate yet: its local history is
 * missing earlier changes, so what it shows is not what was last synced.
 */
export function hasHistoryGap(doc: Y.Doc): boolean {
	return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/**
 * Does the on-disk content differ from the last known synced content? If so,
 * it should be preserved as a conflict-copy before the destructive trash
 * proceeds; if it matches, the existing trash behavior is safe as-is.
 */
export function hasUnsyncedEdit(onDiskContent: string, syncedContent: string): boolean {
	return !sameTextContent(onDiskContent, syncedContent);
}

/**
 * CanvasDocument equivalent of `hasUnsyncedEdit`. `onDiskJson` is the raw `.canvas`
 * file content; `syncedData` is the last known synced state (the live
 * CanvasDocument's exported Y.Doc content — see `CanvasDocument.exportData`).
 *
 * Fails CLOSED on unparsable on-disk content: if it can't be confirmed to
 * match, treat it as an edit worth preserving rather than risk silently
 * trashing content we couldn't even read as JSON.
 *
 * `deepValueEquals` compares arrays positionally (index-by-index), but
 * `nodes`/`edges` order here is NOT semantically meaningful — `syncedData`
 * comes from iterating a Y.Map (order = each key's first-insertion time
 * into that CRDT map, which depends on local edit history AND the order
 * remote updates were applied), while the on-disk array is whatever order
 * Obsidian's own canvas view happens to serialize. These two orderings
 * have no reason to agree even when every node/edge is byte-identical, so
 * comparing positionally would false-positive a real (but reordered, not
 * edited) canvas as "unsynced" on every trash cycle. Sort both sides by
 * `id` first so the comparison is content-only.
 */
export function hasUnsyncedCanvasEdit(
	onDiskJson: string,
	syncedData: CanvasData,
): boolean {
	let onDiskData: CanvasData;
	try {
		onDiskData = onDiskJson
			? (JSON.parse(onDiskJson) as CanvasData)
			: { nodes: [], edges: [] };
	} catch {
		return true;
	}
	return !deepValueEquals(normalizeCanvasData(syncedData), normalizeCanvasData(onDiskData));
}

/**
 * Sort `nodes`/`edges` by `id` so positional array comparison (as done by
 * `deepValueEquals`) is order-independent. Does not mutate the input.
 */
function normalizeCanvasData(data: CanvasData): CanvasData {
	return {
		nodes: [...(data.nodes ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
		edges: [...(data.edges ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
	};
}
