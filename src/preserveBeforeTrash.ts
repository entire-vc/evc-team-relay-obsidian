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

import * as Y from "yjs";
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
 * Whether `doc`'s text holds back updates it cannot integrate yet: its local
 * history is missing earlier changes, so the text it shows is not what was
 * last synced.
 *
 * A writer whose first changes reached nobody leaves its later presence
 * entries (the `users` map kept by `Y.PermanentUserData`) pending on every
 * client for good; that gap never closes and never alters the text, so it must
 * not hold the text back. The text is complete only if both hold:
 *
 * - every pending change lies outside the text: its parent chain resolves to
 *   another root, its content is a kind a text never holds (this plugin's text
 *   holds no embedded types), or it is deleted;
 * - every missing clock lies outside the text. Nothing in the doc says what a
 *   missing clock held, so the only missing clocks accepted are a writer's
 *   identity seed: `seedDocIdentity` is the first write of every fresh doc, and
 *   when its clocks are missing, the writer's later pushes into the seed's
 *   `ids`/`ds` lists are pending. Any other missing range (a missing prefix
 *   before a presence entry, a hole between pending changes, a pending delete
 *   of a change nobody has) may hold text and counts as a gap.
 */
export function hasHistoryGap(doc: Y.Doc, textName = "contents"): boolean {
	const pending = doc.store.pendingStructs;
	const pendingDs = doc.store.pendingDs;
	if (pending === null && pendingDs === null) return false;
	const structs = pending === null ? [] : Y.decodeUpdateV2(pending.update).structs;
	const byClient = new Map<number, (Y.Item | Y.GC)[]>();
	for (const struct of structs) {
		if (struct instanceof Y.Skip) continue;
		const list = byClient.get(struct.id.client) ?? [];
		list.push(struct);
		byClient.set(struct.id.client, list);
	}
	for (const list of byClient.values()) list.sort((a, b) => a.id.clock - b.id.clock);
	const findPending = (id: Y.ID): Y.Item | Y.GC | undefined =>
		byClient
			.get(id.client)
			?.find((s) => s.id.clock <= id.clock && id.clock < s.id.clock + s.length);

	const rootOfType = (type: Y.AbstractType<unknown>): string | undefined => {
		let current = type;
		while (current._item !== null) {
			const parent = current._item.parent;
			if (!(parent instanceof Y.AbstractType)) return undefined;
			current = parent;
		}
		try {
			return Y.findRootTypeKey(current);
		} catch {
			return undefined;
		}
	};

	// Root name a pending struct belongs to, or undefined when it cannot be told.
	const resolved = new Map<Y.Item | Y.GC, string | undefined>();
	const rootOfId = (id: Y.ID, parentOf: boolean): string | undefined => {
		if (id.clock < Y.getState(doc.store, id.client)) {
			const item = Y.getItem(doc.store, id);
			if (!(item instanceof Y.Item)) return undefined;
			if (parentOf) {
				return item.content instanceof Y.ContentType ? rootOfType(item.content.type) : undefined;
			}
			return item.parent instanceof Y.AbstractType ? rootOfType(item.parent) : undefined;
		}
		const struct = findPending(id);
		if (struct === undefined) return undefined;
		// A nested type's children name its root; anything else names nothing.
		if (parentOf && !(struct instanceof Y.Item && struct.content instanceof Y.ContentType)) return undefined;
		return rootOf(struct);
	};
	const rootOf = (struct: Y.Item | Y.GC): string | undefined => {
		if (resolved.has(struct)) return resolved.get(struct);
		resolved.set(struct, undefined); // cycle guard
		let root: string | undefined;
		if (struct instanceof Y.Item) {
			const parent = struct.parent as unknown;
			if (typeof parent === "string") root = parent;
			else if (parent instanceof Y.ID) root = rootOfId(parent, true);
			else {
				const sibling = struct.origin ?? struct.rightOrigin;
				if (sibling) root = rootOfId(sibling, false);
			}
		}
		resolved.set(struct, root);
		return root;
	};

	for (const list of byClient.values()) {
		for (const struct of list) {
			if (struct instanceof Y.GC || struct.content instanceof Y.ContentDeleted) continue;
			const root = rootOf(struct);
			if (root !== undefined && root !== textName) continue;
			if (root === undefined && neverInText(struct.content)) continue;
			return true;
		}
	}

	// Missing clocks: the ranges before, between and after the pending structs
	// (a pending delete reaches past them) that this doc does not have.
	const deletes: Map<number, { clock: number; len: number }[]> =
		pendingDs === null ? new Map() : Y.decodeUpdateV2(pendingDs).ds.clients;
	const seedClients = new Set<number>();
	for (const client of new Set([...byClient.keys(), ...deletes.keys()])) {
		const state = Y.getState(doc.store, client);
		let next = state;
		const covered: [number, number][] = [];
		for (const struct of byClient.get(client) ?? []) {
			if (struct.id.clock > next) {
				if (next !== 0 || struct.id.clock !== SEED_CLOCKS) return true;
				seedClients.add(client);
			}
			const last = covered[covered.length - 1];
			if (last !== undefined && last[1] === struct.id.clock) last[1] += struct.length;
			else covered.push([struct.id.clock, struct.id.clock + struct.length]);
			next = Math.max(next, struct.id.clock + struct.length);
		}
		for (const { clock, len } of deletes.get(client) ?? []) {
			if (clock + len <= state) continue;
			// A delete of pending changes alters nothing in the text; any other is a gap.
			if (!covered.some(([from, to]) => from <= Math.max(clock, state) && clock + len <= to)) return true;
		}
	}
	// A missing clock is only ever a seed clock: whatever a pending change
	// refers to, and whatever Yjs waits for, is here, pending or in a seed.
	const known = (id: Y.ID): boolean =>
		id.clock < Y.getState(doc.store, id.client) ||
		findPending(id) !== undefined ||
		(seedClients.has(id.client) && id.clock < SEED_CLOCKS);
	for (const struct of structs) {
		if (!(struct instanceof Y.Item)) continue;
		const parent = struct.parent as unknown;
		if (parent instanceof Y.ID && !known(parent)) return true;
		if (struct.origin !== null && !known(struct.origin)) return true;
		if (struct.rightOrigin !== null && !known(struct.rightOrigin)) return true;
	}
	for (const [client, clock] of pending?.missing ?? []) {
		if (!known(Y.createID(client, clock))) return true;
	}
	return ![...seedClients].every((client) => isIdentitySeedGap(structs, client));
}

