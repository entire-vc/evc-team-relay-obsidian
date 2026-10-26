/** Transport failures that should pause an inbound synchronization batch. */
export class RelayHttpError extends Error {
	/** Server-requested delay from a Retry-After header, in ms, if one was sent. */
	constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
		super(message);
		this.name = "RelayHttpError";
	}
}

export function isTransientRelayFailure(error: unknown): boolean {
	if (error instanceof RelayHttpError) return error.status === 429 || (error.status >= 500 && error.status < 600);
	if (typeof error === "object" && error !== null && "code" in error &&
		typeof error.code === "string" &&
		["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(error.code)) return true;
	return error instanceof Error &&
		/(timeout|timed out|ETIMEDOUT|network error|net::ERR_|GOAWAY|RST_STREAM)/i.test(error.message);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined for a missing or unparseable value, so callers fall back
 * to their own backoff instead of retrying immediately.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, date - now);
}
