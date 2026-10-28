/**
 * What a doc's text read as in this client's own history, recovered at the
 * moment a history gap closes.
 *
 * While the gap is open the text reads empty or partial, so it can't be
 * compared with the file. The relay closes the gap with one update that may
 * also carry a peer's edit or clear, and from then on only the merged text
 * is visible. Once the gap is closed the doc orders every item, deleted ones
 * included; the characters a peer deleted may arrive already collected, so
 * they are read from this client's own stored updates instead.
 *
 * Dependency-free (no Document.ts import) so it can be tested directly.
 */

import * as Y from "yjs";
import { hasHistoryGap } from "./preserveBeforeTrash";

type Range = { clock: number; len: number };

/**
 * Calls `onClose` once, in the transaction that closes `ydoc`'s history gap,
 * with the text `ytextName` read as at the time of this call: this client's
 * stored updates, pending ones included. `undefined` if that text can't be
 * read back: some of it lies in history the stored updates build on but do
 * not hold, so what this client saw of it is unknown. Returns a function that
 * stops watching.
 */
export function watchHistoryGapClose(
	ydoc: Y.Doc,
	ytextName: string,
	onClose: (localText: string | undefined) => void,
): () => void {
	const { structs, ds } = Y.decodeUpdate(Y.encodeStateAsUpdate(ydoc));
	const stored = new Map<number, Range[]>();
	const strings = new Map<number, { clock: number; str: string }[]>();
	// Per client, the clocks the stored updates build on: a client's clocks
	// are contiguous, so a struct, reference or deletion at a clock implies
	// every clock before it.
	const ancestry = new Map<number, number>();
	const needs = (id: Y.ID | null) => extend(ancestry, id);
	for (const struct of structs) {
		if (struct instanceof Y.Skip) continue;
		const { client, clock } = struct.id;
		push(stored, client, { clock, len: struct.length });
		needs(Y.createID(client, clock + struct.length - 1));
		if (struct instanceof Y.Item) {
			needs(struct.origin);
			needs(struct.rightOrigin);
			needs(parentId(struct));
			if (struct.content instanceof Y.ContentString) {
				push(strings, client, { clock, str: struct.content.str });
			}
		}
	}
	const deleted = new Map<number, Range[]>();
	ds.clients.forEach((ranges, client) => {
		for (const { clock, len } of ranges) {
			push(deleted, client, { clock, len });
			needs(Y.createID(client, clock + len - 1));
		}
	});
	for (const map of [stored, deleted]) map.forEach((ranges) => ranges.sort((a, b) => a.clock - b.clock));
	strings.forEach((runs) => runs.sort((a, b) => a.clock - b.clock));
	const history: LocalHistory = { stored, deleted, strings, ancestry };
	const handler = () => {
		if (hasHistoryGap(ydoc)) return;
		ydoc.off("afterTransaction", handler);
		expandAncestry(ydoc, ancestry);
		onClose(textAt(ydoc.getText(ytextName), history));
	};
	ydoc.on("afterTransaction", handler);
	return () => ydoc.off("afterTransaction", handler);
}

interface LocalHistory {
	stored: Map<number, Range[]>;
	deleted: Map<number, Range[]>;
	strings: Map<number, { clock: number; str: string }[]>;
	ancestry: Map<number, number>;
}

/** Raises `ancestry` to cover `id`; true if it grew. */
function extend(ancestry: Map<number, number>, id: Y.ID | null): boolean {
	if (!id || id.clock + 1 <= (ancestry.get(id.client) ?? 0)) return false;
	ancestry.set(id.client, id.clock + 1);
	return true;
}

function parentId(item: Y.Item): Y.ID | null {
	const parent = item.parent;
	if (parent instanceof Y.ID) return parent;
	return parent instanceof Y.AbstractType ? (parent._item?.id ?? null) : null;
}

/**
 * Follows what the history this client built on but did not store builds on
 * in turn: the closed gap has brought those structs in, and their references
 * reach clocks this client also saw (a chain through another client's
 * mapping can lead back to text).
 */
function expandAncestry(ydoc: Y.Doc, ancestry: Map<number, number>): void {
	const scanned = new Map<number, number>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [client, end] of [...ancestry]) {
			const from = scanned.get(client) ?? 0;
			if (from >= end) continue;
			scanned.set(client, end);
			for (const struct of ydoc.store.clients.get(client) ?? []) {
				if (struct.id.clock >= end) break;
				if (struct.id.clock + struct.length <= from || !(struct instanceof Y.Item)) continue;
				for (const id of [struct.origin, struct.rightOrigin, parentId(struct)]) {
					if (extend(ancestry, id)) grew = true;
				}
			}
		}
	}
}

function push<T>(map: Map<number, T[]>, client: number, value: T): void {
	const list = map.get(client);
	if (list) list.push(value);
	else map.set(client, [value]);
}

function textAt(ytext: Y.Text, history: LocalHistory): string | undefined {
	const { stored, deleted, strings, ancestry } = history;
	const has = (client: number, clock: number) =>
		rangeAt(stored.get(client), clock, (range) => range.len) !== undefined;
	const storedChar = (client: number, clock: number) => {
		const run = rangeAt(strings.get(client), clock, (r) => r.str.length);
		return run?.str[clock - run.clock];
	};
	let text = "";
	for (let item = ytext._start; item !== null; item = item.right) {
		const live = item.content instanceof Y.ContentString ? item.content.str : undefined;
		if (live === undefined && !(item.content instanceof Y.ContentDeleted)) continue;
		const { client, clock } = item.id;
		for (let i = 0; i < item.length; i++) {
			if (!has(client, clock + i)) {
				// Built on, but not stored: this client saw it, and whether it
				// deleted it is unknown.
				if (clock + i < (ancestry.get(client) ?? 0)) return undefined;
				continue;
			}
			if (rangeAt(deleted.get(client), clock + i, (range) => range.len) !== undefined) continue;
			const char = live?.[i] ?? storedChar(client, clock + i);
			if (char === undefined) return undefined;
			text += char;
		}
	}
	return text;
}

/** The range of `sorted` (by clock, non-overlapping) that holds `clock`. */
function rangeAt<T extends { clock: number }>(
	sorted: T[] | undefined,
	clock: number,
	length: (range: T) => number,
): T | undefined {
	if (!sorted) return undefined;
	let lo = 0;
	let hi = sorted.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = sorted[mid];
		if (clock < range.clock) hi = mid - 1;
		else if (clock >= range.clock + length(range)) lo = mid + 1;
		else return range;
	}
	return undefined;
}
