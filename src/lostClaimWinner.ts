/**
 * Pure decision logic for a client that LOST the upload claim on a vpath
 * (VaultShare._reconcileLostUploadClaim): what to do with its own local file
 * once the winner's document has synced in.
 *
 * The winner's guid reaches the relay before its text does: publishing the
 * vpath is one meta write, uploading the text is a separate job in the
 * winner's upload lane, which can sit behind hundreds of other uploads. A
 * synced-but-still-empty winner document therefore means "content not here
 * yet", not "the winner's file is empty". Two clients that both received the
 * same file from the server's files index (the HTTP inbound sync) race to
 * publish it; if the loser compared against the empty placeholder, it saved
 * its own copy, which is identical to the original, as an "upload race" file
 * that then synced to every member.
 *
 * Extracted dependency-free for the same reason as preserveBeforeTrash.ts:
 * VaultShare.ts transitively imports ESM-only packages ts-jest can't parse.
 */

export type LostClaimAction =
	/** Local file already matches the winner: nothing to do. */
	| "keep"
	/** Winner's text hasn't arrived: leave the local file alone, no copy. */
	| "await-winner"
	/** Winner has real, different content: preserve ours, adopt theirs. */
	| "preserve-and-adopt";

export function lostClaimAction<S>(
	localContent: string,
	winner: S,
	diverged: (local: string, winner: S) => boolean,
	winnerEmpty: (winner: S) => boolean,
): LostClaimAction {
	if (!diverged(localContent, winner)) {
		return "keep";
	}
	if (winnerEmpty(winner)) {
		return "await-winner";
	}
	return "preserve-and-adopt";
}

/**
 * How long a loser waits for the winner's text. Long on purpose: an initial
 * sync of a large folder puts hundreds of uploads ahead of it in the winner's
 * lane, and giving up early only means the file is never reconciled.
 */
export const LOST_CLAIM_WINNER_WAIT_MS = 15 * 60_000;

export interface WinnerContentWait<S> {
	/** Current winner content, read from the synced CRDT. */
	read: () => S;
	isEmpty: (winner: S) => boolean;
	/** Calls `onChange` on every CRDT update; returns the unsubscribe. */
	subscribe: (onChange: () => void) => () => void;
	maxWaitMs: number;
	scheduleTimeout?: (fn: () => void, ms: number) => unknown;
	cancelTimeout?: (handle: unknown) => void;
}

/**
 * Resolves with the winner's content as soon as it is non-empty, or with the
 * last (empty) read once `maxWaitMs` elapses. Event-driven rather than
 * polled: the winner's upload lane can be hundreds of files deep, so the
 * wait has to be long, and many lost claims can be waiting at once.
 */
export function awaitWinnerContent<S>(wait: WinnerContentWait<S>): Promise<S> {
	const {
		read,
		isEmpty,
		subscribe,
		maxWaitMs,
		scheduleTimeout = (fn, ms) => window.setTimeout(fn, ms),
		cancelTimeout = (handle) => window.clearTimeout(handle as number),
	} = wait;
	const first = read();
	if (!isEmpty(first)) return Promise.resolve(first);
	return new Promise<S>((resolve) => {
		let done = false;
		const finish = (winner: S) => {
			if (done) return;
			done = true;
			cancelTimeout(timer);
			unsubscribe();
			resolve(winner);
		};
		const unsubscribe = subscribe(() => {
			const winner = read();
			if (!isEmpty(winner)) finish(winner);
		});
		const timer = scheduleTimeout(() => finish(read()), maxWaitMs);
	});
}

export interface LostClaimSettle<S> extends WinnerContentWait<S> {
	/** Reads the local vault file. Called only AFTER the wait. */
	readLocal: () => Promise<string>;
	diverged: (local: string, winner: S) => boolean;
	/** Saves `local` as a conflict copy, then writes the winner's content. */
	preserveAndAdopt: (local: string) => Promise<void>;
	/** False once the entry or its share has been torn down. */
	isAlive: () => boolean;
}

/**
 * Waits for the winner's content, then decides against the local file as it
 * is at that moment: an edit the user made during the wait is what gets
 * preserved, never a snapshot taken before it.
 */
export async function settleLostClaim<S>(
	settle: LostClaimSettle<S>,
): Promise<LostClaimAction | "gone"> {
	const winner = await awaitWinnerContent(settle);
	if (!settle.isAlive()) return "gone";
	const local = await settle.readLocal();
	if (!settle.isAlive()) return "gone";
	const action = lostClaimAction(local, winner, settle.diverged, settle.isEmpty);
	if (action === "preserve-and-adopt") {
		await settle.preserveAndAdopt(local);
	}
	return action;
}

/**
 * Runs lost-claim settles detached from the caller, at most one per key.
 * VaultShare.adoptLocalFiles resolves files one after another, so a settle
 * awaited inline would hold every following file for as long as the
 * winner's text takes to arrive.
 */
export class LostClaimSettler {
	private readonly pending = new Set<string>();

	constructor(private readonly onError: (key: string, e: unknown) => void) {}

	/** Starts a settle for `key` unless one is running; never waits for it. */
	start(key: string, run: () => Promise<unknown>): boolean {
		if (this.pending.has(key)) return false;
		this.pending.add(key);
		void run()
			.catch((e: unknown) => this.onError(key, e))
			.finally(() => this.pending.delete(key));
		return true;
	}

	isPending(key: string): boolean {
		return this.pending.has(key);
	}
}
