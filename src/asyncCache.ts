"use strict";

import { namedLogger } from "./logging";

export type AsyncFactory<T> = () => Promise<T>;
export type ReadyCheck<T> = () => [boolean, T];

const STALL_WARNING_MS = 3000;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * A cached async value that can also be short-circuited synchronously.
 *
 * `value()` first asks `readyCheck` whether the value is already
 * available. If it is, and there's an in-flight promise waiting on it, that
 * promise resolves immediately instead of waiting for `factory` to
 * settle on its own. Otherwise `factory` is started (once) and its
 * result is memoized until it fails — a failure clears the cache so the next
 * `value()` call retries from scratch.
 *
 * While a promise is in flight, a one-shot timer re-polls `readyCheck`
 * after STALL_WARNING_MS: this covers callers whose "done" signal (the sync
 * check) fires without the async completion path noticing.
 */
export class LazyValue<T> {
	private pending: {
		promise: Promise<T>;
		resolve: (value: T) => void;
		stallTimer: number;
	} | null = null;

	constructor(
		private readonly factory: AsyncFactory<T>,
		private readonly readyCheck: ReadyCheck<T>,
	) {}

	public value(): Promise<T> {
		const [ready, value] = this.readyCheck();
		if (ready && this.pending) {
			this.pending.resolve(value);
			window.clearTimeout(this.pending.stallTimer);
			return this.pending.promise;
		}
		if (!this.pending) {
			this.pending = this.launch();
		}
		return this.pending.promise;
	}

	private launch(): { promise: Promise<T>; resolve: (value: T) => void; stallTimer: number } {
		let resolveFn!: (value: T) => void;
		let rejectFn!: (reason: Error) => void;
		const promise = new Promise<T>((resolve, reject) => {
			resolveFn = resolve;
			rejectFn = reject;
		});

		const stallTimer = window.setTimeout(() => {
			namedLogger("[Promise]", "debug")(
				"LazyValue stuck after 3s. Checking.",
				this.factory.toString(),
			);
			const [ready, value] = this.readyCheck();
			if (ready && this.pending) {
				this.pending.resolve(value);
				window.clearTimeout(this.pending.stallTimer);
			}
		}, STALL_WARNING_MS);

		const entry = { promise, resolve: resolveFn, stallTimer };

		this.factory().then(
			(value) => {
				window.clearTimeout(entry.stallTimer);
				resolveFn(value);
			},
			(error: unknown) => {
				window.clearTimeout(entry.stallTimer);
				this.pending = null;
				rejectFn(asError(error));
			},
		);

		return entry;
	}

	public destroy(): void {
		if (this.pending) {
			window.clearTimeout(this.pending.stallTimer);
		}
		this.pending = null;
	}
}

/**
 * Single-flight memoization for one async call: concurrent `getPromise()`
 * callers share the same in-flight promise, and the cache clears itself as
 * soon as that promise settles (success or failure) so the next call starts
 * fresh rather than replaying a stale result.
 */
export class SingleFlight<T> {
	private inFlight: { promise: Promise<T>; stallTimer: number } | null = null;

	constructor(private readonly promiseFunction: AsyncFactory<T>) {}

	public getPromise(): Promise<T> {
		if (this.inFlight) {
			return this.inFlight.promise;
		}

		const stallTimer = window.setTimeout(() => {
			namedLogger("[Promise]", "error")(
				"SingleFlight stuck after 3s:",
				this.promiseFunction.toString(),
			);
		}, STALL_WARNING_MS);

		const promise = this.promiseFunction().then(
			(value) => {
				window.clearTimeout(stallTimer);
				this.inFlight = null;
				return value;
			},
			(error: unknown) => {
				window.clearTimeout(stallTimer);
				this.inFlight = null;
				throw asError(error);
			},
		);

		this.inFlight = { promise, stallTimer };
		return promise;
	}

	public destroy(): void {
		if (this.inFlight) {
			window.clearTimeout(this.inFlight.stallTimer);
		}
		this.inFlight = null;
	}
}

/**
 * Wraps a promise so a debug-level warning is logged if it hasn't settled
 * within STALL_WARNING_MS. Purely observational — the returned promise
 * resolves/rejects with the same value as `promise`.
 */
export function warnIfSlow<T>(
	promise: Promise<T>,
	...logArgs: unknown[]
): Promise<T> {
	const stallTimer = window.setTimeout(() => {
		namedLogger("[Promise]", "debug")("Promise stuck after 3s:", ...logArgs);
	}, STALL_WARNING_MS);

	return promise.then(
		(value) => {
			window.clearTimeout(stallTimer);
			return value;
		},
		(error: unknown) => {
			window.clearTimeout(stallTimer);
			throw asError(error);
		},
	);
}
