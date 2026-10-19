"use strict";

import { Loggable } from "../logging";
import { NotificationDispatcher } from "./NotificationDispatcher";

/** A callback invoked with the new value whenever a Notifier changes. */
export type Subscriber<T> = (value: T) => void;

/** Detaches a subscriber that was previously registered via `on`/`subscribe`. */
export type Unsubscriber = () => void;

export interface Subscribable<T> {
	on(listener: () => void): Unsubscriber;
	subscribe(run: Subscriber<T>): Unsubscriber;
	off(listener: () => void): void;
	dropSubscriber(run: Subscriber<T>): void;
}

/**
 * Every live Notifier registers itself here so `auditNotifierTeardown` can featureKey
 * instances that still have subscribers attached when the plugin unloads —
 * a leaked listener usually means a `destroy()` call was missed somewhere.
 */
const liveObservables = new Set<Notifier<unknown>>();

/** Warns about, then forgets, every Notifier still tracked as live. Call on plugin unload. */
export function auditNotifierTeardown(): void {
	for (const instance of liveObservables) {
		instance.warnIfListenersRemain();
	}
	liveObservables.clear();
}

export class Notifier<T> extends Loggable implements Subscribable<T> {
	protected _listeners: Set<Subscriber<T>>;
	protected unsubscribes: Unsubscriber[];
	protected destroyed: boolean = false;

	constructor(public observableName?: string) {
		super();
		this._listeners = new Set();
		this.unsubscribes = [];
		liveObservables.add(this as unknown as Notifier<unknown>);
	}

	/** @internal invoked by auditNotifierTeardown() — not part of the public contract. */
	warnIfListenersRemain(): void {
		const remaining = this._listeners?.size ?? 0;
		if (remaining > 0) {
			this.warn(`Missing tear down of ${remaining} listeners on ${this.observableName}`);
		}
	}

	notifySubscribers(): void {
		if (!this._listeners || this._listeners.size === 0) {
			return;
		}
		const postOffice = NotificationDispatcher.obtain();
		const self = this as unknown as T & Subscribable<T>;
		for (const recipient of this._listeners) {
			postOffice.dispatch(self, recipient);
		}
	}

	on(listener: () => void): Unsubscriber {
		this._listeners?.add(listener);
		return () => this.off(listener);
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		this._listeners?.add(run);
		NotificationDispatcher.obtain().dispatch(this as unknown as T & Subscribable<T>, run, true);
		return () => this.dropSubscriber(run);
	}

	off(listener: () => void): void {
		this._listeners?.delete(listener);
	}

	dropSubscriber(run: Subscriber<T>): void {
		this._listeners?.delete(run);
	}

	destroy(): void {
		this.destroyed = true;
		for (const unsub of this.unsubscribes) {
			unsub();
		}
		this._listeners?.clear();
		this._listeners = null as unknown as Set<Subscriber<T>>;
	}
}
