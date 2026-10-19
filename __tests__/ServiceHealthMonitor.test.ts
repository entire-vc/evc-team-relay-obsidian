import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import { requestUrl } from "obsidian";
import ServiceHealthMonitor from "../src/ServiceHealthMonitor";
import { MockClock } from "./mocks/MockClock";

const mockRequestUrl = requestUrl as jest.Mock;

describe("ServiceHealthMonitor (offline detection dead when url is empty)", () => {
	let timeProvider: MockClock;

	beforeEach(() => {
		mockRequestUrl.mockReset();
		timeProvider = new MockClock();
	});

	test("start() with no url is a no-op — never polls, stays online", () => {
		const status = new ServiceHealthMonitor(timeProvider, "");
		status.beginPolling();

		timeProvider.setTime(timeProvider.now() + 60_000);

		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(status.isOnline).toBe(true);
	});

	test("start() with a url polls on the interval", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		const status = new ServiceHealthMonitor(timeProvider, "https://cp.example.com/v1/health", 1000);
		status.beginPolling();

		timeProvider.setTime(timeProvider.now() + 1000);
		await Promise.resolve();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://cp.example.com/v1/health" }),
		);
	});

	test("updateUrl() from empty to a real url starts polling (deferred-start bug)", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		// Constructed before the relay-onprem default server resolved — exactly
		// what happens if start() ran while url was still "".
		const status = new ServiceHealthMonitor(timeProvider, "", 1000);
		status.beginPolling();

		timeProvider.setTime(timeProvider.now() + 5000);
		expect(mockRequestUrl).not.toHaveBeenCalled();

		status.updateUrl("https://cp.example.com/v1/health");
		timeProvider.setTime(timeProvider.now() + 1000);
		await Promise.resolve();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://cp.example.com/v1/health" }),
		);
	});

	test("offline/online callbacks fire around a failed then recovered check", async () => {
		const status = new ServiceHealthMonitor(timeProvider, "https://cp.example.com/v1/health", 1000);
		const onOffline = jest.fn();
		const onOnline = jest.fn();
		status.addStatusListener("offline", onOffline);
		status.addStatusListener("online", onOnline);

		mockRequestUrl.mockRejectedValueOnce(new Error("network down"));
		status.beginPolling();
		timeProvider.setTime(timeProvider.now() + 1000);
		await Promise.resolve();
		await Promise.resolve();

		expect(status.isOnline).toBe(false);
		expect(onOffline).toHaveBeenCalledTimes(1);

		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { status: "ok" } });
		timeProvider.setTime(timeProvider.now() + 1000);
		await Promise.resolve();
		await Promise.resolve();

		expect(status.isOnline).toBe(true);
		expect(onOnline).toHaveBeenCalledTimes(1);
	});
});
