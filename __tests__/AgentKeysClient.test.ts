/**
 * Tests for agent key management methods on RelayOnPremShareClient
 *
 * Covers listAgentKeys, createAgentKey, and revokeAgentKey.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
	RelayOnPremShareClient,
	AgentKey,
	CreateAgentKeyRequest,
	CreateAgentKeyResponse,
} from "../src/RelayOnPremShareClient";

// Mock dependencies
jest.mock("../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../src/platformFetch");
import { platformFetch } from "../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

// Helper to create mock fetch response
function mockFetchResponse(status: number, data: unknown, ok?: boolean) {
	return Promise.resolve({
		ok: ok !== undefined ? ok : status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
		arrayBuffer: new ArrayBuffer(0),
		headers: new Headers(),
	} as Response);
}

describe("RelayOnPremShareClient — agent key methods", () => {
	const CONTROL_PLANE_URL = "https://relay.example.com";
	const SHARE_ID = "share-abc-123";
	const KEY_ID = "key-xyz-456";

	let client: RelayOnPremShareClient;
	let mockGetAuthToken: jest.MockedFunction<() => Promise<string | undefined>>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockGetAuthToken = jest.fn().mockResolvedValue("mock-token") as jest.MockedFunction<
			() => Promise<string | undefined>
		>;
		client = new RelayOnPremShareClient(CONTROL_PLANE_URL, mockGetAuthToken);
	});

	// -------------------------------------------------------------------------
	// listAgentKeys
	// -------------------------------------------------------------------------

	describe("listAgentKeys()", () => {
		test("success: returns parsed array of agent keys", async () => {
			const agentKeys: AgentKey[] = [
				{
					id: "key-1",
					label: "CI Bot",
					share_id: SHARE_ID,
					scopes: ["write"],
					is_active: true,
					created_by: "user-id",
					created_at: "2026-05-01T00:00:00Z",
					expires_at: null,
					last_used_at: null,
				},
				{
					id: "key-2",
					label: "Deploy Bot",
					share_id: SHARE_ID,
					scopes: ["write"],
					is_active: true,
					created_by: "user-id",
					created_at: "2026-05-02T00:00:00Z",
					expires_at: "2027-05-02T00:00:00Z",
					last_used_at: "2026-05-30T12:00:00Z",
				},
			];

			mockFetch.mockResolvedValue(await mockFetchResponse(200, agentKeys));

			const result = await client.listAgentKeys(SHARE_ID);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys`,
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: "Bearer mock-token",
					}),
				}),
			);

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe("key-1");
			expect(result[1].label).toBe("Deploy Bot");
		});

		test("not authenticated: throws 'Not authenticated'", async () => {
			mockGetAuthToken.mockResolvedValue(undefined);

			await expect(client.listAgentKeys(SHARE_ID)).rejects.toThrow("Not authenticated");
		});

		test("HTTP 401: throws with status message", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Unauthorized" }, false),
			);

			await expect(client.listAgentKeys(SHARE_ID)).rejects.toThrow("401");
		});
	});

	// -------------------------------------------------------------------------
	// createAgentKey
	// -------------------------------------------------------------------------

	describe("createAgentKey()", () => {
		test("success: returns response including key field", async () => {
			const request: CreateAgentKeyRequest = { label: "CI Bot" };
			const responseData: CreateAgentKeyResponse = {
				id: "key-new-789",
				label: "CI Bot",
				share_id: SHARE_ID,
				scopes: ["write"],
				key: "sk_ci_supersecretplaintext",
				created_at: "2026-05-31T10:00:00Z",
				expires_at: null,
			};

			mockFetch.mockResolvedValue(await mockFetchResponse(201, responseData));

			const result = await client.createAgentKey(SHARE_ID, request);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys`,
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer mock-token",
						"Content-Type": "application/json",
					}),
					body: JSON.stringify(request),
				}),
			);

			expect(result.id).toBe("key-new-789");
			expect(result.key).toBe("sk_ci_supersecretplaintext");
		});

		test("with expiry: passes expires_at in body", async () => {
			const request: CreateAgentKeyRequest = {
				label: "Expiring Bot",
				expires_at: "2026-06-30T10:00:00Z",
			};
			const responseData: CreateAgentKeyResponse = {
				id: "key-exp-001",
				label: "Expiring Bot",
				share_id: SHARE_ID,
				scopes: ["write"],
				key: "sk_exp_anotherplaintextkey",
				created_at: "2026-05-31T10:00:00Z",
				expires_at: "2026-06-30T10:00:00Z",
			};

			mockFetch.mockResolvedValue(await mockFetchResponse(201, responseData));

			const result = await client.createAgentKey(SHARE_ID, request);

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					body: JSON.stringify({ label: "Expiring Bot", expires_at: "2026-06-30T10:00:00Z" }),
				}),
			);

			expect(result.expires_at).toBe("2026-06-30T10:00:00Z");
		});

		test("HTTP 403: throws with error message", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(
					403,
					{ error: "Forbidden", detail: "Agent keys require enterprise plan" },
					false,
				),
			);

			await expect(
				client.createAgentKey(SHARE_ID, { label: "Blocked Bot" }),
			).rejects.toThrow("403");
		});
	});

	// -------------------------------------------------------------------------
	// revokeAgentKey
	// -------------------------------------------------------------------------

	describe("revokeAgentKey()", () => {
		test("success: 204 no content, resolves without throwing", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(204, null),
			);

			await expect(
				client.revokeAgentKey(SHARE_ID, KEY_ID),
			).resolves.toBeUndefined();

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys/${KEY_ID}`,
				expect.objectContaining({
					method: "DELETE",
					headers: expect.objectContaining({
						Authorization: "Bearer mock-token",
					}),
				}),
			);
		});

		test("HTTP 404: throws with error message", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(
					404,
					{ error: "Not Found", detail: "Agent key not found" },
					false,
				),
			);

			await expect(
				client.revokeAgentKey(SHARE_ID, "nonexistent-key"),
			).rejects.toThrow("404");
		});
	});
});
