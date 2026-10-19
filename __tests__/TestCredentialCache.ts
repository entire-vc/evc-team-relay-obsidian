import { CredentialCache } from "../src/CredentialCache";
import { MockClock } from "./mocks/MockClock";
import { describe, expect, test } from "@jest/globals";

interface TestToken {
	token: string;
}

export async function _testTokenStore() {
	// Setup
	const testTimeProvider = new MockClock();
	console.log(testTimeProvider);
	const mockLog = (message: string) => console.log(`Log: ${message}`);
	const mockRefresh = (
		documentId: string,
		callback: (newToken: TestToken) => void,
	) => {
		testTimeProvider.scheduleTimeout(() => {
			callback({
				token: (testTimeProvider.now() + 30 * 60 * 1000).toString(),
			});
		}, 100);
	};
	const _testGetJwtExpiry = (token: TestToken) => {
		return parseInt(token.token);
	};

	const tokenStore = new CredentialCache<TestToken>(
		{
			logMessage: mockLog,
			refreshToken: mockRefresh,
			getClock: () => testTimeProvider,
			getTokenExpiry: _testGetJwtExpiry,
		},
		1,
	);

	// Start the CredentialCache processing
	tokenStore.startSweeping();

	// Add some tokens, some of which are close to expiry
	const tokenPromise = Promise.all([
		tokenStore.acquireToken("doc1", "/doc1.md", () => {
			console.log("doc 1 callback");
		}),
		tokenStore.acquireToken("doc2", "/doc2.md", () => {
			console.log("doc 2 callback");
		}),
	]);

	// Advance time for response to happen
	testTimeProvider.setTime(testTimeProvider.now() + 1000); // Advance time by 1 second

	await tokenPromise;

	tokenStore.logLine(tokenStore.summarize());

	// Advance time to trigger refresh of tokens close to expiry
	testTimeProvider.setTime(testTimeProvider.now() + 5 * 60 * 1000); // Advance time by 5 minutes
	tokenStore.logLine(tokenStore.summarize());

	testTimeProvider.setTime(testTimeProvider.now() + 20 * 60 * 1000); // Advance time by 20 minutes
	tokenStore.logLine(tokenStore.summarize());
	// Stop the CredentialCache processing to clean up
	tokenStore.stopSweeping();

	testTimeProvider.setTime(testTimeProvider.now() + 1000); // Advance time by 1 second
	testTimeProvider.setTime(testTimeProvider.now() + 1000); // Advance time by 1 second
	tokenStore.logLine(tokenStore.summarize());

	tokenStore.resetState();

	tokenStore.logLine(tokenStore.summarize());
}

describe("token store", () => {
	test("refresh failures increment attempts", async () => {
		const tp = new MockClock();
		const failingRefresh = (
			_id: string,
			_cb: (tok: TestToken) => void,
			errCb: (err: Error) => void,
		) => {
			errCb(new Error("fail"));
		};
		const store = new CredentialCache<TestToken>(
			{
				logMessage: () => undefined,
				refreshToken: failingRefresh,
				getClock: () => tp,
				getTokenExpiry: () => tp.now() + 1000,
			},
			1,
		);

		try {
			await store.acquireToken("doc1", "doc1", () => undefined);
		} catch (_) {
			// expected: token acquisition fails in this scenario
		}
		expect((store as any).tokenEntries.get("doc1").attempts).toBe(1);

		try {
			await store.acquireToken("doc1", "doc1", () => undefined);
		} catch (_) {
			// expected: token acquisition fails in this scenario
		}

		expect((store as any).tokenEntries.get("doc1").attempts).toBe(2);

		store.teardown();
	});
});
