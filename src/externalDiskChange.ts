/**
 * A note open in an editor whose file is rewritten by another program (a
 * script, a git checkout, another editor).
 *
 * Such a note is skipped by the upload lane (the bound editor writes its own
 * edits into the Y.Doc, see uploadOnModify), and the outbound writer only
 * sends text the relay already agrees with. Obsidian reloads the file into
 * the editor, but whether that reload reaches the Y.Doc depends on the view
 * (Reading view has no editor to observe; a pending or failed save makes
 * Obsidian skip the reload). When it did not, the rewrite stayed on this
 * device's disk only and the members silently diverged.
 *
 * So the vault "modify" of an editor-bound note is checked here, at the
 * moment it fires:
 *  - a write this app made itself (an editor save, our own disk sync) is
 *    recognised by its text and ignored -- an editor save can trail the Y.Doc
 *    by a debounce while a collaborator types, and taking it for an outside
 *    change would undo their edits;
 *  - otherwise, if the Y.Doc still holds what the file held before the
 *    rewrite, the new text goes into the Y.Doc and from there to the relay;
 *  - if the Y.Doc moved on meanwhile, the new text still goes in, and the
 *    Y.Doc text it replaces is kept in a conflict copy first.
 *
 * Every wait (a lock on the file, a note still syncing, a conflict copy being
 * written) can let a newer outside change or a collaborator's edit in, so
 * after each one the file is read again and the Y.Doc compared again, and the
 * replacement itself runs with no wait between that check and the edit.
 * Whatever leaves the note out of step with the other members, or puts text
 * in a copy, is told to the user.
 */

import type * as Y from "yjs";
import { hasPreservableContent, normalizeLineEndings, sameTextContent } from "./textEquivalence";
import { applyDiffToYText } from "./ytextDiff";

/** How long the write before the latest one still counts as this app's. */
export const PREVIOUS_WRITE_WINDOW_MS = 10_000;

interface OwnWrite {
	text: string;
	/** Order of the write among this app's writes, see AppWriteLog.mark. */
	seq: number;
	at: number;
}

/**
 * The text this app wrote to each file, through the vault adapter. Another
 * program's write never passes through it, so a file whose text is not here
 * was changed from outside.
 */
export class AppWriteLog {
	private readonly own = new Map<string, OwnWrite[]>();
	private readonly last = new Map<string, string>();
	private seq = 0;

	constructor(private readonly now: () => number) {}

	/**
	 * A point in this app's write history. Taken when an outside change is
	 * noticed and handed to observe(), so writes made after that moment are
	 * still recognised as this app's own.
	 */
	mark(): number {
		return this.seq;
	}

	/** This app wrote `text` to `path`. */
	record(path: string, text: string): void {
		const at = this.now();
		const kept = (this.own.get(path) ?? []).filter(
			(w) => w.text !== text && at <= w.at + PREVIOUS_WRITE_WINDOW_MS,
		);
		kept.push({ text, seq: ++this.seq, at });
		this.own.set(path, kept);
		this.last.set(path, text);
	}

	/**
	 * The file holds `text`, which this app did not write (an outside change
	 * just taken into the Y.Doc), noticed at `since` (a mark()). It becomes the
	 * text "before" the next change. This app's writes up to `since` no longer
	 * count as its own, so a quick A -> B -> A from outside does not read as
	 * an echo; writes made after `since` (a disk sync while the change was
	 * handled) still do, so their own "modify" is not taken for an outside one.
	 */
	observe(path: string, text: string, since: number): void {
		const kept = (this.own.get(path) ?? []).filter((w) => w.seq > since);
		if (kept.length > 0) this.own.set(path, kept);
		else this.own.delete(path);
		// A write made after the change was noticed is newer than it.
		if (kept.length === 0) this.last.set(path, text);
	}

	/** The file's text as this app last left or saw it, if known. */
	lastText(path: string): string | undefined {
		return this.last.get(path);
	}

