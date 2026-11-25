/**
 * One summary notice for the conflict copies a folder's first sync creates.
 *
 * Attaching a local folder to a share that already holds diverged copies of
 * the same files keeps both sides of every differing file: the server text
 * stays in the note and the other side goes to a "(relay conflict ...)"
 * copy (see VaultShare.writeConflictCopy). That protection stays as it is.
 * What the user lacked was any explanation: a dozen new files and no word
 * about where they came from. While a folder syncs for the first time on
 * this device, the copies are collected here and reported in one notice:
 * how many files differed and which copies were created.
 *
 * The first sync is not one awaitable operation: uploads run through the
 * transfer queue long after the folder is adopted. So the summary is shown
 * once no new copy arrived for `quietMs`, or `windowMs` after the first sync
 * began, whichever comes first. That ends the collection: one first sync,
 * at most one notice. Copies written after it are left to the ordinary sync
 * passes, which this module does not touch.
 */

/** Labels of copies that hold one side of a local/server divergence. */
const DIVERGENCE_LABEL = /^(?:relay conflict|upload race)\b/;

/** Copies listed by name before the rest is folded into "+K more". */
export const ATTACH_SUMMARY_MAX_NAMES = 10;
/** The summary is shown once no new copy arrived for this long. */
export const ATTACH_SUMMARY_QUIET_MS = 10000;
/** Collection stops this long after the first sync began. */
export const ATTACH_SUMMARY_WINDOW_MS = 10 * 60 * 1000;
/** How long the summary notice stays on screen. */
export const ATTACH_SUMMARY_NOTICE_MS = 20000;

/**
 * Does a conflict-copy label mean local and server text differed? The copies
 * a linked delete preserves ("relay deleted ...") do not, and are not
 * summarised.
 */
export function isDivergenceCopyLabel(label: string): boolean {
	return DIVERGENCE_LABEL.test(label);
}

/**
 * The summary text: how many files differed and the copies, the first
 * `maxNames` by name and the rest as "+K more".
 */
export function formatAttachConflictSummary(
	folderName: string,
	differedFiles: number,
	copies: readonly string[],
	maxNames: number = ATTACH_SUMMARY_MAX_NAMES,
): string {
	const files = differedFiles === 1 ? "1 file" : `${differedFiles} files`;
	const shown = copies.slice(0, maxNames);
	const more = copies.length - shown.length;
	const names = more > 0 ? [...shown, `+${more} more`] : shown;
	const where = folderName ? ` (${folderName})` : "";
	return (
		`Team Relay${where}: ${files} differed between local and server; ` +
		`conflict copies created: ${names.join(", ")}`
	);
}

export interface SummaryTimers {
	set(callback: () => void, ms: number): number;
	clear(id: number): void;
}

const windowTimers: SummaryTimers = {
	set: (callback, ms) => window.setTimeout(callback, ms),
	clear: (id) => window.clearTimeout(id),
};

export interface AttachConflictSummaryOptions {
	quietMs?: number;
	windowMs?: number;
	maxNames?: number;
	timers?: SummaryTimers;
}

export class AttachConflictSummary {
	private readonly copies: string[] = [];
	private readonly originals = new Set<string>();
	private closed = false;
	private quietTimer: number | undefined;
	private readonly windowTimer: number;
	private readonly quietMs: number;
	private readonly maxNames: number;
	private readonly timers: SummaryTimers;

	constructor(
		private readonly folderName: string,
		private readonly show: (message: string) => void,
		options: AttachConflictSummaryOptions = {},
	) {
		this.quietMs = options.quietMs ?? ATTACH_SUMMARY_QUIET_MS;
		this.maxNames = options.maxNames ?? ATTACH_SUMMARY_MAX_NAMES;
		this.timers = options.timers ?? windowTimers;
		this.windowTimer = this.timers.set(
			() => this.close(),
			options.windowMs ?? ATTACH_SUMMARY_WINDOW_MS,
		);
	}

	/** Still collecting: the first sync's window has not ended. */
	get isOpen(): boolean {
		return !this.closed;
	}

	/**
	 * Takes a copy written during the first sync. Returns false once the
	 * window has ended; the copy is then left to the ordinary sync passes.
	 */
	record(originalPath: string, copyPath: string): boolean {
		if (this.closed) return false;
		this.originals.add(originalPath);
		this.copies.push(copyPath);
		if (this.quietTimer !== undefined) this.timers.clear(this.quietTimer);
		this.quietTimer = this.timers.set(() => this.close(), this.quietMs);
		return true;
	}

	/** Shows what was collected, if anything, as one notice. */
	private report(): void {
		if (this.quietTimer !== undefined) {
			this.timers.clear(this.quietTimer);
			this.quietTimer = undefined;
		}
		if (this.copies.length === 0) return;
		const message = formatAttachConflictSummary(
			this.folderName,
			this.originals.size,
			this.copies,
			this.maxNames,
		);
		this.copies.length = 0;
		this.originals.clear();
		this.show(message);
	}

	/** Ends the collection: shows the one summary, if any copy was taken. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.timers.clear(this.windowTimer);
		this.report();
	}
}

/** What the attach check (attachReview.ts) did, for its one summary notice. */
export interface AttachChoiceSummaryInput {
	choice: "keep-both" | "keep-server" | "keep-local";
	/** Notes that differed between local and server. */
	differed: number;
	/** Local copies written next to the notes (keep both). */
	copies: readonly string[];
	/** Where keep server / keep local saved the overwritten side. */
	backupFolder: string;
	/** Notes left unchanged because their copy could not be saved. */
	unresolved: readonly string[];
}

function listNames(names: readonly string[], maxNames: number): string {
	const shown = names.slice(0, maxNames);
	const more = names.length - shown.length;
	return (more > 0 ? [...shown, `+${more} more`] : shown).join(", ");
}

/**
 * The one notice after the user chose how to attach a folder whose notes
 * differed from the server: how many differed, what was kept, where the
 * other side went, and which notes were left as they were.
 */
export function formatAttachChoiceSummary(
	folderName: string,
	input: AttachChoiceSummaryInput,
	maxNames: number = ATTACH_SUMMARY_MAX_NAMES,
): string {
	const files = input.differed === 1 ? "1 file" : `${input.differed} files`;
	const where = folderName ? ` (${folderName})` : "";
	if (input.unresolved.length >= input.differed) {
		// Nothing was applied: do not claim a version was kept or saved.
		return `Team Relay${where}: ${files} differed between local and server; not changed, the copy could not be saved: ${listNames(input.unresolved, maxNames)}`;
	}
	let kept: string;
	if (input.choice === "keep-both") {
		kept =
			input.copies.length > 0
				? `kept the server version; local copies created: ${listNames(input.copies, maxNames)}`
				: "kept the server version";
	} else if (input.choice === "keep-server") {
		kept = `kept the server version; local versions saved to ${input.backupFolder}`;
	} else {
		kept = `kept the local version; server versions saved to ${input.backupFolder}`;
	}
	const left =
		input.unresolved.length > 0
			? `. Not changed, the copy could not be saved: ${listNames(input.unresolved, maxNames)}`
			: "";
	return `Team Relay${where}: ${files} differed between local and server; ${kept}${left}`;
}
