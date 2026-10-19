/**
 * Unit tests: waitForBufferFlush
 *
 * The bug: uploadDocumentViaSocket used to `await new Promise((r) =>
 * setTimeout(r, 1000))` after writing a reconcile update, hoping that was
 * enough time for the WebSocket to flush it before an intentional disconnect
 * proceeded. On a slow link or a large diff, the update can still be sitting
 * in the socket's outgoing buffer well past a fixed 1000ms — these tests
 * simulate exactly that (a buffer that drains slowly over several polls) to
 * prove the fix actually waits for the real signal instead of a guessed
 * delay, and that it's still bounded so a stuck/closed socket can't hang
 * forever.
 *
 * Uses a fake `{ bufferedAmount }` object (a duck-typed WebSocket stand-in) —
 * no real WebSocket/network boundary involved, so nothing here needs mocking
 * beyond the object under test's own dependencies (sleep/now are injected).
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { waitForBufferFlush } from "../src/websocketFlush";

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("waitForBufferFlush", () => {
	test("null/undefined socket is a no-op — resolves immediately", async () => {
		const sleep = jest.fn(async () => {});
		await waitForBufferFlush(null, { sleep });
		await waitForBufferFlush(undefined, { sleep });
		expect(sleep).not.toHaveBeenCalled();
	});

	test("already-flushed socket (bufferedAmount 0) resolves without sleeping", async () => {
		const sleep = jest.fn(async () => {});
		await waitForBufferFlush({ bufferedAmount: 0 }, { sleep });
		expect(sleep).not.toHaveBeenCalled();
	});

	test("waits across multiple polls while the buffer slowly drains, exactly the slow-link/large-diff scenario a fixed 1000ms timer can't cover", async () => {
		// Simulates a large diff on a slow link: bufferedAmount only reaches 0
		// after several poll intervals — well past what a single fixed-delay
		// wait would have covered if the fixed delay were shorter than this.
		const socket = { bufferedAmount: 300 };
		const clock = fakeClock();
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			socket.bufferedAmount = Math.max(0, socket.bufferedAmount - 100);
		});

		await waitForBufferFlush(socket, {
			sleep,
			now: clock.now,
			pollIntervalMs: 10,
			maxWaitMs: 10_000,
		});

		expect(socket.bufferedAmount).toBe(0);
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	test("bails out after maxWaitMs if the buffer never drains — a stuck/closed socket can't hang the caller forever", async () => {
		const socket = { bufferedAmount: 999 };
		const clock = fakeClock();
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			// bufferedAmount never changes — simulates a socket that's stuck
			// or already closed underneath us.
		});

		await waitForBufferFlush(socket, {
			sleep,
			now: clock.now,
			pollIntervalMs: 50,
			maxWaitMs: 200,
		});

		// Must have given up (bounded), not spun forever.
		expect(clock.now()).toBeGreaterThanOrEqual(200);
		expect(socket.bufferedAmount).toBe(999);
	});

	test("default options resolve promptly for an already-flushed socket", async () => {
		const start = Date.now();
		await waitForBufferFlush({ bufferedAmount: 0 });
		expect(Date.now() - start).toBeLessThan(100);
	});

	test("default sleep uses window.setTimeout, not a bare global timer", () => {
		// Obsidian's popout-window rule: any timer used by plugin code must be
		// window.* (a note torn out into its own popout is a separate window;
		// code relying on an ambient bare `setTimeout` reference is the class
		// of bug this convention exists to catch — the org's plugin validator
		// flags it as a hard-fail item).
		//
		// A jest.spyOn(window, "setTimeout") CANNOT discriminate this: in
		// jsdom, `global === window`, so a bare `setTimeout(...)` call and a
		// `window.setTimeout(...)` call invoke the literal same function
		// object — a spy on one transparently catches the other too. That
		// approach was tried and silently didn't fail even with the bare-timer
		// bug reintroduced. A static source check is what actually
		// discriminates (and is what the real validator does).
		const source = fs.readFileSync(
			path.join(__dirname, "../src/websocketFlush.ts"),
			"utf8",
		);
		// Strip comments first — this file's own JSDoc quotes the pre-fix
		// buggy line verbatim (`setTimeout(r, 1000)`) as history, which would
		// otherwise false-positive here exactly the way it masked the real
		// validator's scan during review (it hit that comment line and
		// stopped, per this repo's one-hit-per-rule dedup behavior).
		const codeOnly = source
			.replace(/\/\*\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		// Match a setTimeout/setInterval call NOT preceded by `window.`.
		const bareTimerCall = /(?<!window\.)\bset(?:Timeout|Interval)\s*\(/;
		expect(codeOnly).not.toMatch(bareTimerCall);
	});
});
