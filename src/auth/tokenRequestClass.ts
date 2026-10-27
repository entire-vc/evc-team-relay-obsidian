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
 * Kept by document id (the `doc_id` of the token request) rather than passed
 * along with the request: the request is shared by everyone who asks for the
 * same document while it is in flight, so its class is read at dispatch time.
 * A document is background while at least one background holder has it.
 */

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

export interface TokenWaitSummary {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

function summarise(samples: number[]): TokenWaitSummary {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) =>
		sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
	return { count: sorted.length, p50: at(50), p95: at(95), max: sorted.length > 0 ? sorted[sorted.length - 1] : 0 };
}

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
