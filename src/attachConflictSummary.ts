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
 * transfer queue long after the folder is adopted. So a batch is reported
 * once no new copy arrived for `quietMs`, and collection stops `windowMs`
 * after the first sync began. Copies written after that are left to the
 * ordinary sync passes, which this module does not touch.
 */

/** Labels of copies that hold one side of a local/server divergence. */
const DIVERGENCE_LABEL = /^(?:relay conflict|upload race)\b/;

/** Copies listed by name before the rest is folded into "+K more". */
export const ATTACH_SUMMARY_MAX_NAMES = 10;
/** A batch is reported once no new copy arrived for this long. */
export const ATTACH_SUMMARY_QUIET_MS = 5000;
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
		this.quietTimer = this.timers.set(() => this.flush(), this.quietMs);
		return true;
	}

	/** Shows the pending batch, if any, as one notice. */
	flush(): void {
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

	/** Ends the window: reports what is pending and stops collecting. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.timers.clear(this.windowTimer);
		this.flush();
	}
}
