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
 */

import type * as Y from "yjs";
import { hasPreservableContent, normalizeLineEndings, sameTextContent } from "./textEquivalence";
import { applyDiffToYText, reconcileWithConflictCopy } from "./ytextDiff";

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
	/** The conflict copy could not be written, so the Y.Doc was left as it was. */
	| { kind: "skipped" };

/** Line endings of `text` made to match the Y.Doc's, as an editor reload would. */
function alignLineEndings(text: string, current: string): string {
	return current.includes("\r") ? text : normalizeLineEndings(text);
}

/**
 * Put an outside rewrite of a note into its Y.Doc. `before` is the file's
 * text before the rewrite (what this app last wrote or loaded), if known.
 */
export async function absorbExternalRewrite(
	ydoc: Y.Doc,
	disk: string,
	before: string | undefined,
	writeConflictCopy: (content: string) => Promise<string>,
	origin: unknown,
	log: (...args: unknown[]) => void = () => {},
): Promise<ExternalRewriteOutcome> {
	const current = ydoc.getText("contents").toJSON();
	if (sameTextContent(current, disk)) return { kind: "in-sync" };
	const incoming = alignLineEndings(disk, current);
	if (
		!hasPreservableContent(current) ||
		(before !== undefined && sameTextContent(current, before))
	) {
		applyDiffToYText(ydoc, incoming, origin);
		return { kind: "merged" };
	}
	const result = await reconcileWithConflictCopy(ydoc, incoming, writeConflictCopy, origin, log);
	if (!result.reconciled) return { kind: "skipped" };
	return result.conflictPath !== undefined
		? { kind: "merged-with-copy", conflictPath: result.conflictPath }
		: { kind: "merged" };
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
}

export type BoundNoteOutcome =
	| ExternalRewriteOutcome
	/** The change is this app's own write. */
	| { kind: "own-write" }
	/** The file could not be read; the change is still on disk. */
	| { kind: "unreadable" }
	/** The note did not sync in time; the outside text was kept at `conflictPath`. */
	| { kind: "kept-as-copy"; conflictPath: string };

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
 * Handle the vault "modify" of an editor-bound note. Call it synchronously
 * from the event with `loadedText`, the text the open editor last loaded or
 * saved (Obsidian only replaces it after its own asynchronous re-read).
 */
export async function onBoundNoteModified(
	path: string,
	note: BoundNote,
	loadedText: string | undefined,
	deps: ExternalRewriteDeps,
): Promise<BoundNoteOutcome> {
	const before = deps.writes.lastText(path) ?? loadedText;
	const disk = await readWithRetry(deps);
	if (disk === null) return { kind: "unreadable" };
	if (deps.writes.isOwnWrite(path, disk)) return { kind: "own-write" };
	if (!note.isSynced && !(await settled(note.onceFreshlySynced(), SYNC_WAIT_MS, deps.sleep))) {
		// The Y.Doc is not the relay's text yet, so a diff against it would be
		// against a partial copy, and its next save to disk would overwrite
		// the outside text. Keep that text where the user can find it.
		try {
			const conflictPath = await deps.writeConflictCopy(disk);
			deps.log("outside rewrite of a note that did not sync; kept as", path, conflictPath);
			return { kind: "kept-as-copy", conflictPath };
		} catch (e: unknown) {
			deps.log("outside rewrite of a note that did not sync; copy failed", path, e);
			return { kind: "skipped" };
		}
	}
	const outcome = await absorbExternalRewrite(
		note.crdtDoc,
		disk,
		before,
		deps.writeConflictCopy,
		EXTERNAL_REWRITE_ORIGIN,
		deps.log,
	);
	if (outcome.kind !== "skipped") deps.writes.observe(path, disk);
	deps.log("outside rewrite of an open note", path, outcome.kind);
	return outcome;
}
