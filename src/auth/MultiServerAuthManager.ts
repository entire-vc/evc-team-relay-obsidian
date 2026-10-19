/**
 * Multi-Server Authentication Manager
 *
 * Manages multiple RelayOnPremAuthProviders, one per server.
 * Provides a unified interface for authentication across multiple relay-onprem servers.
 */

import { namedLogger } from "../logging";
import type { RelayOnPremServer } from "../RelayOnPremConfig";
import type { AuthUser } from "./IAuthProvider";
import { RelayOnPremAuthProvider } from "./RelayOnPremAuthProvider";
import { RelayOnPremAuthStore, getAuthStore } from "./RelayOnPremAuthStore";

export interface ServerAuthStatus {
	serverId: string;
	serverName: string;
	isLoggedIn: boolean;
	user?: AuthUser;
}

export class MultiServerAuthManager {
	private log = namedLogger("[MultiServerAuthManager]");
	private providers: Map<string, RelayOnPremAuthProvider> = new Map();
	private appId: string;
	private authStore: RelayOnPremAuthStore;

	constructor(
		appId: string,
		servers: RelayOnPremServer[] = [],
		// forwarded to every provider this manager creates, so the
		// owner (AuthSession) learns exactly which server's session died
		// instead of the death staying invisible outside this class's map.
		private onSessionExpired?: (serverId: string) => void,
	) {
		this.appId = appId;
		// Use the shared singleton (not `new RelayOnPremAuthStore(...)`) — it's the
		// SAME instance RelayOnPremAuthProvider reads/writes through (also via
		// getAuthStore). A separate instance's evict()/persist() never touches the
		// singleton's in-memory memoryFallback cache, which _readStorage() falls
		// back to (and resurrects into local storage) when the real local storage
		// key is missing — clearing through a different instance is a no-op from
		// the provider's point of view.
		this.authStore = getAuthStore(appId);

		// Initialize providers for all configured servers
		for (const server of servers) {
			this.addServer(server);
		}
	}

	/**
	 * Add a server and create its auth provider
	 */
	addServer(server: RelayOnPremServer): void {
		if (this.providers.has(server.id)) {
			this.log(`Server ${server.id} already exists, skipping`);
			return;
		}

		this.log(`Adding server: ${server.name} (${server.id})`);
		const provider = new RelayOnPremAuthProvider({
			controlPlaneUrl: server.controlPlaneUrl,
			appId: this.appId,
			serverId: server.id,
			onSessionExpired: () => this.onSessionExpired?.(server.id),
		});

		this.providers.set(server.id, provider);
	}

	/**
	 * Remove a server and its auth provider
	 */
	removeServer(serverId: string): void {
		const provider = this.providers.get(serverId);
		if (provider) {
			this.log(`Removing server: ${serverId}`);
			// Clear auth data for this server
			this.authStore.evict(serverId);
			this.providers.delete(serverId);
		}
	}

	/**
	 * Update server configuration (recreates the provider).
	 *
	 * The auth store is keyed by serverId, not URL — if the control-plane URL
	 * changes but the id stays the same, a naive recreate would let the new
	 * provider restore the OLD host's stored token from local storage and send
	 * it to the NEW host's /v1/auth/refresh. Clear stored auth for
	 * this id first whenever the URL actually changed, forcing a fresh login
	 * against the new host instead of carrying the old token forward.
	 */
	updateServer(server: RelayOnPremServer): void {
		this.log(`Updating server: ${server.name} (${server.id})`);

		const oldProvider = this.providers.get(server.id);
		const oldUrl = oldProvider?.getControlPlaneUrl();
		const newUrl = server.controlPlaneUrl.replace(/\/+$/, "");
		if (oldUrl !== undefined && oldUrl !== newUrl) {
			this.log(`Server ${server.id} URL changed (${oldUrl} -> ${newUrl}), clearing stored auth`);
			this.authStore.evict(server.id);
		}

		// Remove old provider if exists
		this.providers.delete(server.id);
		// Create new provider with updated config
		this.addServer(server);
	}

