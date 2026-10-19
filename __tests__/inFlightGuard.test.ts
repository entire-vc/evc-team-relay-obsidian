/**
 *: a fast double click on "Sign in" started two browser OAuth
 * sign-ins, because the "already waiting" flag was only set after an awaited
 * server-info fetch. InFlightGuard takes the key synchronously.
 */
import { describe, test, expect } from "@jest/globals";
import { InFlightGuard } from "../src/inFlightGuard";

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("InFlightGuard", () => {
	test("a second call issued before the first one's first await lands is dropped (double click within the fetch window)", async () => {
		const guard = new InFlightGuard<string>();
		const fetchInfo = deferred();
		let started = 0;
		const op = async () => {
			started++;
			await fetchInfo.promise; // stands in for `await fetchServerInfo(...)`
		};

		// Two synchronous calls back to back, as two clicks 50 ms apart would be
		// while the first is still awaiting the server-info fetch.
		const first = guard.run("evc", op);
		const second = guard.run("evc", op);

		expect(started).toBe(1);
		expect(await second).toBe(false);
		fetchInfo.resolve();
		expect(await first).toBe(true);
	});

	test("the flag is only set after an await in the buggy shape: control proving the test can go red", async () => {
		// The pre-fix behaviour, spelled out: check, await, THEN mark busy.
		let busy = false;
		let started = 0;
		const fetchInfo = deferred();
		const buggy = async () => {
			if (busy) return;
			await fetchInfo.promise;
			started++;
			busy = true;
		};
		const a = buggy();
		const b = buggy();
		fetchInfo.resolve();
		await Promise.all([a, b]);
		expect(started).toBe(2); // both got through: this is the defect
	});

	test("the key is released when the operation settles, also when it throws", async () => {
		const guard = new InFlightGuard<string>();
		await expect(
			guard.run("evc", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(guard.has("evc")).toBe(false);
		let ran = false;
		expect(await guard.run("evc", async () => void (ran = true))).toBe(true);
		expect(ran).toBe(true);
	});

	test("different keys do not block each other", async () => {
		const guard = new InFlightGuard<string>();
		const hold = deferred();
		const a = guard.run("evc", () => hold.promise);
		let ranOther = false;
		expect(await guard.run("ru", async () => void (ranOther = true))).toBe(true);
		expect(ranOther).toBe(true);
		expect(guard.has("evc")).toBe(true);
		hold.resolve();
		await a;
		expect(guard.has("evc")).toBe(false);
	});
});
