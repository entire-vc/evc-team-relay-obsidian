/**
 * Tests for RelayOnPremTokenProvider.updateControlPlaneUrl().
 *
 * The provider is created once at plugin load and held for the plugin's
 * lifetime by RelayCredentialCache — its `normalizedUrl` was baked in at
 * construction and never re-read, so editing the default server's URL in
 * settings left /tokens/relay requests going to the old host until Obsidian
 * restarted. updateControlPlaneUrl() is the fix's repoint mechanism;
 * main.ts wires it into the settings-change subscription (not covered here —
 * main.ts transitively imports AuthSession, which pulls in the ESM-only
 * `pocketbase` package and cannot be imported under this repo's Jest config).
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
	RelayOnPremTokenProvider,
	type RelayTokenResponse,
	type FileTokenApiResponse,
} from "../../src/auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";

jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/platformFetch");
import { platformFetch } from "../../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

function mockFetchResponse(data: RelayTokenResponse) {
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
		headers: new Headers(),
	} as Response);
}

function makeAuthProvider(): IAuthProvider {
	return {
		isLoggedIn: () => true,
		getCurrentUser: () => undefined,
		getToken: () => "fake-token",
		getValidToken: async () => "fake-token",
		loginWithPassword: () => Promise.reject(new Error("unused")),
		loginWithOAuth2: () => Promise.reject(new Error("unused")),
		refreshToken: () => Promise.reject(new Error("unused")),
		logout: () => Promise.reject(new Error("unused")),
		isTokenValid: () => true,
	};
}

const TOKEN_RESPONSE: RelayTokenResponse = {
	relay_url: "wss://relay.example.com",
	token: "relay-token",
	expires_at: new Date(Date.now() + 60_000).toISOString(),
};

describe("RelayOnPremTokenProvider.updateControlPlaneUrl", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("subsequent requestToken calls hit the new URL, not the one from construction", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		const first = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await first;
		expect(mockFetch).toHaveBeenCalledWith(
			"https://old-server.example.com/v1/tokens/relay",
			expect.anything(),
		);

		provider.updateControlPlaneUrl("https://new-server.example.com");

		// Second call queues behind the throttle's per-instance min-interval spacing.
		const second = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(2_400);
		await second;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/v1/tokens/relay",
			expect.anything(),
		);
	});

	test("normalizes a trailing slash on the new URL, same as the constructor does", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		provider.updateControlPlaneUrl("https://new-server.example.com/");

		const request = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await request;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/v1/tokens/relay",
			expect.anything(),
		);
	});
});

/**
 * Tests for the write->read fallback.
 *
 * The caller (RelayCredentialRefresh.ts) always requests mode "write" regardless
 * of the member's actual share role. The control-plane correctly 403s a
 * viewer's write request (app/services/share_service.py::ensure_write_access,
 * verified live against the relay host + its own test_viewer_cannot_write test) --
 * without this fallback that 403 propagated as a hard connection failure,
 * leaving viewer-role members unable to open onprem relay shares at all.
 */
describe("RelayOnPremTokenProvider.requestToken write->read fallback", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	function mockResponse(status: number, data: RelayTokenResponse | null) {
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: async () => (data ? JSON.stringify(data) : "Write access denied"),
			json: async () => data,
			headers: new Headers(),
		} as Response);
	}

	test("a 403 on a write request is retried once as read, and succeeds", async () => {
		let calls = 0;
		mockFetch.mockImplementation((_url, init) => {
			calls++;
			const body = JSON.parse((init as RequestInit).body as string);
			if (body.mode === "write") {
				return mockResponse(403, null);
			}
			expect(body.mode).toBe("read");
			return mockResponse(200, TOKEN_RESPONSE);
		});

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(2_400); // the retry queues behind the throttle
		const clientToken = await request;

		expect(calls).toBe(2);
		expect(clientToken.authorization).toBe("read-only");
		expect(clientToken.token).toBe(TOKEN_RESPONSE.token);
	});

	test("a 403 on an explicit read request does NOT retry (no infinite loop)", async () => {
		mockFetch.mockImplementation(() => mockResponse(403, null));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "read");
		const assertion = expect(request).rejects.toThrow(/403/);
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test("an editor's write request still succeeds on the first try, no fallback triggered", async () => {
		mockFetch.mockImplementation(() => mockResponse(200, TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(0);
		const clientToken = await request;

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(clientToken.authorization).toBe("full");
	});
});

/**
 * Tests for client_version being attached to /tokens/relay requests (
 * recurrence diagnosis, 2026-09-17): the only signal that lets the control-plane
 * attribute a given token issuance to a specific plugin release. User-Agent
 * alone can't do this — it carries the Obsidian/Electron app version, not the
 * plugin's.
 */
describe("RelayOnPremTokenProvider.requestToken client_version", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("sends client_version when the provider was constructed with one", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
			clientVersion: "0.0.9",
		});

		const request = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await request;

		const [, init] = mockFetch.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.client_version).toBe("0.0.9");
	});

	test("omits client_version entirely when the provider wasn't given one", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await request;

		const [, init] = mockFetch.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect("client_version" in body).toBe(false);
	});
});

