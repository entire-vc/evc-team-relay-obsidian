"use strict";

import type { Clock } from "src/Clock";
import { NotifierMap } from "src/notifiers/NotifierMap";
import { NotificationDispatcher } from "src/notifiers/NotificationDispatcher";
import type { Subscribable } from "src/notifiers/Notifier";

/**
 * A synchronous Clock for testing that executes callbacks immediately
 * or allows manual flushing.
 */
class TestClock implements Clock {
	private pendingCallbacks: Array<{ id: number; callback: () => void }> = [];
	private nextId = 1;

	now(): number {
		return Date.now();
	}

	scheduleTimeout(callback: () => void, _ms: number): number {
		const id = this.nextId++;
		this.pendingCallbacks.push({ id, callback });
		return id;
	}

	cancelTimeout(timerId: number): void {
		this.pendingCallbacks = this.pendingCallbacks.filter((p) => p.id !== timerId);
	}

	scheduleInterval(_callback: () => void, _ms: number): number {
		return this.nextId++;
	}

	cancelInterval(_timerId: number): void {}

	teardown(): void {
		this.pendingCallbacks = [];
	}

	debounced<T extends (...args: any[]) => void>(
		func: T,
		_delay: number = 500,
	): (...args: Parameters<T>) => void {
		return func;
	}

	/** Flush all pending timeouts synchronously */
	flush(): void {
		// Flush once - don't follow reschedules to avoid infinite loops
		// NotificationDispatcher reschedules if mailboxes.size > 0, but size stays > 0
		// because deliver() only clears senders, not the mailbox entries
		const callbacks = [...this.pendingCallbacks];
		this.pendingCallbacks = [];
		for (const { callback } of callbacks) {
			callback();
		}
	}
}

