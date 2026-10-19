"use strict";

export interface Clock {
	now: () => number;
	scheduleInterval: (callback: () => void, ms: number) => number;
	cancelInterval: (timerId: number) => void;
	scheduleTimeout: (callback: () => void, ms: number) => number;
	cancelTimeout: (timerId: number) => void;
	teardown: () => void;
	debounced: <T extends (...args: unknown[]) => void>(
		func: T,
		delay: number,
	) => (...args: Parameters<T>) => void;
}

type TimerKind = "timeout" | "interval";

/**
 * Wall-clock implementation of `Clock`, backed by the real `window` timer APIs.
 *
 * Every handle it hands out is tracked in a single map (rather than two
 * parallel arrays) so `teardown()` can sweep everything outstanding in one
 * pass without callers having to remember to clean up after themselves.
 */
export class SystemClock implements Clock {
	private handles = new Map<number, TimerKind>();

	now(): number {
		return Date.now();
	}

	scheduleInterval = (callback: () => void, ms: number): number => {
		const id = window.setInterval(callback, ms);
		this.handles.set(id, "interval");
		return id;
	};

	cancelInterval = (timerId: number): void => {
		window.clearInterval(timerId);
		this.handles.delete(timerId);
	};

	scheduleTimeout = (callback: () => void, ms: number): number => {
		const id = window.setTimeout(() => {
			this.handles.delete(id);
			callback();
		}, ms);
		this.handles.set(id, "timeout");
		return id;
	};

	cancelTimeout = (timerId: number): void => {
		window.clearTimeout(timerId);
		this.handles.delete(timerId);
	};

	teardown(): void {
		for (const [id, kind] of this.handles) {
			if (kind === "interval") {
				window.clearInterval(id);
			} else {
				window.clearTimeout(id);
			}
		}
		this.handles.clear();
	}

	debounced<T extends (...args: unknown[]) => void>(
		func: T,
		delay: number = 500,
	): (...args: Parameters<T>) => void {
		let pending: number | undefined;
		return (...args: Parameters<T>) => {
			if (pending !== undefined) {
				window.clearTimeout(pending);
			}
			pending = window.setTimeout(() => func(...args), delay);
		};
	}
}
