/**
 * Which relay-token requests may wait: documents fetched or uploaded in the
 * background (an import, a sweep pull) yield their place in the
 * TokenRequestThrottle queue to everyone else (edits, announced changes,
 * open documents).
 *
 * Measured on the 0.1.18 stand: both clients sat at the 120/min ceiling with
 * bulk traffic, the queue was FIFO, and the relay probe waited up to 28s to
 * connect while the control plane answered every token in under a second.
 *
 * Kept by document id (the `doc_id` of the token request), so the background
 * holders (TransferQueue, the poller) need not thread it through the
 * credential cache. The throttle reads it when a request is queued. A
 * document is background while at least one background holder has it.
 */

import { summarise, type WaitSummary } from "../waitSummary";

const holds = new Map<string, number>();

export type TokenRequestClass = "normal" | "background";

/** Marks `docId`'s token requests as background until the returned release runs. */
export function holdBackgroundTokens(docId: string): () => void {
	holds.set(docId, (holds.get(docId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (holds.get(docId) ?? 1) - 1;
		if (left > 0) holds.set(docId, left);
		else holds.delete(docId);
	};
}

export function tokenRequestClass(docId: string | undefined): TokenRequestClass {
	return docId !== undefined && holds.has(docId) ? "background" : "normal";
}

const WAIT_SAMPLES = 200;
const waits: Record<TokenRequestClass, number[]> = { normal: [], background: [] };

/** How long a request of `cls` waited in the throttle queue. */
export function recordTokenWait(cls: TokenRequestClass, ms: number): void {
	const samples = waits[cls];
	samples.push(ms);
	if (samples.length > WAIT_SAMPLES) samples.shift();
}

export type TokenWaitSummary = WaitSummary;

/** Recent throttle waits per class, plus how many documents are background now. */
export function tokenWaitStats(): { normal: TokenWaitSummary; background: TokenWaitSummary; backgroundDocs: number } {
	return { normal: summarise(waits.normal), background: summarise(waits.background), backgroundDocs: holds.size };
}

/** Test hook: forget every hold and sample. */
export function resetTokenRequestClasses(): void {
	holds.clear();
	waits.normal = [];
	waits.background = [];
}
