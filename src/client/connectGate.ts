/**
 * Lets one WebSocket handshake per server be in progress at a time, and picks
 * the next one by class: sockets for documents in use (an edit, an announced
 * change, an open note) go before background ones (an import, a sweep pull).
 *
 * The browser already allows only one handshake per server endpoint at a
 * time (RFC 6455 section 4.1) and serves the rest first come, first served.
 * Measured on the 0.1.20 stand under an 800+ document import: the relay probe
 * spent 10-27 s between `new WebSocket()` and open, its token and socket
 * creation took 0 ms, and the server saw the request only at the end of that
 * wait. Queueing here instead keeps that order in our hands.
 *
 * A handshake that has not finished within handshakeTimeoutMs() gives up its
 * place; the caller closes the socket and retries through its usual backoff.
 */

import { summarise, type WaitSummary } from "../waitSummary";

export type ConnectClass = "normal" | "background";

export const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Once this many handshakes have opened, the timeout follows them: a few times
 * their p95, within MIN_HANDSHAKE_TIMEOUT_MS..HANDSHAKE_TIMEOUT_MS. On the
 * 0.1.21 stand handshakes opened in at most 553 ms, but 30 that never reached
 * the relay each held the queue for the full 10 s, which was the edits' wait.
 */
export const ADAPTIVE_HANDSHAKE_SAMPLES = 20;
/**
 * Only opened handshakes are sampled, so on a link that turns slow the timeout
 * lags behind; this floor keeps one such first attempt from being cut short.
 */
export const MIN_HANDSHAKE_TIMEOUT_MS = 4_000;
const HANDSHAKE_P95_FACTOR = 4;
/** The timeout doubles after each timeout in a row, up to this, for slow links. */
export const MAX_HANDSHAKE_TIMEOUT_MS = 60_000;

export interface ConnectTicket {
	/** Frees the slot, or leaves the queue if not started yet. Idempotent. */
	release(): void;
	readonly released: boolean;
}

interface Waiter {
	/** Read at each dispatch: a document can come into use while it waits. */
	classify: () => ConnectClass;
	queuedAt: number;
	start: () => void;
	released: boolean;
}

interface Endpoint {
	busy: Waiter | null;
	queue: Waiter[];
}

const endpoints = new Map<string, Endpoint>();

const SAMPLES = 200;
const waits: Record<ConnectClass, number[]> = { normal: [], background: [] };
const handshakes: number[] = [];
let timeouts = 0;

function record(samples: number[], ms: number): void {
	samples.push(ms);
	if (samples.length > SAMPLES) samples.shift();
}

/** The endpoint a socket url belongs to: scheme, host and port. */
export function connectEndpoint(socketUrl: string): string {
	const match = /^(wss?:\/\/[^/?#]+)/i.exec(socketUrl);
	return match ? match[1].toLowerCase() : socketUrl;
}

function dispatch(key: string, endpoint: Endpoint): void {
	if (endpoint.busy !== null) return;
	for (;;) {
		const at = endpoint.queue.findIndex((w) => w.classify() === "normal");
		const [next] = endpoint.queue.splice(at === -1 ? 0 : at, 1);
		if (next === undefined) {
			endpoints.delete(key);
			return;
		}
		endpoint.busy = next;
		record(waits[at === -1 ? "background" : "normal"], Date.now() - next.queuedAt);
		try {
			next.start();
			return;
		} catch (error) {
			// The caller failed to start (a socket constructor throwing): never
			// leave the endpoint held by it, move on to the next one.
			next.released = true;
			endpoint.busy = null;
			console.error("[connectGate] a queued connection failed to start", error);
		}
	}
}

/**
 * Queues a handshake for `socketUrl`. `start` runs (synchronously when the
 * endpoint is free) once it is this one's turn; release the ticket when the
 * socket opens, closes, or is abandoned.
 */
export function enqueueConnect(
	socketUrl: string,
	classify: () => ConnectClass,
	start: (ticket: ConnectTicket) => void,
): ConnectTicket {
	const key = connectEndpoint(socketUrl);
	let endpoint = endpoints.get(key);
	if (endpoint === undefined) {
		endpoint = { busy: null, queue: [] };
		endpoints.set(key, endpoint);
	}
	const own = endpoint;
	const ticket: ConnectTicket = {
		get released() {
			return waiter.released;
		},
		release() {
			if (waiter.released) return;
			waiter.released = true;
			if (own.busy === waiter) {
				own.busy = null;
				dispatch(key, own);
			} else {
				const at = own.queue.indexOf(waiter);
				if (at !== -1) own.queue.splice(at, 1);
				if (own.busy === null && own.queue.length === 0) endpoints.delete(key);
			}
		},
	};
	const waiter: Waiter = { classify, queuedAt: Date.now(), start: () => start(ticket), released: false };
	own.queue.push(waiter);
	dispatch(key, own);
	return ticket;
}

/** A handshake that opened, `ms` after it was started. */
export function recordHandshake(ms: number): void {
	record(handshakes, ms);
}

/** How long a handshake may take before it gives up its place. */
export function handshakeTimeoutMs(): number {
	if (handshakes.length < ADAPTIVE_HANDSHAKE_SAMPLES) return HANDSHAKE_TIMEOUT_MS;
	const scaled = HANDSHAKE_P95_FACTOR * summarise(handshakes).p95;
	return Math.min(HANDSHAKE_TIMEOUT_MS, Math.max(MIN_HANDSHAKE_TIMEOUT_MS, scaled));
}

/** A handshake abandoned after handshakeTimeoutMs(). */
export function recordHandshakeTimeout(): void {
	timeouts++;
}

export interface ConnectGateStats {
	/** Time spent waiting for a turn, per class. */
	wait: Record<ConnectClass, WaitSummary>;
	/** Time from start to open. */
	handshake: WaitSummary;
	timeouts: number;
	/** The current handshake timeout, before a provider's own doubling. */
	timeoutMs: number;
	/** Handshakes waiting for a turn right now, over all servers. */
	waiting: number;
}

export function connectGateStats(): ConnectGateStats {
	let waiting = 0;
	for (const endpoint of endpoints.values()) waiting += endpoint.queue.length;
	return {
		wait: { normal: summarise(waits.normal), background: summarise(waits.background) },
		handshake: summarise(handshakes),
		timeouts,
		timeoutMs: handshakeTimeoutMs(),
		waiting,
	};
}

/** Test hook: forget every queue and sample. */
export function resetConnectGate(): void {
	endpoints.clear();
	waits.normal = [];
	waits.background = [];
	handshakes.length = 0;
	timeouts = 0;
}
