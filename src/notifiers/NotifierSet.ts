"use strict";

import { Notifier } from "./Notifier";

/**
 * A thin wrapper around the built-in `Set` that fires `notifySubscribers()`
 * whenever membership actually changes — re-adding an existing member, or
 * deleting one that was never there, is a silent no-op and does not notify.
 */
export class NotifierSet<T> extends Notifier<NotifierSet<T>> {
	protected backing: Set<T>;

	constructor() {
		super();
		this.backing = new Set<T>();
	}

	/** Adds `member`; only notifies if it wasn't already present. */
	include(member: T): NotifierSet<T> {
		if (this.backing.has(member)) {
			return this;
		}
		this.backing.add(member);
		this.notifySubscribers();
		return this;
	}

	/** Removes `member`; only notifies if it was actually present. */
	delete(member: T): boolean {
		if (!this.backing.has(member)) {
			return false;
		}
		this.backing.delete(member);
		this.notifySubscribers();
		return true;
	}

	/** Empties the set. Always notifies, even if it was already empty. */
	clearAll(): void {
		this.backing.clear();
		this.notifySubscribers();
	}

	contains(member: T): boolean {
		return this.backing.has(member);
	}

	get count(): number {
		return this.backing.size;
	}

	/** A snapshot array of the current members, in insertion order. */
	toArray(): T[] {
		const snapshot: T[] = [];
		for (const member of this.backing) {
			snapshot.push(member);
		}
		return snapshot;
	}

	collect<R>(callbackfn: (value: T) => R): R[] {
		const mapped: R[] = [];
		for (const member of this.backing) {
			mapped.push(callbackfn(member));
		}
		return mapped;
	}

	each(callbackfn: (value: T, index: number, array: T[]) => void): void {
		this.toArray().forEach(callbackfn);
	}

	locate(predicate: (value: T) => boolean): T | undefined {
		for (const member of this.backing) {
			if (predicate(member)) {
				return member;
			}
		}
		return undefined;
	}

	any(predicate: (item: T) => boolean): boolean {
		for (const member of this.backing) {
			if (predicate(member)) {
				return true;
			}
		}
		return false;
	}

	select(predicate: (value: T) => boolean): T[] {
		return this.toArray().filter(predicate);
	}
}