/** Clocks `Y.PermanentUserData.setUserMapping` writes for a new user entry. */
const SEED_CLOCKS = 4;
/**
 * Layout of those clocks: 0 the user's map in `users`, 1 its `ids` list, 2 its
 * `ds` list, 3 the writer's client id pushed into `ids`.
 */
const SEED_DS = 2;
const SEED_LAST_ID = 3;

/**
 * Whether `client`'s missing clocks 0..3 are its identity seed. Pending changes
 * may refer to them only as a later seed would be referred to: a delete set
 * pushed into the empty `ds` list (parent clock 2) or a client id pushed after
 * the last `ids` entry (left neighbour clock 3). A seed written after an edit
 * (the account resolved late) sits one clock or more further on, so the same
 * pushes land on other clocks or carry other content, and the range is a gap.
 */
function isIdentitySeedGap(structs: (Y.Item | Y.GC | Y.Skip)[], client: number): boolean {
	const inSeed = (id: Y.ID | null): id is Y.ID => id !== null && id.client === client && id.clock < SEED_CLOCKS;
	const deleted = (item: Y.Item) => item.content instanceof Y.ContentDeleted;
	let referred = false;
	for (const struct of structs) {
		if (!(struct instanceof Y.Item)) continue;
		const parent = struct.parent as unknown;
		if (parent instanceof Y.ID && inSeed(parent)) {
			if (parent.clock !== SEED_DS || !(struct.content instanceof Y.ContentBinary || deleted(struct))) return false;
			referred = true;
		}
		if (inSeed(struct.origin)) {
			if (struct.origin.clock !== SEED_LAST_ID || !(struct.content instanceof Y.ContentAny || deleted(struct))) {
				return false;
			}
			referred = true;
		}
		if (inSeed(struct.rightOrigin)) return false;
	}
	return referred;
}

/** Content kinds a Y.Text never holds: list and map values. */
function neverInText(content: Y.Item["content"]): boolean {
	return content instanceof Y.ContentAny || content instanceof Y.ContentBinary || content instanceof Y.ContentJSON;
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
