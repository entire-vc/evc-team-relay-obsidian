/**
 * Per-share backoff for relay tokens the control plane refuses outright
 * (401, or 403 even for read). Such a refusal does not heal by itself, so a
 * share in this state is asked again after 1, 2, 4 ... minutes, capped at 30,
 * instead of on the reconnect floor. Cleared by a successful token for the
 * share, a sign-in/refresh, or a manual reconnect.
 */

const FIRST_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 60_000;

export function accessDeniedDelayMs(failures: number): number {
	const exp = Math.max(0, failures - 1);
	return Math.min(FIRST_DELAY_MS * 2 ** Math.min(exp, 16), MAX_DELAY_MS);
}

interface DeniedEntry {
	failures: number;
	retryAt: number;
}

export class AccessDeniedBackoff {
	private entries = new Map<string, DeniedEntry>();

	/** Record a refusal; returns the time before which the share is not asked again. */
	recordDenied(shareId: string, now: number): number {
		const existing = this.entries.get(shareId);
		// Requests that were already in flight when the share was refused
		// belong to the same window and do not lengthen it.
		if (existing && now < existing.retryAt) return existing.retryAt;
		const failures = (existing?.failures ?? 0) + 1;
		const retryAt = now + accessDeniedDelayMs(failures);
		this.entries.set(shareId, { failures, retryAt });
		return retryAt;
	}

	/** Pending retry time while the share is backed off, else undefined. */
	retryAt(shareId: string, now: number): number | undefined {
		const entry = this.entries.get(shareId);
		return entry && now < entry.retryAt ? entry.retryAt : undefined;
	}

	isDenied(shareId: string): boolean {
		return this.entries.has(shareId);
	}

	clear(shareId?: string): void {
		if (shareId === undefined) {
			this.entries.clear();
		} else {
			this.entries.delete(shareId);
		}
	}
}
