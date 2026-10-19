/**
 * pure delay math for ProviderBacked's connection-error-triggered
 * reconnect. Extracted so it's testable without instantiating ProviderBacked
 * itself (ProviderBacked.ts imports AuthSession.ts -> pocketbase, ESM-only,
 * breaks ts-jest parsing — the same wall documented on several other
 * modules in this codebase; the established workaround is extracting the
 * pure logic into a dependency-free module and testing that).
 */

/**
 * How long to wait before the next connection-error-triggered reconnect
 * attempt, given when the last one fired and the minimum interval between
 * them. Never negative — if enough time has already elapsed, fire
 * immediately (delay 0).
 */
export function computeReconnectDelay(
	now: number,
	lastReconnectAt: number,
	minIntervalMs: number,
): number {
	const elapsed = now - lastReconnectAt;
	return Math.max(minIntervalMs - elapsed, 0);
}
