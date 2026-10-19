/**
 * Relay On-Premise Share Client Manager
 *
 * Manages multiple RelayOnPremShareClients, one per server.
 * Provides a unified interface for share operations across multiple servers.
 */

import { namedLogger } from "./logging";
import type { RelayOnPremServer } from "./RelayOnPremConfig";
import {
	RelayOnPremShareClient,
	type RelayOnPremShare,
	type CreateShareRequest,
	type UpdateShareRequest,
	type AddMemberRequest,
	type ShareMember,
	type Account,
	type Invite,
	type CreateInviteRequest,
	type AgentKey,
	type CreateAgentKeyRequest,
	type CreateAgentKeyResponse,
	type SyncArtifactItem,
	type SyncWriteResult,
} from "./RelayOnPremShareClient";
import type { MultiServerAuthManager } from "./auth/MultiServerAuthManager";

const log = namedLogger("[RelayOnPremShareClientManager]");

/**
 * Share with server info attached
 */
export interface ShareWithServer extends RelayOnPremShare {
	serverId: string;
	serverName: string;
}

/**
 * Cached share information with timestamp
 */
interface CachedShare {
	share: ShareWithServer;
	timestamp: number;
}

export class RelayOnPremShareClientManager {
	private clients: Map<string, RelayOnPremShareClient> = new Map();
	private authManager: MultiServerAuthManager;
	private servers: Map<string, RelayOnPremServer> = new Map();
	private shareCache: Map<string, CachedShare> = new Map(); // shareId -> cached share
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

	constructor(authManager: MultiServerAuthManager, servers: RelayOnPremServer[] = []) {
		this.authManager = authManager;

		// Initialize clients for all configured servers
		for (const server of servers) {
			this.addServer(server);
		}
	}

	/**
	 * Add a server and create its share client
	 */
	addServer(server: RelayOnPremServer): void {
		if (this.clients.has(server.id)) {
			log(`Server ${server.id} already exists, skipping`);
			return;
		}

		log(`Adding server: ${server.name} (${server.id})`);
		this.servers.set(server.id, server);

		const client = new RelayOnPremShareClient(server.controlPlaneUrl, () => {
			return this.authManager.getValidTokenForServer(server.id);
		});

		this.clients.set(server.id, client);
	}

	/**
	 * Remove a server and its share client
	 */
	removeServer(serverId: string): void {
		if (this.clients.has(serverId)) {
			log(`Removing server: ${serverId}`);
			this.clients.delete(serverId);
			this.servers.delete(serverId);
		}
	}

	/**
	 * Update server configuration (recreates the client)
	 */
	updateServer(server: RelayOnPremServer): void {
		log(`Updating server: ${server.name} (${server.id})`);
		this.removeServer(server.id);
		this.addServer(server);
	}

	/**
	 * Get share client for a specific server
	 */
	getClient(serverId: string): RelayOnPremShareClient | undefined {
		return this.clients.get(serverId);
	}

	/**
	 * Get all share clients
	 */
	getAllClients(): Map<string, RelayOnPremShareClient> {
		return this.clients;
	}

	/**
	 * List all shares from all logged-in servers
	 */
	async getAllShares(): Promise<Map<string, ShareWithServer[]>> {
		const results = new Map<string, ShareWithServer[]>();
		const loggedInServers = this.authManager.getLoggedInServerIds();

		const promises = loggedInServers.map(async (serverId) => {
			const client = this.clients.get(serverId);
			const server = this.servers.get(serverId);
			if (!client || !server) {
				return { serverId, shares: [] };
			}

			try {
				const shares = await client.listShares();
				const sharesWithServer: ShareWithServer[] = shares.map((share) => ({
					...share,
					serverId: server.id,
					serverName: server.name,
				}));
				return { serverId, shares: sharesWithServer };
			} catch (error: unknown) {
				log(`Error listing shares from server ${serverId}:`, error);
				return { serverId, shares: [] };
			}
		});

		const allResults = await Promise.all(promises);
		for (const result of allResults) {
			results.set(result.serverId, result.shares);
		}

		return results;
	}

