/** Transport failures that should pause an inbound synchronization batch. */
export class RelayHttpError extends Error {
	constructor(readonly status: number, message: string) {
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