/**
 * Tests for requestFileToken — the attachment (BlobClient) presigned-URL
 * token flow, wired into RelayCredentialCache.fetchFileTokenFromApi's relay-onprem
 * branch. Hits POST /shares/{id}/file-token, distinct from requestToken's
 * /tokens/relay (WebSocket doc connection). BlobClient.ts (untouched by this task)
 * reads only `token.baseUrl` and `token.token` off the result and does
 * HEAD/GET/POST against baseUrl (+ "/download-url" | "/upload-url") — so the
 * returned FileGrant MUST have baseUrl populated, not just `url`.
 */
describe("RelayOnPremTokenProvider.requestFileToken", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const FILE_TOKEN_RESPONSE: FileTokenApiResponse = {
		token: "file-scoped-token",
		base_url: "https://cp.example.com/shares/folder1/files/file1",
		expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
	};

	function mockFileTokenResponse(status: number, data: FileTokenApiResponse | null) {
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: async () => (data ? JSON.stringify(data) : "error body"),
			json: async () => data,
			headers: new Headers(),
		} as Response);
	}

	test("does not queue behind the doc-token throttle: a burst dispatches immediately", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(200, FILE_TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const burst = Array.from({ length: 50 }, (_, i) =>
			provider.requestFileToken("relay1", "folder1", `file${i}`, "deadbeef", "image/png", 1),
		);
		// No timer advance beyond a microtask flush: a throttled call would wait 2.4 s each.
		await jest.advanceTimersByTimeAsync(0);
		await Promise.all(burst);

		expect(mockFetch).toHaveBeenCalledTimes(50);
	});

	test("POSTs to /shares/{folderId}/file-token with fileId as the path, sha256/content_type/content_length in the body", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(200, FILE_TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		await jest.advanceTimersByTimeAsync(0);
		await request;

		expect(mockFetch).toHaveBeenCalledWith(
			"https://cp.example.com/v1/shares/folder1/file-token",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer fake-token",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({
					path: "file1",
					sha256: "deadbeef",
					content_type: "image/png",
					content_length: 12345,
				}),
			}),
		);
	});

	test("maps base_url into token.baseUrl (and mirrors it into token.url) — BlobClient.ts does a non-null assertion on baseUrl", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(200, FILE_TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		await jest.advanceTimersByTimeAsync(0);
		const fileToken = await request;

		expect(fileToken.baseUrl).toBe(FILE_TOKEN_RESPONSE.base_url);
		expect(fileToken.url).toBe(FILE_TOKEN_RESPONSE.base_url);
		expect(fileToken.token).toBe("file-scoped-token");
		expect(fileToken.docId).toBe("file1");
		expect(fileToken.folder).toBe("folder1");
		expect(fileToken.contentType).toBe("image/png");
		expect(fileToken.contentLength).toBe(12345);
		expect(fileToken.fileHash).toBe("deadbeef");
	});

	test("throws when not authenticated, without hitting the network", async () => {
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: {
				...makeAuthProvider(),
				getValidToken: async () => undefined,
			},
		});

		await expect(
			provider.requestFileToken("relay1", "folder1", "file1", "deadbeef", "image/png", 12345),
		).rejects.toThrow("Not authenticated");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("429 throws RateLimitError with the parsed Retry-After delay", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve({
				ok: false,
				status: 429,
				text: async () => "slow down",
				json: async () => null,
				headers: new Headers({ "Retry-After": "12" }),
			} as Response),
		);

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		const assertion = expect(request).rejects.toMatchObject({
			name: "RateLimitError",
			retryAfterMs: 12_000,
		});
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
	});

	test("a non-ok, non-429 response throws with the status and body text", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(403, null));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		const assertion = expect(request).rejects.toThrow(/403/);
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
	});
});
