export interface WaitSummary {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

/** Count, p50, p95 and max of a list of durations in ms. */
export function summarise(samples: number[]): WaitSummary {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) =>
		sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
	return { count: sorted.length, p50: at(50), p95: at(95), max: sorted.length > 0 ? sorted[sorted.length - 1] : 0 };
}