	/**
	 * Whether `text` is what this app itself wrote to `path`: its latest
	 * write, or an earlier one made within the last few seconds.
	 */
	isOwnWrite(path: string, text: string): boolean {
		const writes = this.own.get(path);
		if (!writes || writes.length === 0) return false;
		const now = this.now();
		return writes.some(
			(w, i) =>
				sameTextContent(w.text, text) &&
				(i === writes.length - 1 || now <= w.at + PREVIOUS_WRITE_WINDOW_MS),
		);
	}

	forget(path: string): void {
		this.own.delete(path);
		this.last.delete(path);
	}

	rename(oldPath: string, newPath: string): void {
		const writes = this.own.get(oldPath);
		const last = this.last.get(oldPath);
		this.forget(oldPath);
		if (writes) this.own.set(newPath, writes);
		if (last !== undefined) this.last.set(newPath, last);
	}
}

export type ExternalRewriteOutcome =
	/** The Y.Doc already holds the file's text. */
	| { kind: "in-sync" }
	/** The new text went into the Y.Doc; nothing else changed there. */
	| { kind: "merged" }
	/** The new text went into the Y.Doc; the replaced Y.Doc text was kept at `conflictPath`. */
	| { kind: "merged-with-copy"; conflictPath: string }
	/** A newer outside change is on disk now; it is handled by its own event. */
	| { kind: "superseded" }
	/** The file could not be read again to confirm the change; the Y.Doc was left as it was. */
	| { kind: "unconfirmed" }
	/**
	 * The Y.Doc was left as it was: the conflict copy could not be written,
	 * or collaborators kept changing the note while copies were written.
	 */
	| { kind: "skipped"; reason: "copy-failed" | "kept-changing"; conflictPath?: string };

/**
 * Whether the text read from a file is still its outside text: "unknown"
 * when the file could not be read again.
 */
export type Recheck = "current" | "superseded" | "unknown";

/** Conflict copies tried while collaborators keep editing, before giving up. */
export const COPY_ATTEMPTS = 3;

/** Line endings of `text` made to match the Y.Doc's, as an editor reload would. */
function alignLineEndings(text: string, current: string): string {
	return current.includes("\r") ? text : normalizeLineEndings(text);
}

/**
 * Put an outside rewrite of a note into its Y.Doc. `before` is the file's
 * text before the rewrite (what this app last wrote or loaded), if known.
 * `recheck` reports whether `disk` is still the file's outside text; it is
 * asked after the conflict copy is written, the only wait in here.
 */
export async function absorbExternalRewrite(
	ydoc: Y.Doc,
	disk: string,
	before: string | undefined,
	writeConflictCopy: (content: string) => Promise<string>,
	origin: unknown,
	log: (...args: unknown[]) => void = () => {},
	recheck: () => Promise<Recheck> = async () => "current",
): Promise<ExternalRewriteOutcome> {
	const ytext = ydoc.getText("contents");
	let lastCopy: string | undefined;
	for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
		// From here to applyDiffToYText nothing is awaited, so no
		// collaborator's edit can land between the check and the replacement.
		const current = ytext.toJSON();
		if (sameTextContent(current, disk)) {
			return lastCopy !== undefined
				? { kind: "merged-with-copy", conflictPath: lastCopy }
				: { kind: "in-sync" };
		}
		const incoming = alignLineEndings(disk, current);
		if (
			lastCopy === undefined &&
			(!hasPreservableContent(current) || (before !== undefined && sameTextContent(current, before)))
		) {
			applyDiffToYText(ydoc, incoming, origin);
			return { kind: "merged" };
		}
		try {
			lastCopy = await writeConflictCopy(current);
		} catch (e: unknown) {
			log("could not keep the replaced text in a copy; the Y.Doc is left as it was", e);
			return { kind: "skipped", reason: "copy-failed" };
		}
		const fresh = await recheck();
		if (fresh !== "current") return { kind: fresh === "superseded" ? "superseded" : "unconfirmed" };
		if (ytext.toJSON() === current) {
			applyDiffToYText(ydoc, incoming, origin);
			return { kind: "merged-with-copy", conflictPath: lastCopy };
		}
		// A collaborator edited the note while the copy was written: the copy
		// lacks that edit, so keep the newer text in a copy too before replacing.
		log("the note changed while its conflict copy was written; copying again");
	}
	return { kind: "skipped", reason: "kept-changing", conflictPath: lastCopy };
}