describe("NotifierMap", () => {
	let timeProvider: TestClock;

	beforeEach(() => {
		timeProvider = new TestClock();
		NotificationDispatcher._reinitForTest(timeProvider);
	});

	afterEach(() => {
		NotificationDispatcher._reinitForTest();
	});

	/** Helper to flush pending NotificationDispatcher deliveries */
	function flushDeliveries() {
		timeProvider.flush();
	}

	describe("basic Map operations", () => {
		it("should set and get values", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.lookup("a")).toBe(1);
			expect(map.lookup("b")).toBe(2);
			expect(map.lookup("c")).toBeUndefined();
		});

		it("should return correct size", () => {
			const map = new NotifierMap<string, number>();
			expect(map.count).toBe(0);

			map.put("a", 1);
			expect(map.count).toBe(1);

			map.put("b", 2);
			expect(map.count).toBe(2);

			map.put("a", 3); // overwrite
			expect(map.count).toBe(2);
		});

		it("should check if key exists with has()", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);

			expect(map.contains("a")).toBe(true);
			expect(map.contains("b")).toBe(false);
		});

		it("should delete values", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.delete("a")).toBe(true);
			expect(map.contains("a")).toBe(false);
			expect(map.count).toBe(1);

			expect(map.delete("nonexistent")).toBe(false);
		});

		it("should clear all values", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			map.clearAll();

			expect(map.count).toBe(0);
			expect(map.contains("a")).toBe(false);
			expect(map.contains("b")).toBe(false);
		});

		it("should return keys as array", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.keyList()).toEqual(["a", "b"]);
		});

		it("should return values as array", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.valueList()).toEqual([1, 2]);
		});

		it("should return entries as array", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.entryList()).toEqual([
				["a", 1],
				["b", 2],
			]);
		});

		it("should iterate with forEach", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			const results: [string, number][] = [];
			map.each((value, key) => {
				results.push([key, value]);
			});

			expect(results).toEqual([
				["a", 1],
				["b", 2],
			]);
		});

		it("should find values with predicate", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);
			map.put("c", 3);

			expect(map.locate((v) => v > 1)).toBe(2);
			expect(map.locate((v) => v > 10)).toBeUndefined();
			expect(map.locate((_, k) => k === "c")).toBe(3);
		});

		it("should check with some()", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			expect(map.any((v) => v > 1)).toBe(true);
			expect(map.any((v) => v > 10)).toBe(false);
		});
	});

	describe("subscribe/unsubscribe", () => {
		it("should call subscriber immediately on subscribe", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);

			// Immediate delivery happens synchronously
			expect(subscriber).toHaveBeenCalledTimes(1);
			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should notify subscribers on set", () => {
			const map = new NotifierMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);

			subscriber.mockClear();
			map.put("a", 1);

			// NotificationDispatcher uses scheduleTimeout (via Clock) for batched delivery
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should notify subscribers on delete", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("a");
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should not notify on delete of nonexistent key", () => {
			const map = new NotifierMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("nonexistent");
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});

		it("should notify subscribers on clear", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);

			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.clearAll();
			flushDeliveries();

			expect(subscriber).toHaveBeenCalledWith(map);
		});

		it("should stop notifying after unsubscribe via returned function", () => {
			const map = new NotifierMap<string, number>();
			const subscriber = jest.fn();
			const unsubscribe = map.subscribe(subscriber);
			subscriber.mockClear();

			unsubscribe();
			map.put("a", 1);
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});

		it("should stop notifying after dropSubscriber via method", () => {
			const map = new NotifierMap<string, number>();
			const subscriber = jest.fn();
			map.subscribe(subscriber);
			subscriber.mockClear();

			map.dropSubscriber(subscriber);
			map.put("a", 1);
			flushDeliveries();

			expect(subscriber).not.toHaveBeenCalled();
		});
	});

	describe("filter (FilteredMap)", () => {
		it("should create a filtered view of the map", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);
			map.put("c", 3);

			const predicate = (v: number) => v > 1;
			const filtered = map.select(predicate);

			const subscriber = jest.fn();
			filtered.subscribe(subscriber);

			expect(filtered.count).toBe(2);
			expect(filtered.valueList()).toEqual([2, 3]);
		});

		it("should return same FilteredMap for same predicate function", () => {
			const map = new NotifierMap<string, number>();
			const predicate = (v: number) => v > 1;

			const filtered1 = map.select(predicate);
			const filtered2 = map.select(predicate);

			expect(filtered1).toBe(filtered2);
		});

		it("should return different FilteredMap for different predicate functions", () => {
			const map = new NotifierMap<string, number>();
			const predicate1 = (v: number) => v > 1;
			const predicate2 = (v: number) => v > 2;

			const filtered1 = map.select(predicate1);
			const filtered2 = map.select(predicate2);

			expect(filtered1).not.toBe(filtered2);
		});

		it("should update FilteredMap when parent changes", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			const filtered = map.select((v) => v > 1);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.put("c", 3);
			flushDeliveries();

			expect(filtered.count).toBe(2);
			expect(filtered.valueList()).toEqual([2, 3]);
			expect(subscriber).toHaveBeenCalled();
		});

		it("should eagerly populate FilteredMap so .valueList() works without subscribing", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);
			map.put("c", 3);

			const filtered = map.select((v) => v > 1);

			// This is the key behavior from the recent change:
			// .valueList() should work without subscribing
			expect(filtered.valueList()).toEqual([2, 3]);
			expect(filtered.count).toBe(2);
		});

		it("should allow accessing FilteredMap entries without subscribing", () => {
			const map = new NotifierMap<string, number>();
			map.put("x", 10);
			map.put("y", 20);
			map.put("z", 5);

			const filtered = map.select((v) => v >= 10);

			// All read operations should work without subscribing
			expect(filtered.keyList()).toEqual(["x", "y"]);
			expect(filtered.entryList()).toEqual([
				["x", 10],
				["y", 20],
			]);
			expect(filtered.contains("x")).toBe(true);
			expect(filtered.contains("z")).toBe(false);
			expect(filtered.lookup("y")).toBe(20);
		});

		it("should tear down the derived view when dropSubscriber is called through a Subscribable-typed reference", () => {
			// Regression guard for the override chain Subscribable ->
			// Notifier -> NotifierMap -> FilteredMap all sharing the
			// dropSubscriber name. FilteredMap.dropSubscriber's own body is
			// what notices the last listener left and tears the parent
			// attachment down (calling `this.parentUnsubscribe()`, which in
			// turn decrements the parent's derived-view ref count and
			// destroys this view). That body only runs if the call actually
			// resolves to FilteredMap's own override -- if any single link
			// in the chain kept a different name, a caller going through a
			// Subscribable/Notifier-typed reference (exactly what this test
			// does) would silently land on a base implementation instead,
			// which only removes the listener and never cascades the
			// teardown. `destroy` would then never fire.
			const map = new NotifierMap<string, number>();
			map.put("a", 1);

			const filtered = map.select((v) => v > 0);
			const destroySpy = jest.spyOn(filtered, "destroy");

			const subscriber = jest.fn();
			filtered.subscribe(subscriber);

			const filteredAsBase: Subscribable<NotifierMap<string, number>> = filtered;
			filteredAsBase.dropSubscriber(subscriber);

			expect(destroySpy).toHaveBeenCalled();
		});

		it("should cleanup FilteredMap when all subscribers unsubscribe", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			const predicate = (v: number) => v > 0;
			const filtered = map.select(predicate);

			const subscriber1 = jest.fn();
			const subscriber2 = jest.fn();
			const unsub1 = filtered.subscribe(subscriber1);
			const unsub2 = filtered.subscribe(subscriber2);

			// Both unsubscribe
			unsub1();
			unsub2();

			// After cleanup, getting a new filter should work
			const filtered2 = map.select(predicate);
			expect(filtered2.valueList()).toEqual([1, 2]);
		});

		it("should filter by key as well as value", () => {
			const map = new NotifierMap<string, number>();
			map.put("item-1", 100);
			map.put("item-2", 200);
			map.put("other-1", 300);

			const filtered = map.select((_, key) => key.startsWith("item"));
			expect(filtered.count).toBe(2);
			expect(filtered.keyList()).toEqual(["item-1", "item-2"]);
		});

		it("should handle empty parent map", () => {
			const map = new NotifierMap<string, number>();
			const filtered = map.select((v) => v > 0);

			expect(filtered.count).toBe(0);
			expect(filtered.valueList()).toEqual([]);
		});

		it("should handle filter that matches nothing", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			const filtered = map.select((v) => v > 100);

			expect(filtered.count).toBe(0);
			expect(filtered.valueList()).toEqual([]);
		});

		it("should reflect parent deletions in FilteredMap", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);
			map.put("c", 3);

			const filtered = map.select((v) => v > 0);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.delete("b");
			flushDeliveries();

			expect(filtered.valueList()).toEqual([1, 3]);
		});

		it("should reflect parent clear in FilteredMap", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1);
			map.put("b", 2);

			const filtered = map.select((v) => v > 0);
			const subscriber = jest.fn();
			filtered.subscribe(subscriber);
			subscriber.mockClear();

			map.clearAll();
			flushDeliveries();

			expect(filtered.count).toBe(0);
		});
	});

	describe("on/off listeners", () => {
		it("should support on() for simple change notifications", () => {
			const map = new NotifierMap<string, number>();
			const listener = jest.fn();
			map.on(listener);

			map.put("a", 1);
			flushDeliveries();

			expect(listener).toHaveBeenCalled();
		});

		it("should stop calling listener after off()", () => {
			const map = new NotifierMap<string, number>();
			const listener = jest.fn();
			map.on(listener);
			map.off(listener);

			map.put("a", 1);
			flushDeliveries();

			expect(listener).not.toHaveBeenCalled();
		});

		it("should return unsubscriber from on()", () => {
			const map = new NotifierMap<string, number>();
			const listener = jest.fn();
			const unsub = map.on(listener);

			unsub();
			map.put("a", 1);
			flushDeliveries();

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("method chaining", () => {
		it("should allow chaining set calls", () => {
			const map = new NotifierMap<string, number>();
			map.put("a", 1).put("b", 2).put("c", 3);

			expect(map.count).toBe(3);
			expect(map.valueList()).toEqual([1, 2, 3]);
		});
	});

	describe("generic typing", () => {
		it("should work with complex value types", () => {
			interface Account {
				name: string;
				age: number;
			}

			const map = new NotifierMap<string, Account>();
			map.put("user1", { name: "Alice", age: 30 });
			map.put("user2", { name: "Bob", age: 25 });

			const adults = map.select((user) => user.age >= 18);
			expect(adults.count).toBe(2);

			const found = map.locate((user) => user.name === "Bob");
			expect(found?.age).toBe(25);
		});

		it("should support get with type parameter", () => {
			const map = new NotifierMap<string, unknown>();
			map.put("num", 42);
			map.put("str", "hello");

			const num = map.lookup<number>("num");
			expect(num).toBe(42);
		});
	});
});
