/**
 * Integration tests: agent-key lifecycle + share files read/write flow.
 *
 * Tests multiple RelayOnPremShareClient methods working together in sequence,
 * with platformFetch mocked only at the HTTP boundary (true external boundary per
 * mocking convention). Covers:
 *   (1) agent-key management: create → list (verify present) → revoke → list (verify gone)
 *   (2) share files read: getFilesIndex → downloadFile → verify binary content
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

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
import {
	RelayOnPremShareClient,
	type AgentKey,
	type CreateAgentKeyResponse,
	type SyncArtifactItem,
} from "../../src/RelayOnPremShareClient";

const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

const CONTROL_PLANE_URL = "https://relay.example.com";
const SHARE_ID = "share-integration-001";
const AUTH_TOKEN = "bearer-integration-token";

function makeResponse(status: number, data: unknown) {
	const body = JSON.stringify(data);
	return Promise.resolve({
		ok: status < 400,
		status,
		text: async () => body,
		json: async () => data,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer,
		headers: new Headers(),
	} as Response);
}

describe("Integration: agent-key management flow", () => {
	let client: RelayOnPremShareClient;

	beforeEach(() => {
		jest.clearAllMocks();
		client = new RelayOnPremShareClient(
			CONTROL_PLANE_URL,
			jest.fn().mockResolvedValue(AUTH_TOKEN),
		);
	});

	test("create → list (present) → revoke → list (empty) lifecycle", async () => {
		const KEY_ID = "key-integ-abc";
		const KEY_PLAIN = "sk_integ_supersecret";

		const createdKey: CreateAgentKeyResponse = {
			id: KEY_ID,
			label: "Integration CI bot",
			share_id: SHARE_ID,
			scopes: ["write"],
			key: KEY_PLAIN,
			created_at: "2026-06-18T00:00:00Z",
			expires_at: null,
		};

		const listedKey: AgentKey = {
			id: KEY_ID,
			label: "Integration CI bot",
			share_id: SHARE_ID,
			scopes: ["write"],
			is_active: true,
			created_by: "user-1",
			created_at: "2026-06-18T00:00:00Z",
			expires_at: null,
			last_used_at: null,
		};

		// Step 1: create agent key
		mockFetch.mockResolvedValueOnce(await makeResponse(201, createdKey));
		const createResult = await client.createAgentKey(SHARE_ID, { label: "Integration CI bot" });
		expect(createResult.id).toBe(KEY_ID);
		expect(createResult.key).toBe(KEY_PLAIN);

		// Step 2: list — key is present
		mockFetch.mockResolvedValueOnce(await makeResponse(200, [listedKey]));
		const listAfterCreate = await client.listAgentKeys(SHARE_ID);
		expect(listAfterCreate).toHaveLength(1);
		expect(listAfterCreate[0].id).toBe(KEY_ID);
		expect(listAfterCreate[0].is_active).toBe(true);

		// Verify the correct endpoints were hit in order
		expect(mockFetch).toHaveBeenNthCalledWith(
			1,
			`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys`,
			expect.objectContaining({ method: "POST" }),
		);
		expect(mockFetch).toHaveBeenNthCalledWith(
			2,
			`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys`,
			expect.objectContaining({ method: "GET" }),
		);

		// Step 3: revoke
		mockFetch.mockResolvedValueOnce(await makeResponse(204, null));
		await expect(client.revokeAgentKey(SHARE_ID, KEY_ID)).resolves.toBeUndefined();
		expect(mockFetch).toHaveBeenNthCalledWith(
			3,
			`${CONTROL_PLANE_URL}/v1/web/shares/${SHARE_ID}/agent-keys/${KEY_ID}`,
			expect.objectContaining({ method: "DELETE" }),
		);

		// Step 4: list — now empty
		mockFetch.mockResolvedValueOnce(await makeResponse(200, []));
		const listAfterRevoke = await client.listAgentKeys(SHARE_ID);
		expect(listAfterRevoke).toHaveLength(0);

		// Confirm all 4 HTTP calls were made in correct sequence
		expect(mockFetch).toHaveBeenCalledTimes(4);
	});

	test("all calls carry Authorization: Bearer header", async () => {
		mockFetch.mockResolvedValue(await makeResponse(200, []));
		await client.listAgentKeys(SHARE_ID);

		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: `Bearer ${AUTH_TOKEN}` }),
			}),
		);
	});

	test("create fails with 401 → propagates auth error", async () => {
		mockFetch.mockResolvedValueOnce(
			await makeResponse(401, { error: "Token expired" }),
		);
		await expect(
			client.createAgentKey(SHARE_ID, { label: "Should fail" }),
		).rejects.toThrow("401");
	});
});

describe("Integration: share files read flow", () => {
	let client: RelayOnPremShareClient;

	beforeEach(() => {
		jest.clearAllMocks();
		client = new RelayOnPremShareClient(
			CONTROL_PLANE_URL,
			jest.fn().mockResolvedValue(AUTH_TOKEN),
		);
	});

	test("getFilesIndex → downloadFile in sequence produces file content", async () => {
		const fileIndex: SyncArtifactItem[] = [
			{
				path: "docs/architecture.md",
				sha256: "sha256-abcdef001",
				size: 512,
				updated_at: "2026-06-18T10:00:00Z",
				type: "sync-artifact",
			},
			{
				path: "docs/readme.md",
				sha256: "sha256-abcdef002",
				size: 256,
				updated_at: "2026-06-18T09:00:00Z",
				type: "sync-artifact",
			},
		];
		const fileContent = new TextEncoder().encode("# Architecture\n\nSee design docs.");

		// Step 1: fetch file index
		mockFetch.mockResolvedValueOnce(await makeResponse(200, fileIndex));
		const index = await client.getFilesIndex(SHARE_ID);
		expect(index).toHaveLength(2);
		expect(index[0].path).toBe("docs/architecture.md");
		expect(index[0].sha256).toBe("sha256-abcdef001");

		// Step 2: download a file from the index
		mockFetch.mockResolvedValueOnce(
			await makeResponse(200, fileContent),
		);
		const downloaded = await client.downloadFile(SHARE_ID, index[0].path);
		expect(downloaded).toBeInstanceOf(ArrayBuffer);
		expect(downloaded.byteLength).toBeGreaterThan(0);

		// Verify getFilesIndex hit the correct endpoint
		expect(mockFetch).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining(`/shares/${SHARE_ID}/files-index`),
			expect.objectContaining({ method: "GET" }),
		);

		// Verify downloadFile encoded the path correctly
		expect(mockFetch).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining(encodeURIComponent("docs/architecture.md")),
			expect.objectContaining({ method: "GET" }),
		);

		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test("getFilesIndex returns empty array when share has no files", async () => {
		mockFetch.mockResolvedValueOnce(await makeResponse(200, []));
		const index = await client.getFilesIndex(SHARE_ID);
		expect(index).toEqual([]);
	});

	test("downloadFile propagates 404 when file not found", async () => {
		mockFetch.mockResolvedValueOnce(
			await makeResponse(404, { error: "File not found" }),
		);
		await expect(
			client.downloadFile(SHARE_ID, "nonexistent/file.md"),
		).rejects.toThrow("404");
	});
});
