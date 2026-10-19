"use strict";

import { SystemClock, type Clock } from "../Clock";
import { instanceLabels, namedLogger } from "../logging";
import type { Subscribable } from "./Notifier";

export interface Delivery<T> {
	source: T & Subscribable<T>;
	listener: (value: T) => void;
	batchId: number;
	queuedAt: number;
	listenerOrigin?: string;
}

/**
 * A message bus for `Notifier.notifySubscribers()`. Rather than calling every
 * subscriber synchronously (which can re-enter mid-update and cause cascades),
 * non-immediate sends are queued into a mailbox per recipient and flushed on a
 * short timer, coalescing repeated notifications from the same tick.
 */
export class NotificationDispatcher {
	private static current: NotificationDispatcher | undefined;
	private static _shutDown = false;

	/** recipient -> senders waiting to be delivered to it on the next flush */
	private mailbox: Map<(value: unknown) => void, Set<Subscribable<unknown>>> = new Map();
	private sentLog: Delivery<unknown>[] = [];
	private deliveredLog: Delivery<unknown>[] = [];
	private flushScheduled = false;
	private inTransaction = false;
	private transactionId = 0;

	private constructor(
		private clock: Clock,
		private readonly flushDelayMs: number = 20,
	) {}

	static obtain(): NotificationDispatcher {
		if (NotificationDispatcher._shutDown) {
			throw new Error("tried to access notification dispatcher during teardown");
		}
		if (!NotificationDispatcher.current) {
			NotificationDispatcher.current = new NotificationDispatcher(new SystemClock());
			instanceLabels.set(NotificationDispatcher.current, "notification-dispatcher");
		}
		return NotificationDispatcher.current;
	}

	openBatch(): void {
		this.inTransaction = true;
		this.transactionId++;
	}

	closeBatch(): void {
		this.inTransaction = false;
		if (!this.flushScheduled) {
			this.scheduleFlush();
		}
	}

	dispatch<T>(
		sender: T & Subscribable<T>,
		recipient: (value: T) => void,
		immediate: boolean = false,
	): void {
		const anyRecipient = recipient as (value: unknown) => void;
		this.sentLog.push(this.makeMail(sender, recipient));

		if (immediate) {
			this.deliverTo(anyRecipient, sender);
			return;
		}

		let waiting = this.mailbox.get(anyRecipient);
		if (!waiting) {
			waiting = new Set();
			this.mailbox.set(anyRecipient, waiting);
		}
		waiting.add(sender);

		if (!this.inTransaction && !this.flushScheduled) {
			this.scheduleFlush();
		}
	}

	private scheduleFlush(): void {
		this.flushScheduled = true;
		this.clock.scheduleTimeout(() => {
			this.flush();
			this.flushScheduled = false;
			if (this.mailbox.size > 0 && !this.inTransaction) {
				this.scheduleFlush();
			}
		}, this.flushDelayMs);
	}

	private flush(): void {
		const debug = namedLogger("[dispatch]", "debug");
		for (const [recipient, senders] of this.mailbox) {
			for (const sender of senders) {
				this.deliverTo(recipient, sender);
				debug("send", sender.constructor.name, recipient);
			}
			senders.clear();
		}
	}

	private deliverTo(
		recipient: (value: unknown) => void,
		sender: Subscribable<unknown>,
	): void {
		recipient(sender);
		this.deliveredLog.push(this.makeMail<unknown>(sender, recipient));
	}

	private makeMail<T>(
		sender: T & Subscribable<T>,
		recipient: (value: T) => void,
	): Delivery<unknown> {
		return {
			source: sender,
			listener: recipient,
			batchId: this.transactionId,
			queuedAt: Date.now(),
			listenerOrigin: this.describeFunction(recipient as (value: unknown) => void),
		} as unknown as Delivery<unknown>;
	}

	getSentLog(): Delivery<unknown>[] {
		return [...this.sentLog];
	}

	getDeliveredLog(): Delivery<unknown>[] {
		return [...this.deliveredLog];
	}

	printSentLog(): void {
		namedLogger("[dispatch]", "warn")("All Delivery Log:\n" + this.formatMailLog(this.sentLog));
	}

	printDeliveredLog(): void {
		namedLogger("[dispatch]", "warn")(
			"Delivered Delivery Log:\n" + this.formatMailLog(this.deliveredLog),
		);
	}

	private formatMailLog(log: Delivery<unknown>[]): string {
		return log
			.map((mail, index) => {
				const source = mail.source as {
					observableName?: string;
					constructor?: { name?: string };
				};
				const lines = [
					`Delivery #${index + 1}:`,
					`  Timestamp: ${new Date(mail.queuedAt).toISOString()}`,
					`  Transaction ID: ${mail.batchId}`,
					`  Sender: ${source.observableName || source.constructor?.name}`,
					`  Recipient: ${mail.listener.name || "Anonymous function"}`,
					`  Recipient Origin: ${mail.listenerOrigin || "Unknown"}`,
					"---",
				];
				return lines.join("\n") + "\n";
			})
			.join("");
	}

	/** Best-effort human-readable name for a listener function, for debug logs only. */
	private describeFunction(func: (...args: unknown[]) => unknown): string {
		if (func.name) {
			return func.name;
		}

		const source = func.toString();
		const named = source.match(/^(function|class)?\s*([^\s(]*)/);
		if (named && named[2]) {
			return named[2];
		}

		const maxLength = 200;
		const truncated = source.replace(/\s+/g, " ").slice(0, maxLength);
		const ellipsis = truncated.length === maxLength ? "..." : "";
		return `AnonymousFunction(${truncated}${ellipsis})`;
	}

	static shutdown(): void {
		const instance = NotificationDispatcher.current;
		if (!instance) {
			return;
		}
		instance.mailbox = null as unknown as Map<
			(value: unknown) => void,
			Set<Subscribable<unknown>>
		>;
		instance.sentLog = [];
		instance.deliveredLog = [];
		instance.clock.teardown();
		instance.clock = null as unknown as Clock;
		instance.flushScheduled = false;
		instance.inTransaction = false;
		instance.transactionId = 0;
		NotificationDispatcher._shutDown = true;
		NotificationDispatcher.current = undefined;
	}

	/** Test-only: force a fresh singleton, optionally on a fake Clock. */
	static _reinitForTest(clock?: Clock): void {
		NotificationDispatcher.current?.clock?.teardown();
		NotificationDispatcher._shutDown = false;
		NotificationDispatcher.current = undefined;
		if (clock) {
			NotificationDispatcher.current = new NotificationDispatcher(clock);
			instanceLabels.set(NotificationDispatcher.current, "notification-dispatcher");
		}
	}
}
