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

interface WriteRecord {
	text: string;
	previous?: string;
	previousUntil: number;
	/** Seen on disk after an outside change, not written by this app. */
	observed?: boolean;
}

/**
 * The text this app last wrote to each file, through the vault adapter.
 * Another program's write never passes through it, so a file whose text is
 * not here was changed from outside.
 */
export class AppWriteLog {
	private readonly writes = new Map<string, WriteRecord>();

	constructor(private readonly now: () => number) {}

	/**
	 * The file holds `text`, which this app did not write (an outside change
	 * just taken into the Y.Doc). It becomes the text "before" the next
	 * change, but neither it nor the previous write counts as this app's
	 * own: a quick A -> B -> A from outside must not read as an echo.
	 */
	observe(path: string, text: string): void {
		this.writes.set(path, { text, previousUntil: 0, observed: true });
	}

	/** This app wrote `text` to `path`. */
	record(path: string, text: string): void {
		const last = this.writes.get(path);
		if (last && last.text === text) return;
		this.writes.set(path, {
			text,
			previous: last?.observed ? undefined : last?.text,
			previousUntil: this.now() + PREVIOUS_WRITE_WINDOW_MS,
		});
	}

	/** The file's text as this app last left it, if known. */
	lastText(path: string): string | undefined {
		return this.writes.get(path)?.text;
	}

	/** Whether `text` is what this app itself last wrote to `path`. */
	isOwnWrite(path: string, text: string): boolean {
		const last = this.writes.get(path);
		if (!last || last.observed) return false;
		if (sameTextContent(last.text, text)) return true;
		return (
			last.previous !== undefined &&
			this.now() <= last.previousUntil &&
			sameTextContent(last.previous, text)
		);
	}

	forget(path: string): void {
		this.writes.delete(path);
	}

	rename(oldPath: string, newPath: string): void {
		const record = this.writes.get(oldPath);
		if (!record) return;
		this.writes.delete(oldPath);
		this.writes.set(newPath, record);
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
	/**
	 * The Y.Doc was left as it was: the conflict copy could not be written,
	 * or collaborators kept changing the note while copies were written.
	 */
	| { kind: "skipped"; reason: "copy-failed" | "kept-changing"; conflictPath?: string };

/** Conflict copies tried while collaborators keep editing, before giving up. */
export const COPY_ATTEMPTS = 3;

/** Line endings of `text` made to match the Y.Doc's, as an editor reload would. */
function alignLineEndings(text: string, current: string): string {
	return current.includes("\r") ? text : normalizeLineEndings(text);
}

/**
 * Put an outside rewrite of a note into its Y.Doc. `before` is the file's
 * text before the rewrite (what this app last wrote or loaded), if known.
 * `stillCurrent` reports whether `disk` is still the file's outside text; it
 * is asked after the conflict copy is written, the only wait in here.
 */
export async function absorbExternalRewrite(
	ydoc: Y.Doc,
	disk: string,
	before: string | undefined,
	writeConflictCopy: (content: string) => Promise<string>,
	origin: unknown,
	log: (...args: unknown[]) => void = () => {},
	stillCurrent: () => Promise<boolean> = async () => true,
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
		if (!(await stillCurrent())) return { kind: "superseded" };
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
	| ExternalRewriteOutcome
	/** The change is this app's own write. */
	| { kind: "own-write" }
	/** The file could not be read; the change is still on disk. */
	| { kind: "unreadable" }
	/** The note did not sync in time; the outside text was kept at `conflictPath`. */
	| { kind: "kept-as-copy"; conflictPath: string }
	/** The note did not sync in time and the copy failed: the outside text is on this device only. */
	| { kind: "not-shared" };

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
			return `Team Relay: "${path}" was changed by another program before it finished syncing, and the change could not be saved as a copy, so it was not shared. ${differs}`;
		case "kept-as-copy":
			return `Team Relay: "${path}" was changed by another program before it finished syncing. The changed version was saved as "${outcome.conflictPath}"; the shared note is unchanged.`;
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
 * Handle the vault "modify" of an editor-bound note. Capture `loadedText`,
 * the text the open editor last loaded or saved, synchronously in the event
 * (Obsidian only replaces it after its own asynchronous re-read).
 */
export async function onBoundNoteModified(
	path: string,
	note: BoundNote,
	loadedText: string | undefined,
	deps: ExternalRewriteDeps,
): Promise<BoundNoteOutcome> {
	const outcome = await handleBoundNoteModified(path, note, loadedText, deps);
	deps.log("outside rewrite of an open note", path, outcome.kind);
	const message = rewriteNotice(path, outcome);
	if (message !== null) deps.notify?.(message);
	return outcome;
}

async function handleBoundNoteModified(
	path: string,
	note: BoundNote,
	loadedText: string | undefined,
	deps: ExternalRewriteDeps,
): Promise<BoundNoteOutcome> {
	const before = deps.writes.lastText(path) ?? loadedText;
	const disk = await readWithRetry(deps);
	if (disk === null) return { kind: "unreadable" };
	if (deps.writes.isOwnWrite(path, disk)) return { kind: "own-write" };

	// Whether `disk` is still what another program left in the file. A
	// different text this app wrote meanwhile (its own disk sync) does not
	// replace it; a different outside text does, and has its own event.
	const stillCurrent = async (): Promise<boolean> => {
		const now = await readWithRetry(deps);
		return now === null || sameTextContent(now, disk) || deps.writes.isOwnWrite(path, now);
	};

	if (!note.isSynced) {
		if (!(await settled(note.onceFreshlySynced(), SYNC_WAIT_MS, deps.sleep))) {
			if (!(await stillCurrent())) return { kind: "superseded" };
			// The Y.Doc is not the relay's text yet, so a diff against it would be
			// against a partial copy, and its next save to disk would overwrite
			// the outside text. Keep that text where the user can find it.
			try {
				return { kind: "kept-as-copy", conflictPath: await deps.writeConflictCopy(disk) };
			} catch (e: unknown) {
				deps.log("outside rewrite of a note that did not sync; copy failed", path, e);
				return { kind: "not-shared" };
			}
		}
		if (!(await stillCurrent())) return { kind: "superseded" };
	}
	const outcome = await absorbExternalRewrite(
		note.crdtDoc,
		disk,
		before,
		deps.writeConflictCopy,
		EXTERNAL_REWRITE_ORIGIN,
		deps.log,
		stillCurrent,
	);
	if (outcome.kind !== "skipped" && outcome.kind !== "superseded") deps.writes.observe(path, disk);
	return outcome;
}
