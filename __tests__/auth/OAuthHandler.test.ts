/**
 * Tests for OAuthHandler
 *
 * Tests OAuth flow orchestration with mocked dependencies.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { OAuthHandler } from "../../src/auth/OAuthHandler";

// Mock dependencies
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

jest.mock("../../src/auth/OAuthCallbackServer");
import { OAuthCallbackServer } from "../../src/auth/OAuthCallbackServer";
const MockOAuthCallbackServer = OAuthCallbackServer as jest.MockedClass<
	typeof OAuthCallbackServer
>;

// Helper to create mock fetch response
function mockFetchResponse(status: number, data: any, ok = true) {
	return Promise.resolve({
		ok: ok !== false && status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
		arrayBuffer: new ArrayBuffer(0),
		headers: new Headers(),
	} as Response);
}

describe("OAuthHandler", () => {
	const CONTROL_PLANE_URL = "https://cp.example.com";
	const SERVER_ID = "test-server-123";
	const PROVIDER = "casdoor";

	let handler: OAuthHandler;
	let mockCallbackServer: jest.Mocked<OAuthCallbackServer>;

	beforeEach(() => {
		jest.clearAllMocks();

		// Setup mock callback server
		mockCallbackServer = {
			start: jest.fn(),
			waitForCallback: jest.fn(),
			stop: jest.fn(),
		} as any;

		MockOAuthCallbackServer.mockImplementation(() => mockCallbackServer);

		handler = new OAuthHandler(CONTROL_PLANE_URL, SERVER_ID);
	});

	describe("prepareOAuthFlow()", () => {
		test("P7: Calls authorize endpoint correctly", async () => {
			const authorizeUrl = "https://casdoor.example.com/oauth/authorize?...";
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, { authorize_url: authorizeUrl, state: "state_xyz" }),
			);

			const result = await handler.prepareOAuthFlow(PROVIDER);

			expect(mockCallbackServer.start).toHaveBeenCalled();
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining(
					`${CONTROL_PLANE_URL}/v1/auth/oauth/${PROVIDER}/authorize`,
				),
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Accept: "application/json",
					}),
				}),
			);
			expect(result).toEqual({
				authorizeUrl,
				callbackUrl: "http://127.0.0.1:12345/callback",
				port: 12345,
			});
		});

		test("P8: Error stops callback server", async () => {
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(
				await mockFetchResponse(500, { error: "Server error" }, false),
			);

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"Failed to get authorize URL",
			);

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("P9: Missing authorize_url throws error", async () => {
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(await mockFetchResponse(200, {}));

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"No authorize URL returned from control plane",
			);

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("P9b-TR21: Missing state throws error (nothing to verify the callback against)", async () => {
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
				}),
			);

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"No state token returned from control plane",
			);

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("P14: URL normalization (trailing slashes)", async () => {
			const handlerWithSlash = new OAuthHandler(
				"https://cp.example.com/",
				SERVER_ID,
			);
			const handlerWithMultipleSlashes = new OAuthHandler(
				"https://cp.example.com///",
				SERVER_ID,
			);

			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);

			await handlerWithSlash.prepareOAuthFlow(PROVIDER);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://cp.example.com/v1/auth/oauth"),
				expect.anything(),
			);

			mockFetch.mockClear();

			await handlerWithMultipleSlashes.prepareOAuthFlow(PROVIDER);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://cp.example.com/v1/auth/oauth"),
				expect.anything(),
			);
		});
	});

	describe("waitForCallbackAndExchange()", () => {
		test("P10: Parses response correctly", async () => {
			mockCallbackServer.waitForCallback.mockResolvedValue({
				code: "auth_code_123",
				state: "state_xyz",
			});

			const mockUserData = {
				user_id: "user-123",
				user_email: "test@example.com",
				user_name: "Test Account",
				access_token: "access_token_abc",
				expires_in: 3600,
			};

			mockFetch.mockResolvedValue(await mockFetchResponse(200, mockUserData));

			// Need to prepare first
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);
			await handler.prepareOAuthFlow(PROVIDER);

			mockFetch.mockClear();
			mockFetch.mockResolvedValue(await mockFetchResponse(200, mockUserData));

			const result = await handler.waitForCallbackAndExchange(PROVIDER);

			expect(mockCallbackServer.waitForCallback).toHaveBeenCalledWith("state_xyz", 300000, undefined);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining(
					`/v1/auth/oauth/${PROVIDER}/callback?code=auth_code_123&state=state_xyz`,
				),
				expect.objectContaining({
					method: "GET",
				}),
			);

			expect(result).toEqual({
				user: {
					id: "user-123",
					email: "test@example.com",
					name: "Test Account",
					picture: undefined,
				},
				token: {
					token: "access_token_abc",
					expiresAt: expect.any(Number),
				},
				refreshToken: undefined,
			});
		});

		test("P11: Includes refresh_token if provided", async () => {
			mockCallbackServer.waitForCallback.mockResolvedValue({
				code: "auth_code_123",
				state: "state_xyz",
			});

			const mockUserData = {
				user_id: "user-123",
				user_email: "test@example.com",
				access_token: "access_token_abc",
				refresh_token: "refresh_token_xyz",
				expires_in: 3600,
			};

			// Prepare
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);
			await handler.prepareOAuthFlow(PROVIDER);

			mockFetch.mockClear();
			mockFetch.mockResolvedValue(await mockFetchResponse(200, mockUserData));

			const result = await handler.waitForCallbackAndExchange(PROVIDER);

			expect(result.refreshToken).toBe("refresh_token_xyz");
		});

		test("P12: Handles callback error", async () => {
			mockCallbackServer.waitForCallback.mockRejectedValue(
				new Error("OAuth callback timeout"),
			);

			// Prepare
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);
			await handler.prepareOAuthFlow(PROVIDER);

			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow("OAuth callback timeout");

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("Handles exchange API error", async () => {
			mockCallbackServer.waitForCallback.mockResolvedValue({
				code: "auth_code_123",
				state: "state_xyz",
			});

			// Prepare
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);
			await handler.prepareOAuthFlow(PROVIDER);

			mockFetch.mockClear();
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid code" }, false),
			);

			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow("OAuth callback exchange failed");

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("P15: Cleanup on error (callback server stopped)", async () => {
			// Prepare
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);
			await handler.prepareOAuthFlow(PROVIDER);

			mockCallbackServer.waitForCallback.mockRejectedValue(
				new Error("Timeout"),
			);

			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow();

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("Fails if prepareOAuthFlow not called first", async () => {
			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow(
				"Callback server not started - call prepareOAuthFlow first",
			);
		});
	});

	describe("completeOAuthFlow()", () => {
		test("P13: Chains prepare + browser + exchange", async () => {
			const authorizeUrl = "https://casdoor.example.com/oauth/authorize?...";
			const openBrowser = jest.fn();

			// Mock prepare
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, { authorize_url: authorizeUrl, state: "state_xyz" }),
			);

			// Mock callback
			mockCallbackServer.waitForCallback.mockResolvedValue({
				code: "auth_code_123",
				state: "state_xyz",
			});

			// Mock exchange
			const mockUserData = {
				user_id: "user-123",
				user_email: "test@example.com",
				access_token: "access_token_abc",
				expires_in: 3600,
			};
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, mockUserData),
			);

			const result = await handler.completeOAuthFlow(PROVIDER, openBrowser);

			expect(openBrowser).toHaveBeenCalledWith(authorizeUrl);
			expect(result.user.email).toBe("test@example.com");
			expect(result.token.token).toBe("access_token_abc");
		});

		test("Opens browser with correct URL", async () => {
			const authorizeUrl = "https://casdoor.example.com/oauth/authorize?client_id=123";
			const openBrowser = jest.fn();

			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, { authorize_url: authorizeUrl, state: "state_xyz" }),
			);

			mockCallbackServer.waitForCallback.mockResolvedValue({
				code: "code",
				state: "state",
			});

			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, {
					user_id: "u1",
					user_email: "test@test.com",
					access_token: "token",
					expires_in: 3600,
				}),
			);

			await handler.completeOAuthFlow(PROVIDER, openBrowser);

			expect(openBrowser).toHaveBeenCalledWith(authorizeUrl);
		});
	});

	describe("destroy()", () => {
		test("Stops callback server", async () => {
			mockCallbackServer.start.mockResolvedValue(12345);
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, {
					authorize_url: "https://casdoor.example.com/oauth/authorize",
					state: "state_xyz",
				}),
			);

			await handler.prepareOAuthFlow(PROVIDER);

			handler.destroy();

			expect(mockCallbackServer.stop).toHaveBeenCalled();
		});

		test("Can be called multiple times", () => {
			expect(() => {
				handler.destroy();
				handler.destroy();
			}).not.toThrow();
		});
	});
});
