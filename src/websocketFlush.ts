/**
 * Waiting for a reconcile update to actually leave the local send buffer
 * before an intentional disconnect proceeds.
 *
 * TransferQueue used to wait on a fixed 1000ms timer after writing a
 * reconcile update to the Y.Doc, hoping that was enough time
 * for the WebSocket to hand the bytes off to the network before
 * disconnecting. On a slow link or with a large diff, the update can still
 * be queued in the socket's outgoing buffer well past a fixed 1000ms —
 * disconnecting at that point drops it silently.
 *
 * The Yjs sync protocol used here has no per-update delivery ack (only the
 * initial sync handshake reports "synced"), so the best available in-protocol
 * signal is `WebSocket.bufferedAmount`: it tracks bytes queued but not yet
 * handed off to the network, and only reaches 0 once everything written so
 * far has actually left the local buffer. That's not a server-side ack that
 * the relay *received* the update, but it directly scales with diff size and
 * link speed — which a fixed timer cannot — so it replaces the guess with a
 * real, measurable signal.
 */

export interface BufferedAmountSource {
	readonly bufferedAmount: number;
}

export interface WaitForBufferFlushOptions {
	/** Safety fallback so a stuck/closed socket can't hang the caller forever. */
	maxWaitMs?: number;
	pollIntervalMs?: number;
	/** Injectable for tests; defaults to a real timer-based sleep. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests; defaults to Date.now. */
	now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Poll `socket.bufferedAmount` until it drains to 0 (everything written so
 * far has left the local send buffer) or `maxWaitMs` elapses, whichever
 * comes first. A null/undefined socket (not connected) is a no-op — there is
 * nothing to flush.
 */
export async function waitForBufferFlush(
	socket: BufferedAmountSource | null | undefined,
	options: WaitForBufferFlushOptions = {},
): Promise<void> {
	if (!socket) {
		return;
	}

	const {
		maxWaitMs = 10_000,
		pollIntervalMs = 50,
		sleep = defaultSleep,
		now = Date.now,
	} = options;

	const deadline = now() + maxWaitMs;
	while (socket.bufferedAmount > 0 && now() < deadline) {
		await sleep(pollIntervalMs);
	}
}