/** Transaction origin of an outside rewrite taken into the Y.Doc. */
export const EXTERNAL_REWRITE_ORIGIN = "external-disk-rewrite";

/** What the vault "modify" handler needs from an editor-bound note. */
export interface BoundNote {
	crdtDoc: Y.Doc;
	isSynced: boolean;
	onceFreshlySynced(): Promise<void>;
}

/** Reads of the rewritten file tried before giving up (a file another program still holds locked). */
export const READ_ATTEMPTS = 4;
export const READ_RETRY_MS = 500;
/** Longest wait for a note that is still syncing before its outside text is kept in a copy. */
export const SYNC_WAIT_MS = 15_000;

export interface ExternalRewriteDeps {
	writes: AppWriteLog;
	read: () => Promise<string>;
	writeConflictCopy: (content: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	log: (...args: unknown[]) => void;
	/** Shows the user a message (see rewriteNotice). */
	notify?: (message: string) => void;
}

export type BoundNoteOutcome =
	| Exclude<ExternalRewriteOutcome, { kind: "unconfirmed" }>
	/** The change is this app's own write. */
	| { kind: "own-write" }
	/** The file could not be read; the change is still on disk. */
	| { kind: "unreadable" }
	/**
	 * The outside text was kept at `conflictPath`, the Y.Doc left as it was:
	 * the note did not sync in time, or the file could not be read again to
	 * confirm the change.
	 */
	| { kind: "kept-as-copy"; conflictPath: string; reason: KeptReason }
	/** As kept-as-copy, but the copy failed: the outside text is on this device only. */
	| { kind: "not-shared"; reason: KeptReason };

export type KeptReason = "not-synced" | "recheck-failed";

async function readWithRetry(deps: ExternalRewriteDeps): Promise<string | null> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await deps.read();
		} catch (e: unknown) {
			if (attempt >= READ_ATTEMPTS) {
				deps.log("could not read the rewritten file", e);
				return null;
			}
			await deps.sleep(READ_RETRY_MS);
		}
	}
}

async function settled(promise: Promise<unknown>, ms: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => false,
		),
		sleep(ms).then(() => false),
	]);
}

/**
 * The message the user sees after an outside change of `path`, or null when
 * the note simply took the change in (or there was nothing to do).
 */
export function rewriteNotice(path: string, outcome: BoundNoteOutcome): string | null {
	const differs = "The note on this device now differs from the other members' copy.";
	switch (outcome.kind) {
		case "unreadable":
			return `Team Relay: "${path}" was changed by another program but could not be read (it may be locked), so the change was not shared. ${differs}`;
		case "skipped":
			return outcome.reason === "copy-failed"
				? `Team Relay: "${path}" was changed by another program, but the shared text it would replace could not be saved as a copy, so the change was not shared. ${differs}`
				: `Team Relay: "${path}" was changed by another program while others kept editing it, so the change was not shared. ${differs}` +
					(outcome.conflictPath ? ` The latest shared text was saved as "${outcome.conflictPath}".` : "");
		case "not-shared":
			return outcome.reason === "not-synced"
				? `Team Relay: "${path}" was changed by another program before it finished syncing, and the change could not be saved as a copy, so it was not shared. ${differs}`
				: `Team Relay: "${path}" was changed by another program, but the file could not be read again to confirm the change, nor saved as a copy, so the change was not shared. ${differs}`;
		case "kept-as-copy":
			return outcome.reason === "not-synced"
				? `Team Relay: "${path}" was changed by another program before it finished syncing. The changed version was saved as "${outcome.conflictPath}"; the shared note is unchanged.`
				: `Team Relay: "${path}" was changed by another program, but the file could not be read again to confirm the change, so it was not shared. The changed version was saved as "${outcome.conflictPath}". ${differs}`;
		case "merged-with-copy":
			return `Team Relay: "${path}" was changed by another program and now shows that version. The shared text it replaced was saved as "${outcome.conflictPath}".`;
		default:
			return null;
	}
}

