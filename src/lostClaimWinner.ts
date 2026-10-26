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

export interface AwaitWinnerContentOptions {
	maxWaitMs?: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Re-reads the winner's content until it is non-empty or `maxWaitMs`
 * elapses, and returns the last read. Covers the common case where the
 * winner uploads its text within seconds of publishing the guid; a winner
 * with a long upload backlog times out here and the caller leaves the local
 * file for the ordinary background pull to settle.
 */
export async function awaitWinnerContent<S>(
	read: () => S,
	isEmpty: (winner: S) => boolean,
	options: AwaitWinnerContentOptions = {},
): Promise<S> {
	const { maxWaitMs = 10_000, pollMs = 250, sleep = defaultSleep, now = Date.now } = options;
	const deadline = now() + maxWaitMs;
	let winner = read();
	while (isEmpty(winner) && now() < deadline) {
		await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
		winner = read();
	}
	return winner;
}
