/**
 * Per-document change marker carried in the shared folder's Y.Doc.
 *
 * A closed note on a receiving client has no live connection, so the only
 * way it learns about a peer's edit is CrdtBackgroundSyncPoller visiting it.
 * Without a signal that names WHICH document changed, the poller can only
 * sweep every unopened document in turn -- capped at TransferQueue.laneLimit
 * concurrent pulls, a sweep over ~800 documents takes minutes, so
 * the one edited note could wait most of that before its turn.
 *
 * The folder Y.Doc, unlike per-document ones, IS live-connected on every
 * client for as long as the share is online. So the client that changes a
 * document's Y.Text writes `guid -> fingerprint(text)` into a dedicated map
 * here, and receivers observing a remote write to that map pull that one
 * document first. The fingerprint also tells the receiver whether the
 * content it pulled is already the announced one: the marker travels on the
 * folder connection and the content on the document's own, so the marker can
 * arrive first; a mismatch means "pull again shortly", not "done".
 *
 * A separate map, not a field on `filemeta_v0` records: every write to
 * filemeta_v0 wakes FolderIndex's observer and a full folder reconcile on
 * every client, and older clients, the MCP server and web publish all read
 * those records. Nothing else reads this map, so older clients simply ignore
 * it. Writers that don't publish markers (older clients, server-side edits)
 * are still covered by the poller's bounded sweep -- this is a fast path,
 * never the only path.
 */
import type * as Y from "yjs";

export const DOC_ACTIVITY_MAP = "docactivity_v0";

/** Coalesce a burst of keystrokes into one marker write... */
const PUBLISH_DEBOUNCE_MS = 1_000;
/** ...but never hold a marker back longer than this while edits keep coming. */
const PUBLISH_MAX_WAIT_MS = 5_000;

/**
 * Cheap, synchronous content fingerprint: FNV-1a over UTF-16 code units plus
 * the length. Only ever compared for equality against another fingerprint of
 * the same text -- a collision costs one skipped re-pull, which the sweep
 * then covers.
 */
export function textFingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export interface ActivityTimers {
	setTimeout: (callback: () => void, ms: number) => number;
	clearTimeout: (id: number) => void;
	now: () => number;
}

const windowTimers: ActivityTimers = {
	setTimeout: (callback, ms) => window.setTimeout(callback, ms),
	clearTimeout: (id) => window.clearTimeout(id),
	now: () => Date.now(),
};

interface PendingMarker {
	timer: number;
	firstAt: number;
	readText: () => string;
}

export type RemoteActivityListener = (guid: string, fingerprint: string) => void;

export class DocActivityChannel {
	private readonly pending = new Map<string, PendingMarker>();
	private readonly listeners = new Set<RemoteActivityListener>();
	private readonly map: Y.Map<string>;
	private readonly observer: (event: Y.YMapEvent<string>) => void;
	private destroyed = false;

	constructor(
		crdt: Y.Doc,
		private readonly timers: ActivityTimers = windowTimers,
	) {
		this.map = crdt.getMap<string>(DOC_ACTIVITY_MAP);
		this.observer = (event) => {
			if (event.transaction.local) return;
			event.changes.keys.forEach((change, guid) => {
				if (change.action === "delete") return;
				const fingerprint = this.map.get(guid);
				if (fingerprint === undefined) return;
				for (const listener of this.listeners) listener(guid, fingerprint);
			});
		};
		this.map.observe(this.observer);
	}

	/**
	 * Records that this client changed `guid`'s text. Debounced per document;
	 * `readText` is called when the marker is actually written, so it carries
	 * the text as of the end of the burst.
	 */
	noteLocalEdit(guid: string, readText: () => string): void {
		if (this.destroyed) return;
		const now = this.timers.now();
		const existing = this.pending.get(guid);
		const firstAt = existing?.firstAt ?? now;
		if (existing) this.timers.clearTimeout(existing.timer);
		const delay = Math.max(0, Math.min(PUBLISH_DEBOUNCE_MS, firstAt + PUBLISH_MAX_WAIT_MS - now));
		const timer = this.timers.setTimeout(() => this.publish(guid), delay);
		this.pending.set(guid, { timer, firstAt, readText });
	}

	private publish(guid: string): void {
		const entry = this.pending.get(guid);
		this.pending.delete(guid);
		if (!entry || this.destroyed) return;
		const fingerprint = textFingerprint(entry.readText());
		if (this.map.get(guid) === fingerprint) return;
		this.map.doc?.transact(() => this.map.set(guid, fingerprint), this);
	}

	/** Called for every marker written by ANOTHER client. */
	subscribeRemote(listener: RemoteActivityListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	destroy(): void {
		this.destroyed = true;
		for (const { timer } of this.pending.values()) this.timers.clearTimeout(timer);
		this.pending.clear();
		this.listeners.clear();
		this.map.unobserve(this.observer);
	}
}