/**
 * Runs the outside-change handling of one note at a time, in the order the
 * vault reported the changes; different notes do not wait for each other.
 */
export class PathQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(path: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(path) ?? Promise.resolve();
		const next = previous.then(task, task);
		const tail = next.catch(() => undefined);
		this.tails.set(path, tail);
		void tail.then(() => {
			if (this.tails.get(path) === tail) this.tails.delete(path);
		});
		return next;
	}
}

/**
 * Handle the vault "modify" of an editor-bound note. Call it synchronously
 * from the event: `loadedText` is the text the open editor last loaded or
 * saved (Obsidian only replaces it after its own asynchronous re-read), and
 * the file is read at once, before waiting in `queue` behind earlier changes
 * of the note -- this app may write the file meanwhile, and an outside text
 * nobody read would then be gone.
 */
export function onBoundNoteModified(
	path: string,
	note: BoundNote,
	loadedText: string | undefined,
	deps: ExternalRewriteDeps,
	queue?: PathQueue,
): Promise<BoundNoteOutcome> {
	const since = deps.writes.mark();
	const disk = readWithRetry(deps);
	const task = async (): Promise<BoundNoteOutcome> => {
		const outcome = await handleBoundNoteModified(path, note, loadedText, deps, await disk, since);
		deps.log("outside rewrite of an open note", path, outcome.kind);
		const message = rewriteNotice(path, outcome);
		if (message !== null) deps.notify?.(message);
		return outcome;
	};
	return queue ? queue.run(path, task) : task();
}

async function handleBoundNoteModified(
	path: string,
	note: BoundNote,
	loadedText: string | undefined,
	deps: ExternalRewriteDeps,
	disk: string | null,
	since: number,
): Promise<BoundNoteOutcome> {
	if (disk === null) return { kind: "unreadable" };
	if (deps.writes.isOwnWrite(path, disk)) return { kind: "own-write" };
	const before = deps.writes.lastText(path) ?? loadedText;

	// Whether `disk` is still what another program left in the file. A
	// different text this app wrote meanwhile (its own disk sync) does not
	// replace it; a different outside text does, and has its own event.
	const recheck = async (): Promise<Recheck> => {
		const now = await readWithRetry(deps);
		if (now === null) return "unknown";
		return sameTextContent(now, disk) || deps.writes.isOwnWrite(path, now) ? "current" : "superseded";
	};
	// The Y.Doc stays as it is; keep the outside text where the user can find it.
	const keepAsCopy = async (reason: KeptReason): Promise<BoundNoteOutcome> => {
		try {
			return { kind: "kept-as-copy", conflictPath: await deps.writeConflictCopy(disk), reason };
		} catch (e: unknown) {
			deps.log("could not keep the outside text in a copy", path, e);
			return { kind: "not-shared", reason };
		}
	};

	if (!note.isSynced) {
		const synced = await settled(note.onceFreshlySynced(), SYNC_WAIT_MS, deps.sleep);
		const fresh = await recheck();
		if (fresh === "superseded") return { kind: "superseded" };
		if (fresh === "unknown") return keepAsCopy("recheck-failed");
		// Not synced: the Y.Doc is not the relay's text yet, so a diff against
		// it would be against a partial copy, and its next save to disk would
		// overwrite the outside text.
		if (!synced) return keepAsCopy("not-synced");
	}
	const outcome = await absorbExternalRewrite(
		note.crdtDoc,
		disk,
		before,
		deps.writeConflictCopy,
		EXTERNAL_REWRITE_ORIGIN,
		deps.log,
		recheck,
	);
	if (outcome.kind === "unconfirmed") return keepAsCopy("recheck-failed");
	if (outcome.kind !== "skipped" && outcome.kind !== "superseded") deps.writes.observe(path, disk, since);
	return outcome;
}
