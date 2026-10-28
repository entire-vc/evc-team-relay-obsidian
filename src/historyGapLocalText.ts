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

type DeleteSet = ReturnType<typeof Y.decodeUpdate>["ds"];

/**
 * Calls `onClose` once, in the transaction that closes `ydoc`'s history gap,
 * with the text `ytextName` read as at the time of this call: this client's
 * stored updates, pending ones included. `undefined` if that text can't be
 * read back. Returns a function that stops watching.
 */
export function watchHistoryGapClose(
	ydoc: Y.Doc,
	ytextName: string,
	onClose: (localText: string | undefined) => void,
): () => void {
	const { structs, ds } = Y.decodeUpdate(Y.encodeStateAsUpdate(ydoc));
	const known = new Map<number, number>();
	const strings = new Map<number, { clock: number; str: string }[]>();
	for (const struct of structs) {
		if (struct instanceof Y.Skip) continue;
		const { client, clock } = struct.id;
		const end = clock + struct.length;
		if (end > (known.get(client) ?? 0)) known.set(client, end);
		if (struct instanceof Y.Item && struct.content instanceof Y.ContentString) {
			const runs = strings.get(client) ?? [];
			runs.push({ clock, str: struct.content.str });
			strings.set(client, runs);
		}
	}
	const handler = () => {
		if (hasHistoryGap(ydoc)) return;
		ydoc.off("afterTransaction", handler);
		onClose(textAt(ydoc.getText(ytextName), known, ds, strings));
	};
	ydoc.on("afterTransaction", handler);
	return () => ydoc.off("afterTransaction", handler);
}

function textAt(
	ytext: Y.Text,
	known: Map<number, number>,
	ds: DeleteSet,
	strings: Map<number, { clock: number; str: string }[]>,
): string | undefined {
	const deleted = new Map<number, { clock: number; len: number }[]>();
	ds.clients.forEach((ranges, client) => deleted.set(client, [...ranges].sort((a, b) => a.clock - b.clock)));
	strings.forEach((runs) => runs.sort((a, b) => a.clock - b.clock));
	const visible = (client: number, clock: number) =>
		clock < (known.get(client) ?? 0) &&
		rangeAt(deleted.get(client), clock, (range) => range.len) === undefined;
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
			if (!visible(client, clock + i)) continue;
			const char = live?.[i] ?? storedChar(client, clock + i);
			// Collected, and not in this client's store either: unknown.
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