	/**
	 * Get flat list of all shares from all logged-in servers
	 */
	async getAllSharesFlat(): Promise<ShareWithServer[]> {
		const sharesMap = await this.getAllShares();
		const allShares: ShareWithServer[] = [];
		for (const shares of sharesMap.values()) {
			allShares.push(...shares);
		}
		return allShares;
	}

	/**
	 * List shares from a specific server
	 */
	async listShares(serverId: string): Promise<RelayOnPremShare[]> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.listShares();
	}

	/**
	 * Get a specific share from a server (with caching)
	 */
	async getShare(serverId: string, shareId: string, bypassCache = false): Promise<RelayOnPremShare> {
		// Check cache first (skipped by inbound poller to detect server-side bumps promptly)
		const cacheKey = `${serverId}:${shareId}`;
		if (!bypassCache) {
			const cached = this.shareCache.get(cacheKey);
			if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
				log(`Cache hit for share ${shareId}`);
				return cached.share;
			}
		}

		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		const share = await client.getShare(shareId);
		const server = this.servers.get(serverId);
		if (server) {
			const shareWithServer: ShareWithServer = {
				...share,
				serverId: server.id,
				serverName: server.name,
			};
			// Update cache
			this.shareCache.set(cacheKey, {
				share: shareWithServer,
				timestamp: Date.now(),
			});
		}

		return share;
	}

	/**
	 * Create a new share on a specific server
	 */
	async createShare(serverId: string, request: CreateShareRequest): Promise<RelayOnPremShare> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		const share = await client.createShare(request);
		// Invalidate cache when a new share is created
		this.invalidateCache();
		return share;
	}

	/**
	 * Update a share on a specific server
	 */
	async updateShare(
		serverId: string,
		shareId: string,
		request: UpdateShareRequest
	): Promise<RelayOnPremShare> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		const share = await client.updateShare(shareId, request);
		// Invalidate cache for this specific share
		const cacheKey = `${serverId}:${shareId}`;
		this.shareCache.delete(cacheKey);
		return share;
	}

	/**
	 * Delete a share from a specific server
	 */
	async deleteShare(serverId: string, shareId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		await client.deleteShare(shareId);
		// Invalidate cache for this specific share
		const cacheKey = `${serverId}:${shareId}`;
		this.shareCache.delete(cacheKey);
	}

	/**
	 * Get members of a share
	 */
	async getShareMembers(serverId: string, shareId: string): Promise<ShareMember[]> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.getShareMembers(shareId);
	}

	/**
	 * Add a member to a share
	 */
	async addMember(
		serverId: string,
		shareId: string,
		request: AddMemberRequest
	): Promise<ShareMember> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.addMember(shareId, request);
	}

	/**
	 * Remove a member from a share
	 */
	async removeMember(serverId: string, shareId: string, userId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.removeMember(shareId, userId);
	}

	/**
	 * Update a member's role
	 */
	async updateMemberRole(
		serverId: string,
		shareId: string,
		userId: string,
		role: "viewer" | "editor"
	): Promise<ShareMember> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.updateMemberRole(shareId, userId, role);
	}

	/**
	 * Search for a user by email on a specific server
	 */
	async searchUserByEmail(serverId: string, email: string): Promise<Account> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.searchUserByEmail(email);
	}

	/**
	 * Get number of configured servers
	 */
	getServerCount(): number {
		return this.clients.size;
	}

	/**
	 * Get server info by ID
	 */
	getServer(serverId: string): RelayOnPremServer | undefined {
		return this.servers.get(serverId);
	}

	/**
	 * Get all configured servers
	 */
	getAllServers(): RelayOnPremServer[] {
		return Array.from(this.servers.values());
	}

	/**
	 * Create an invite link for a share
	 */
	async createInvite(
		serverId: string,
		shareId: string,
		request: CreateInviteRequest
	): Promise<Invite> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.createInvite(shareId, request);
	}

	/**
	 * List all invites for a share
	 */
	async listInvites(serverId: string, shareId: string): Promise<Invite[]> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.listInvites(shareId);
	}

	/**
	 * Revoke an invite link
	 */
	async revokeInvite(serverId: string, shareId: string, inviteId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.revokeInvite(shareId, inviteId);
	}

	/**
	 * Find the folder share that contains a given file path
	 * Returns the share and the relative file path within it
	 */
	async findShareForFilePath(filePath: string): Promise<{
		share: ShareWithServer;
		serverId: string;
		relativePath: string;
	} | null> {
		const allShares = await this.getAllSharesFlat();

		// Filter for folder shares and sort by path length (longest first)
		// This ensures we match the most specific folder share
		const folderShares = allShares
			.filter(share => share.kind === "folder")
			.sort((a, b) => b.path.length - a.path.length);

		for (const share of folderShares) {
			// Check if file path starts with share path
			if (filePath.startsWith(share.path)) {
				// Extract relative path within the share
				const relativePath = filePath.substring(share.path.length);
				return {
					share,
					serverId: share.serverId,
					relativePath: relativePath.startsWith("/") ? relativePath : `/${relativePath}`,
				};
			}
		}

		return null;
	}

	/**
	 * Invalidate all cached shares
	 */
	invalidateCache(): void {
		log("Invalidating share cache");
		this.shareCache.clear();
	}

	/**
	 * Invalidate cache for a specific share
	 */
	invalidateShareCache(serverId: string, shareId: string): void {
		const cacheKey = `${serverId}:${shareId}`;
		this.shareCache.delete(cacheKey);
	}

	/**
	 * List agent keys for a share
	 */
	async listAgentKeys(serverId: string, shareId: string): Promise<AgentKey[]> {
		const client = this.clients.get(serverId);
		if (!client) throw new Error(`No client for server ${serverId}`);
		return client.listAgentKeys(shareId);
	}

	/**
	 * Create an agent key for a share
	 */
	async createAgentKey(serverId: string, shareId: string, request: CreateAgentKeyRequest): Promise<CreateAgentKeyResponse> {
		const client = this.clients.get(serverId);
		if (!client) throw new Error(`No client for server ${serverId}`);
		return client.createAgentKey(shareId, request);
	}

	/**
	 * Revoke an agent key
	 */
	async revokeAgentKey(serverId: string, shareId: string, keyId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) throw new Error(`No client for server ${serverId}`);
		return client.revokeAgentKey(shareId, keyId);
	}

	/**
	 * Clean up expired cache entries
	 */
	cleanExpiredCache(): void {
		const now = Date.now();
		const keysToDelete: string[] = [];

		this.shareCache.forEach((cached, key) => {
			if (now - cached.timestamp >= this.CACHE_TTL) {
				keysToDelete.push(key);
			}
		});

		keysToDelete.forEach(key => this.shareCache.delete(key));

		if (keysToDelete.length > 0) {
			log(`Cleaned ${keysToDelete.length} expired cache entries`);
		}
	}

	/**
	 * Sync file content for a folder share (v1.8 web editing)
	 */
	async syncFolderFileContent(
		serverId: string,
		slug: string,
		path: string,
		content: string
	): Promise<void> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		return client.syncFolderFileContent(slug, path, content);
	}

	/**
	 * Get the files index for a share (Bearer JWT, v1.9 inbound sync)
	 */
	async getFilesIndex(serverId: string, shareId: string): Promise<SyncArtifactItem[]> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}
		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}
		return client.getFilesIndex(shareId);
	}

	/**
	 * Download a sync-artifact file by relative path (Bearer JWT, v1.9 inbound sync)
	 */
	async downloadFile(serverId: string, shareId: string, filePath: string): Promise<ArrayBuffer> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}
		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}
		return client.downloadFile(shareId, filePath);
	}

	/**
	 * Write one document's real content into a folder share (see
	 * RelayOnPremShareClient.syncWriteFile for why this exists).
	 */
	async syncWriteFile(
		serverId: string,
		shareId: string,
		path: string,
		content: string,
		precondition: { create: true } | { ifMatchSha256: string },
		mime?: string,
	): Promise<SyncWriteResult> {
		const client = this.clients.get(serverId);
		if (!client) {
			throw new Error(`Server ${serverId} not found`);
		}
		if (!this.authManager.isLoggedInToServer(serverId)) {
			throw new Error(`Not logged in to server ${serverId}`);
		}
		return mime
			? client.syncWriteFile(shareId, path, content, precondition, mime)
			: client.syncWriteFile(shareId, path, content, precondition);
	}
}
