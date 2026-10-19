/**
 * Tests for platformFetch.ts retry behavior.
 *
 * a mutating request (POST/PUT/PATCH/DELETE) must NOT be retried on a
 * transient network error — the error can occur *after* the server already
 * applied the write (e.g. an RST_STREAM after the record was created), so a
 * retry risks submitting the mutation twice. Only idempotent methods
 * (GET/HEAD) are safe to retry.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { requestUrl } from "obsidian";
import { platformFetch } from "../src/platformFetch";

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function retryableError(): Error {
	return new Error("net::ERR_HTTP2_PROTOCOL_ERROR (RST_STREAM)");
}

function okResponse(status = 200, body: unknown = { ok: true }) {
	const text = JSON.stringify(body);
	const buffer = new TextEncoder().encode(text).buffer;
	return {
		status,
		headers: { "content-type": "application/json" },
		arrayBuffer: buffer,
		json: body,
		text,
	};
}

describe("platformFetch — retry behavior", () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	test("does NOT retry a POST after a transient network error (no duplicate mutation)", async () => {
		mockRequestUrl.mockRejectedValueOnce(retryableError());

		const response = await platformFetch("https://relay.example/v1/shares/x/invites", {
			method: "POST",
			body: JSON.stringify({ email: "a@b.com" }),
		});

		// Surfaced as a clean 503, not silently retried
		expect(response.status).toBe(503);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	test("does NOT retry a PUT/PATCH/DELETE after a transient network error", async () => {
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			mockRequestUrl.mockReset();
			mockRequestUrl.mockRejectedValueOnce(retryableError());

			const response = await platformFetch("https://relay.example/v1/shares/x", { method });

			expect(response.status).toBe(503);
			expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		}
	});

	test("still retries a GET after a transient network error", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(retryableError())
			.mockResolvedValueOnce(okResponse(200));

		const response = await platformFetch("https://relay.example/v1/shares/x", { method: "GET" });

		expect(response.status).toBe(200);
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	test("still retries a HEAD after a transient network error", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(retryableError())
			.mockResolvedValueOnce(okResponse(200));

		const response = await platformFetch("https://relay.example/v1/shares/x", { method: "HEAD" });

		expect(response.status).toBe(200);
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	test("defaults to GET (retryable) when no method is specified", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(retryableError())
			.mockResolvedValueOnce(okResponse(200));

		const response = await platformFetch("https://relay.example/v1/shares/x");

		expect(response.status).toBe(200);
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	test("a single successful POST is not retried at all", async () => {
		mockRequestUrl.mockResolvedValueOnce(okResponse(201, { id: "invite-1" }));

		const response = await platformFetch("https://relay.example/v1/shares/x/invites", {
			method: "POST",
			body: JSON.stringify({ email: "a@b.com" }),
		});

		expect(response.status).toBe(201);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	test("a non-retryable error on POST is thrown, not swallowed into a 503", async () => {
		mockRequestUrl.mockRejectedValueOnce(new Error("some unrelated failure"));

		await expect(
			platformFetch("https://relay.example/v1/shares/x/invites", { method: "POST" }),
		).rejects.toThrow("some unrelated failure");
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});
});
