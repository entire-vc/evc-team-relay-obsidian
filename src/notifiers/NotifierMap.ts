"use strict";

import type { Unsubscriber } from "svelte/store";
import { Notifier } from "./Notifier";
import type { Subscriber } from "./Notifier";

/**
 * A Map that notifies subscribers whenever an entry is added, removed, or the
 * whole thing is cleared. Supports `.select()`, which returns a live derived
 * view that stays in sync with the parent for as long as anyone is listening
 * to it, and tears itself down once the last listener leaves.
 */
export class NotifierMap<K, V> extends Notifier<NotifierMap<K, V>> {
	protected backing: Map<K, V>;

	/** predicate -> the derived view already built for it, so repeat calls share one instance */
	private derivedByPredicate: WeakMap<(value: V, key: K) => boolean, FilteredMap<K, V>>;
	/** how many times we've forwarded our own subscribe() to a given derived view's callback */
	private derivedRefCounts = new WeakMap<FilteredMap<K, V>, number>();
	private derivedInFlight = new Set<FilteredMap<K, V>>();

	constructor(public observableName?: string) {
		super();
		this.backing = new Map();
		this.derivedByPredicate = new WeakMap();
	}

	put(key: K, value: V): NotifierMap<K, V> {
		this.backing.set(key, value);
		this.notifySubscribers();
		return this;
	}

	delete(key: K): boolean {
		const deleted = this.backing.delete(key);
		if (deleted) {
			this.notifySubscribers();
		}
		return deleted;
	}

	clearAll(): void {
		this.backing.clear();
		this.notifySubscribers();
	}

	contains(key: K): boolean {
		return this.backing.has(key);
	}

	lookup<T = V>(key: K): T | undefined {
		return this.backing.get(key) as T;
	}

	keyList(): K[] {
		return Array.from(this.backing.keys());
	}

	valueList(): V[] {
		return Array.from(this.backing.values());
	}

	entryList(): [K, V][] {
		return Array.from(this.backing.entries());
	}

	get count(): number {
		return this.backing.size;
	}

	each(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void {
		this.backing.forEach(callbackfn);
	}

	locate(predicate: (value: V, key: K) => boolean): V | undefined {
		for (const [key, value] of this.backing) {
			if (predicate(value, key)) {
				return value;
			}
		}
		return undefined;
	}

	any(predicate: (value: V, key: K) => boolean): boolean {
		for (const [key, value] of this.backing) {
			if (predicate(value, key)) {
				return true;
			}
		}
		return false;
	}

	/** Finds the derived view (if any) whose internal callback === run. */
	private derivedViewFor(run: Subscriber<NotifierMap<K, V>>): FilteredMap<K, V> | undefined {
		for (const derived of this.derivedInFlight) {
			if (derived.parentCallback === run) {
				return derived;
			}
		}
		return undefined;
	}

	private bumpDerivedRefCount(derived: FilteredMap<K, V>, delta: 1 | -1): void {
		const next = (this.derivedRefCounts.get(derived) ?? 0) + delta;
		if (next <= 0) {
			this.derivedRefCounts.delete(derived);
			this.derivedInFlight.delete(derived);
			derived.destroy();
		} else {
			this.derivedRefCounts.set(derived, next);
		}
	}

	// Subscribing a derived view's callback is tracked so it can be torn down
	// once nothing is forwarding through it anymore.
	subscribe(run: Subscriber<NotifierMap<K, V>>): Unsubscriber {
		const derived = this.derivedViewFor(run);
		if (derived) {
			this.bumpDerivedRefCount(derived, 1);
		}

		const parentUnsubscribe = super.subscribe(run);
		return () => {
			if (derived) {
				this.bumpDerivedRefCount(derived, -1);
			}
			parentUnsubscribe();
		};
	}

	// Overrides Notifier.dropSubscriber (Subscribable<T> contract) to also
	// decrement the derived-view ref-count on manual unsubscribe, not just on
	// the closure subscribe() returns. Renamed together with
	// Subscribable.dropSubscriber / Notifier.dropSubscriber /
	// FilteredMap.dropSubscriber (below, same file) in one motion -- renaming
	// only one copy of an override chain silently stops it from overriding
	// the base.
	dropSubscriber(run: Subscriber<NotifierMap<K, V>>): void {
		const derived = this.derivedViewFor(run);
		if (derived) {
			this.bumpDerivedRefCount(derived, -1);
		}
		super.dropSubscriber(run);
	}

	select(predicate: (value: V, key: K) => boolean): NotifierMap<K, V> {
		const cached = this.derivedByPredicate.get(predicate);
		if (cached) {
			return cached;
		}

		const derived = new FilteredMap<K, V>(this, predicate);
		this.derivedByPredicate.set(predicate, derived);
		this.derivedRefCounts.set(derived, 0);
		this.derivedInFlight.add(derived);
		return derived;
	}
}

/** The live, read-only view returned by `NotifierMap.select()`. */
class FilteredMap<K, V> extends NotifierMap<K, V> {
	private parentUnsubscribe?: Unsubscriber;
	public parentCallback: Subscriber<NotifierMap<K, V>>;

	constructor(
		private readonly parent: NotifierMap<K, V>,
		private readonly predicate: (value: V, key: K) => boolean,
	) {
		super();
		this.observableName = `${parent.observableName}(filter: ${predicate.toString()})`;
		this.parentCallback = () => this.recompute();
		// Populate eagerly so reads work before anyone actually subscribes.
		this.recompute();
	}

	private recompute(): void {
		const next = new Map<K, V>();
		this.parent.each((value, key) => {
			if (this.predicate(value, key)) {
				next.set(key, value);
			}
		});
		this.backing = next;
		this.notifySubscribers();
	}

	private attachToParent(): void {
		if (this.parentUnsubscribe) {
			return;
		}
		this.parentUnsubscribe = this.parent.subscribe(this.parentCallback);
	}

	subscribe(run: Subscriber<NotifierMap<K, V>>): Unsubscriber {
		this.attachToParent();
		return super.subscribe(run);
	}

	dropSubscriber(run: Subscriber<NotifierMap<K, V>>): void {
		super.dropSubscriber(run);
		if (this._listeners?.size === 0 && this.parentUnsubscribe) {
			this.parentUnsubscribe();
			this.parentUnsubscribe = undefined;
		}
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		this.parentUnsubscribe?.();
		this.parentUnsubscribe = undefined;
		this._listeners?.clear();
		this.parentCallback = null as unknown as Subscriber<NotifierMap<K, V>>;
	}
}