	/**
	 * Wait for all providers to finish restoring auth from local storage.
	 * Must be called before checking auth state to avoid race conditions.
	 */
	async waitForAllRestore(): Promise<void> {
		const promises: Promise<void>[] = [];
		for (const provider of this.providers.values()) {
			promises.push(provider.waitForRestore());
		}
		await Promise.all(promises);
		this.log(`All ${promises.length} providers restored`);
	}

	/**
	 * Get auth provider for a specific server
	 */
	getProvider(serverId: string): RelayOnPremAuthProvider | undefined {
		return this.providers.get(serverId);
	}

	/**
	 * Get all providers
	 */
	getAllProviders(): Map<string, RelayOnPremAuthProvider> {
		return this.providers;
	}

	/**
	 * Get list of server IDs that are currently logged in
	 */
	getLoggedInServerIds(): string[] {
		const loggedIn: string[] = [];
		for (const [serverId, provider] of this.providers) {
			if (provider.isLoggedIn()) {
				loggedIn.push(serverId);
			}
		}
		return loggedIn;
	}

	/**
	 * Get auth status for all servers
	 */
	getAuthStatus(servers: RelayOnPremServer[]): ServerAuthStatus[] {
		return servers.map((server) => {
			const provider = this.providers.get(server.id);
			return {
				serverId: server.id,
				serverName: server.name,
				isLoggedIn: provider?.isLoggedIn() ?? false,
				user: provider?.getCurrentUser(),
			};
		});
	}

	/**
	 * Login to a specific server
	 */
	async loginToServer(serverId: string, email: string, password: string): Promise<AuthUser> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		this.log(`Logging in to server ${serverId} as ${email}`);
		const response = await provider.loginWithPassword(email, password);
		return response.user;
	}

	/**
	 * Logout from a specific server
	 */
	async logoutFromServer(serverId: string): Promise<void> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		this.log(`Logging out from server ${serverId}`);
		await provider.logout();
	}

	/**
	 * Logout from all servers
	 */
	async logoutAll(): Promise<void> {
		this.log("Logging out from all servers");
		const promises: Promise<void>[] = [];
		for (const [serverId, provider] of this.providers) {
			if (provider.isLoggedIn()) {
				promises.push(
					provider.logout().catch((error: unknown) => {
						this.log(`Error logging out from ${serverId}:`, error);
					})
				);
			}
		}
		await Promise.all(promises);
	}

	/**
	 * Check if logged in to any server
	 */
	isLoggedInToAny(): boolean {
		for (const provider of this.providers.values()) {
			if (provider.isLoggedIn()) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if logged in to a specific server
	 */
	isLoggedInToServer(serverId: string): boolean {
		const provider = this.providers.get(serverId);
		return provider?.isLoggedIn() ?? false;
	}

	/**
	 * Get user for a specific server
	 */
	getUserForServer(serverId: string): AuthUser | undefined {
		const provider = this.providers.get(serverId);
		return provider?.getCurrentUser();
	}

	/**
	 * Get token for a specific server
	 */
	getTokenForServer(serverId: string): string | undefined {
		const provider = this.providers.get(serverId);
		return provider?.getToken();
	}

	/**
	 * Get a valid token for a specific server, refreshing if needed
	 */
	async getValidTokenForServer(serverId: string): Promise<string | undefined> {
		const provider = this.providers.get(serverId);
		return provider?.getValidToken();
	}

	/**
	 * Refresh token for a specific server
	 */
	async refreshTokenForServer(serverId: string): Promise<void> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!provider.isLoggedIn()) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		await provider.refreshToken();
	}

	/**
	 * Get number of configured servers
	 */
	getServerCount(): number {
		return this.providers.size;
	}
}
