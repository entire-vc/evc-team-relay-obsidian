/**
 * Tests for 's ProviderBacked reconnect throttle math.
 *
 * Found during independent review: ProviderBacked.ts's connection-error
 * handler used to call connect() with zero delay, implicitly bounded by
 * the same wsUnsuccessfulReconnects/maxConnectionErrors counter that
 * capped provider.ts's OWN backoff loop at 3 attempts. Once that counter
 * was uncapped ('s main fix), this handler had NO throttle left at
 * all — a fast-failing connection (DNS refusal, immediate rejection)
 * could call connect() in a tight, un-backed-off loop forever. This
 * throttle restores a floor: never fire more than once per
 * maxBackoffTime.
 */

import { describe, test, expect } from "@jest/globals";
import { computeReconnectDelay } from "../src/reconnectThrottle";

describe("computeReconnectDelay", () => {
	test("fires immediately if the last reconnect was long enough ago", () => {
		expect(computeReconnectDelay(10_000, 0, 2500)).toBe(0);
	});

	test("fires immediately if this is the very first reconnect", () => {
		// lastReconnectAt=0 is the sentinel for "never fired yet" — in the
		// real caller `now` is always Date.now() (a large real timestamp),
		// so elapsed since epoch is always far past any realistic interval.
		expect(computeReconnectDelay(Date.now(), 0, 2500)).toBe(0);
	});

	test("waits out the remainder of the interval if called too soon", () => {
		// last fired at t=1000, now is t=1200, floor is 2500ms => 2300ms left.
		expect(computeReconnectDelay(1200, 1000, 2500)).toBe(2300);
	});

	test("never returns a negative delay", () => {
		expect(computeReconnectDelay(100_000, 0, 2500)).toBe(0);
	});

	test("back-to-back calls at the same instant never both return 0", () => {
		// Simulates the actual bug: connection-error fires twice in a tight
		// loop. The second call must see the first's reconnect as "recent".
		const minInterval = 2500;
		const t0 = 5000;
		const firstDelay = computeReconnectDelay(t0, 0, minInterval);
		expect(firstDelay).toBe(0);

		// The handler would set lastReconnectAt = t0 after firing.
		const secondDelay = computeReconnectDelay(t0, t0, minInterval);
		expect(secondDelay).toBe(minInterval);
	});
});
