import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import { OAuthCallbackServer } from "../src/auth/OAuthCallbackServer";
import { OAuthCancelledError } from "../src/auth/OAuthCancelledError";
import { OAuthHandler } from "../src/auth/OAuthHandler";
import { testGlobal } from "./mocks/testGlobal";

//: the browser sign-in wait had no way out. The only signal was a
// toast that vanishes in ~4 s, there was no cancel, and the password form only
// opened after the 5-minute callback timeout. An AbortSignal now threads from the
// server card down to the loopback callback wait; aborting settles the wait
// immediately with OAuthCancelledError so the UI can treat it as a quiet cancel.

/** A callback server whose HTTP layer is a stub: only the wait/timeout logic is real. */
function serverWithStubHttp(): OAuthCallbackServer {
	const server = new OAuthCallbackServer();
	(server as unknown as { server: unknown }).server = {
		removeAllListeners: () => undefined,
		on: () => undefined,
		close: () => undefined,
	};
	return server;
}

describe("OAuthCallbackServer.waitForCallback -- cancellation", () => {
	beforeEach(() => {
		(testGlobal as unknown as { window: unknown }).window = testGlobal;
	});

	test("a signal that aborts mid-wait settles the wait at once with OAuthCancelledError", async () => {
		const server = serverWithStubHttp();
		const controller = new AbortController();

		const wait = server.waitForCallback("state-1", 300_000, controller.signal);
		controller.abort();

		await expect(wait).rejects.toBeInstanceOf(OAuthCancelledError);
	});

	test("the wait timer is cleared on cancel (no dangling 5-minute timer)", async () => {
		const clearSpy = jest.spyOn(testGlobal, "clearTimeout");
		const server = serverWithStubHttp();
		const controller = new AbortController();

		const wait = server.waitForCallback("state-1", 300_000, controller.signal);
		controller.abort();
		await expect(wait).rejects.toBeInstanceOf(OAuthCancelledError);

		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	test("an already-aborted signal rejects without waiting", async () => {
		const server = serverWithStubHttp();
		const controller = new AbortController();
		controller.abort();

		await expect(server.waitForCallback("state-1", 300_000, controller.signal)).rejects.toBeInstanceOf(
			OAuthCancelledError,
		);
	});

	test("without a signal the wait still times out as before (the 5-minute path is unchanged)", async () => {
		const server = serverWithStubHttp();

		await expect(server.waitForCallback("state-1", 20)).rejects.toThrow(/timeout/i);
	});
});

describe("OAuthHandler.completeOAuthFlow -- cancelled while preparing", () => {
	test("does not open a browser window for a login the user already abandoned, and stops the callback server", async () => {
		const handler = new OAuthHandler("https://cp.example.com", "srv");
		const controller = new AbortController();
		const stop = jest.fn();
		// prepareOAuthFlow is real network + a real loopback server; stub it to
		// abort "while the authorize URL is being fetched".
		jest.spyOn(handler, "prepareOAuthFlow").mockImplementation(async () => {
			controller.abort();
			(handler as unknown as { callbackServer: unknown }).callbackServer = { stop };
			return { authorizeUrl: "https://idp.example/authorize", callbackUrl: "http://127.0.0.1:1/callback", port: 1 };
		});
		const openBrowser = jest.fn();

		await expect(handler.completeOAuthFlow("casdoor", openBrowser, controller.signal)).rejects.toBeInstanceOf(
			OAuthCancelledError,
		);

		expect(openBrowser).not.toHaveBeenCalled();
		expect(stop).toHaveBeenCalled();
	});
});
