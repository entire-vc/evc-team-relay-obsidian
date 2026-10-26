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

export interface WinnerContentWait<S> {
	/** Current winner content, read from the synced CRDT. */
	read: () => S;
	isEmpty: (winner: S) => boolean;
	/**
	 * Calls `onChange` on every CRDT update and `onGone` when the doc is
	 * destroyed; returns the unsubscribe.
	 */
	subscribe: (onChange: () => void, onGone: () => void) => () => void;
	/** Aborted when the share is torn down. */
	signal: AbortSignal;
}

/**
 * Resolves with the winner's content as soon as it is non-empty, or with
 * `undefined` once the doc or its share is torn down. No deadline: the
 * winner's upload lane can be hundreds of files deep, and the background
 * pull never settles this file instead (the doc is online, and it has no
 * sync base), so giving up would leave it unreconciled for good. Event-driven
 * rather than polled, so many waiting claims cost nothing between updates.
 */
export function awaitWinnerContent<S>(wait: WinnerContentWait<S>): Promise<S | undefined> {
	const { read, isEmpty, subscribe, signal } = wait;
	if (signal.aborted) return Promise.resolve(undefined);
	const first = read();
	if (!isEmpty(first)) return Promise.resolve(first);
	return new Promise<S | undefined>((resolve) => {
		let done = false;
		const finish = (winner: S | undefined) => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
			resolve(winner);
		};
		const onAbort = () => finish(undefined);
		const unsubscribe = subscribe(
			() => {
				const winner = read();
				if (!isEmpty(winner)) finish(winner);
			},
			onAbort,
		);
		signal.addEventListener("abort", onAbort);
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
	// Started after the doc or share went away: subscribing to a destroyed
	// doc would wait forever, its "destroy" has already fired.
	if (!settle.isAlive()) return "gone";
	const winner = await awaitWinnerContent(settle);
	if (winner === undefined || !settle.isAlive()) return "gone";
	const local = await settle.readLocal();
	if (!settle.isAlive()) return "gone";
	const action = lostClaimAction(local, winner, settle.diverged, settle.isEmpty);
	if (action === "preserve-and-adopt") {
		await settle.preserveAndAdopt(local);
	}
	return action;
}

/**
 * Preserves the loser's text as a conflict copy, then overwrites the original
 * with the winner's. Returns the copy's path, or `undefined` when the share
 * was torn down while the copy was being written: ours is safe in the copy,
 * and a gone share must not write the original any more.
 */
export async function preserveThenAdopt(steps: {
	writeCopy: () => Promise<string>;
	writeOriginal: () => Promise<void>;
	isAlive: () => boolean;
}): Promise<string | undefined> {
	const copyPath = await steps.writeCopy();
	if (!steps.isAlive()) return undefined;
	await steps.writeOriginal();
	return copyPath;
}

/**
 * Runs lost-claim settles detached from the caller, at most one per key.
 * VaultShare.adoptLocalFiles resolves files one after another, so a settle
 * awaited inline would hold every following file for as long as the
 * winner's text takes to arrive.
 */
export class LostClaimSettler {
	private readonly pending = new Map<string, AbortController>();
	private closed = false;

	constructor(private readonly onError: (key: string, e: unknown) => void) {}

	/**
	 * Starts a settle for `key` unless one is running or the settler was
	 * cancelled; never waits for it.
	 */
	start(key: string, run: (signal: AbortSignal) => Promise<unknown>): boolean {
		if (this.closed || this.pending.has(key)) return false;
		const controller = new AbortController();
		this.pending.set(key, controller);
		void run(controller.signal)
			.catch((e: unknown) => this.onError(key, e))
			.finally(() => {
				if (this.pending.get(key) === controller) this.pending.delete(key);
			});
		return true;
	}

	isPending(key: string): boolean {
		return this.pending.has(key);
	}

	/**
	 * Ends every waiting settle and refuses new ones (the share is being torn
	 * down); none of them writes anything afterwards.
	 */
	cancelAll(): void {
		this.closed = true;
		for (const controller of this.pending.values()) controller.abort();
		this.pending.clear();
	}
}
