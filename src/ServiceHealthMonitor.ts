import { requestUrl } from "obsidian";
import { namedLogger } from "./logging";
import type { Clock } from "./Clock";

declare const GIT_TAG: string;

interface ServiceHealthReport {
	status: string;
	versions?: {
		stable: string;
		beta: string;
	};
	backgroundColor?: string;
	color?: string;
	link?: string;
}

type StatusEventType = "online" | "offline";
type Callback = (status?: ServiceHealthReport) => void;

interface Listener {
	callback: Callback;
	once: boolean;
}

/** Per-event listener bookkeeping: permanent subscribers always fire before
 * one-shot ("once") subscribers, and once-subscribers are dropped after
 * firing. */
class StatusListeners {
	private byEvent = new Map<StatusEventType, Listener[]>([
		["online", []],
		["offline", []],
	]);

	add(eventType: StatusEventType, callback: Callback, once = false): void {
		this.byEvent.get(eventType)?.push({ callback, once });
	}

	emit(eventType: StatusEventType, status?: ServiceHealthReport): void {
		const listeners = this.byEvent.get(eventType) ?? [];
		const permanent = listeners.filter((l) => !l.once);
		const oneShot = listeners.filter((l) => l.once);
		permanent.forEach((l) => l.callback(status));
		oneShot.forEach((l) => l.callback(status));
		this.byEvent.set(eventType, permanent);
	}

	clear(): void {
		this.byEvent.set("online", []);
		this.byEvent.set("offline", []);
	}
}

class ServiceHealthMonitor {
	private healthUrl: string;
	private readonly pollIntervalMs: number;
	private listeners = new StatusListeners();
	private pollTimerId?: number;
	lastReport?: ServiceHealthReport;
	isOnline = true;

	constructor(
		private clock: Clock,
		url: string,
		interval = 10000,
	) {
		this.healthUrl = url;
		this.pollIntervalMs = interval;
	}

	public beginPolling() {
		if (!this.healthUrl) {
			// No health URL configured (relay-onprem mode) - stay online
			return;
		}
		if (!this.pollTimerId) {
			this.pollTimerId = this.clock.scheduleInterval(() => {
				void this.poll();
			}, this.pollIntervalMs);
		}
	}

	/**
	 * Re-point health checks at a new URL (e.g. the relay-onprem default
	 * server's controlPlaneUrl changed). Starts polling if it wasn't
	 * already running — mirrors the deferred-start behavior of beginPolling().
	 */
	public updateUrl(url: string) {
		this.healthUrl = url;
		if (this.healthUrl) {
			this.beginPolling();
		}
	}

	public stopPolling() {
		if (this.pollTimerId) {
			window.clearInterval(this.pollTimerId);
		}
	}

	public verifyOnline(): Promise<boolean> {
		if (this.isOnline) {
			return Promise.resolve(true);
		}
		return this.poll().then(() => this.isOnline);
	}

	private async poll(): Promise<void> {
		if (!this.healthUrl) {
			return; // No health URL configured, assume online
		}

		let response;
		try {
			response = await requestUrl({
				url: this.healthUrl,
				method: "GET",
				headers: { "Relay-Version": GIT_TAG },
			});
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes("ERR_NETWORK_CHANGED")) {
				// This doesn't necessarily imply a disconnect,
				// We should immediately try again to get a name resolution error.
				void this.poll();
				return;
			}
			this.isOnline = false;
			this.listeners.emit("offline", this.lastReport);
			return;
		}

		if (response.status === 200) {
			const responseJson = response.json as ServiceHealthReport | undefined;
			if (responseJson?.status) {
				this.lastReport = responseJson;
			}
			if (!this.isOnline) {
				namedLogger("[ServiceHealthMonitor]")("back online");
				this.isOnline = true;
				this.listeners.emit("online", this.lastReport);
			}
		} else if (this.isOnline) {
			this.isOnline = false;
			this.listeners.emit("offline", this.lastReport);
		}
	}

	public whenBackOnline(callback: Callback): void {
		this.listeners.add("online", callback, true);
	}

	public addStatusListener(eventType: StatusEventType, callback: Callback): void {
		this.listeners.add(eventType, callback, false);
	}

	dismantle() {
		this.listeners.clear();
		this.clock = null as unknown as Clock;
	}
}

export default ServiceHealthMonitor;
