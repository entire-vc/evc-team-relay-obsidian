"use strict";

import { Notice } from "obsidian";
import { Account } from "./Account";
import { instanceLabels } from "./logging";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { isRelayOnPremMode } from "./auth/AuthProviderFactory";
import { loginWithEmailPassword, loginWithOAuth2 as loginWithOAuth2Ext, logoutUser, getCurrentUserFromProvider, resolveUserAfterFailedLogin, resolveCurrentUserForServer } from "./AuthSessionExtensions";
import type { RelayOnPremSettings, RelayOnPremServer } from "./RelayOnPremConfig";
import { getServerById, withUpdatedLastUserEmail } from "./RelayOnPremConfig";
import { Notifier } from "./notifiers/Notifier";
import { MultiServerAuthManager, type ServerAuthStatus } from "./auth/MultiServerAuthManager";

import type { Clock } from "./Clock";
import type { SettingsScope } from "./SettingsPersistence";
import type { TenantRegistry } from "./TenantRegistry";

export interface AuthSettings {
	provider: string | undefined;
}

export class AuthSession extends Notifier<AuthSession> {
	private settingsOpener: () => Promise<void>;
	currentUser?: Account;
	private tenantRegistry: TenantRegistry;

	// Relay-onprem support (legacy single-server)
	private authProvider?: IAuthProvider;
	private relayOnPremSettings?: RelayOnPremSettings;
	private isRelayOnPrem: boolean = false;

	// Multi-server auth manager
	private multiServerAuthManager?: MultiServerAuthManager;
	private activeServerId?: string;
	private _restorePromise?: Promise<void>;
	private refreshListeners = new Set<(serverId: string) => void>();

	constructor(
		// Obsidian's stable per-vault-instance id — survives vault rename.
		// Used for relay-onprem auth storage keying.
		private appId: string,
		openSettings: () => Promise<void>,
		timeProvider: Clock,
		private preLoginHook: () => void,
		public preferredProviderSettings: SettingsScope<AuthSettings>,
		endpointManager: TenantRegistry,
		relayOnPremSettings?: RelayOnPremSettings,
		private relayOnPremSettingsStore?: SettingsScope<RelayOnPremSettings>,
	) {
		super();
		this.tenantRegistry = endpointManager;

		// Initialize relay-onprem if enabled
		if (relayOnPremSettings) {
			this.relayOnPremSettings = relayOnPremSettings;
			this.isRelayOnPrem = isRelayOnPremMode(relayOnPremSettings);

			if (this.isRelayOnPrem) {
				this.log("Initializing in relay-onprem mode with multi-server support");

				// Initialize multi-server auth manager
				this.multiServerAuthManager = new MultiServerAuthManager(
					appId,
					relayOnPremSettings.servers,
					(serverId) => this.handleSessionExpired(serverId),
					(serverId) => {
						for (const listener of this.refreshListeners) listener(serverId);
					},
				);

				// Set active server to default
				this.activeServerId = relayOnPremSettings.defaultServerId;
				if (!this.activeServerId && relayOnPremSettings.servers.length > 0) {
					this.activeServerId = relayOnPremSettings.servers[0].id;
				}

				// Get auth provider for the active server (for backward compatibility)
				if (this.activeServerId) {
					this.authProvider = this.multiServerAuthManager.getProvider(this.activeServerId);
				}

				// In relay-onprem mode, we don't need PocketBase or cloud-backend connectivity
				// Return early to avoid initializing PocketBase
				this.settingsOpener = openSettings;

				// Start async auth restore — await via waitForRestore() before using auth state
				this._restorePromise = this.multiServerAuthManager.waitForAllRestore().then(() => {
					// After restore completes, update user from active server
					if (this.authProvider) {
						const currentUser = getCurrentUserFromProvider(this.authProvider);
						if (currentUser) {
							this.currentUser = currentUser;
							this.log("Restored relay-onprem user:", currentUser.emailAddress);
							this.notifySubscribers();
						}
					}
				});

				return;
			}
		}

		// Reaching this point at all requires relayOnPrem.enabled=false, which
		// has no UI path -- only a manual data.json edit. The EVC build ships
		// relay-onprem only (no legacy cloud), so there is nothing left to
		// initialize here; just tell the user their config is unsupported.
		new Notice(
			"Team Relay: relay-onprem mode is disabled. " +
				"Re-enable relay-onprem mode in plugin settings.",
			10000
		);
		this.settingsOpener = openSettings;
		instanceLabels.set(this, "AuthSession instance");
	}

	/**
	 * Wait for auth restoration to complete.
	 * Must be called before using auth state after plugin load.
	 */
	async waitForRestore(): Promise<void> {
		if (this._restorePromise) {
			await this._restorePromise;
		}
	}

	/**
	 * Called once at plugin startup. In relay-onprem mode (always, in the
	 * shipped build) auth is restored asynchronously via waitForRestore()
	 * instead, so this always returns false -- main.ts's call site already
	 * expects and documents exactly that.
	 */
	initialize(): boolean {
		this.notifySubscribers();
		return false;
	}

	resetPreferredProvider() {
		void this.preferredProviderSettings.writeValue({ provider: undefined });
	}

	public get isAuthenticated() {
		return this.currentUser !== undefined;
	}

	/**
	 * Exposes the underlying `TenantRegistry` so callers can read/adjust
	 * the configured server endpoints directly.
	 */
	resolveTenantRegistry(): TenantRegistry {
		return this.tenantRegistry;
	}

	/**
	 * Re-checks the configured server endpoints and persists whatever the
	 * validation decided (endpoint URLs, license info). Used by the
	 * "Configure enterprise tenant" flow, independent of relay-onprem mode.
	 */
	async reconcileEndpoints(timeoutMs?: number): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: unknown;
	}> {
		return this.tenantRegistry.applyValidatedEndpoints(timeoutMs);
	}

	get hasActiveUser() {
		return this.currentUser !== undefined;
	}

	signOut() {
		// Handle logout for relay-onprem mode
		if (this.isRelayOnPrem && this.authProvider) {
			logoutUser(this.authProvider).catch((error: unknown) => {
				this.error("Logout error:", error);
			});
		}
		this.currentUser = undefined;
		this.notifySubscribers();
	}

	/**
	 * Webview redirect intercepts for the legacy cloud OAuth
	 * flow -- removed as dead code, always returned `[]` in the
	 * shipped relay-onprem build. Kept as a no-op because main.ts still calls
	 * it unconditionally at startup.
	 */
	resolveWebviewIntercepts(): RegExp[] {
		return [];
	}

	async presentLoginPage() {
		await this.settingsOpener();
		const promise = new Promise<boolean>((resolve, reject) => {
			const isLoggedIn = () => {
				if (this.isAuthenticated) {
					this.off(isLoggedIn);
					resolve(true);
				}
				resolve(false);
			};
			this.on(isLoggedIn);
		});
		return await promise;
	}

	/**
	 * Login with email and password (relay-onprem mode only)
	 * This is the legacy single-server login method
	 */
	async loginWithEmailAndPassword(email: string, password: string): Promise<boolean> {
		if (!this.isRelayOnPrem || !this.authProvider) {
			throw new Error("Email/password login is only available in relay-onprem mode");
		}

		this.preLoginHook();
		this.log(`Attempting relay-onprem login for ${email}`);

		// Snapshot the pre-existing session BEFORE attempting this login
		// (analog) — a failed re-login (e.g. a
		// typo'd password re-entered while already logged in, for whatever
		// reason) must not clear a session that was working fine. See
		// resolveUserAfterFailedLogin for why restoring this unconditionally
		// is safe here (single-await try block, no partial-mutation risk).
		const previousUser = this.currentUser;

		try {
			const user = await loginWithEmailPassword(this.authProvider, email, password);
			this.currentUser = user;
			this.notifySubscribers();
			this.log("Relay-onprem login successful");
			return true;
		} catch (error: unknown) {
			this.log("Relay-onprem login failed:", error);
			this.currentUser = resolveUserAfterFailedLogin(previousUser);
			this.notifySubscribers();
			throw error;
		}
	}

	/**
	 * Login with OAuth2 (relay-onprem mode).
	 *
	 * callers used to invoke `authProvider.loginWithOAuth2`
	 * directly, bypassing AuthSession entirely — `this.currentUser` was never set and
	 * `notifySubscribers()` was never called, so the `on()` listener main.ts
	 * registers (which gates `_onLogin()`/`loadRelayOnPremShares()` on
	 * `this.isAuthenticated`) never fired. Shares/live-sync only started after a
	 * plugin reload happened to re-run the "already logged in" restore path.
	 * Mirrors `loginToServer`'s single/multi-server + notify pattern exactly
	 * so OAuth and password login produce identical downstream effects.
	 *
	 * serverId: pass the specific server being logged into (multi-server
	 * mode); omit for the legacy single-server flow (uses `this.authProvider`
	 * directly, like `loginWithEmailAndPassword`).
	 */
	async loginWithOAuth2(provider: string, serverId?: string, signal?: AbortSignal): Promise<boolean> {
		if (!this.isRelayOnPrem) {
			throw new Error("OAuth2 login is only available in relay-onprem mode");
		}

		const authProvider = serverId
			? this.getAuthProviderForServer(serverId)
			: this.authProvider;

		if (!authProvider) {
			throw new Error("Auth provider not available");
		}

		this.preLoginHook();
		this.log(`Attempting OAuth2 login (${provider})${serverId ? ` for server ${serverId}` : ""}`);

		try {
			const user = await loginWithOAuth2Ext(authProvider, provider, signal);

			if (serverId && this.relayOnPremSettings) {
				const server = getServerById(this.relayOnPremSettings, serverId);
				if (server) {
					server.lastUserEmail = user.emailAddress;
				}
			}

			// If this is the active server (or single-server mode), update the current user
			if (!serverId || serverId === this.activeServerId) {
				if (serverId) {
					this.authProvider = authProvider;
				}
				this.currentUser = user;
			}

			this.notifySubscribers();
			this.log("OAuth2 login successful");
			return true;
		} catch (error: unknown) {
			this.log("OAuth2 login failed:", error);
			this.notifySubscribers();
			throw error;
		}
	}

	/**
	 * Check if relay-onprem mode is enabled
	 */
	isRelayOnPremMode(): boolean {
		return this.isRelayOnPrem;
	}

	/**
	 * Get the auth provider (for advanced usage)
	 * Returns the auth provider for the active server
	 */
	getAuthProvider(): IAuthProvider | undefined {
		return this.authProvider;
	}

	// ---------------------------------------------------------------
	// Multi-server methods
	// ---------------------------------------------------------------

	/**
	 * Get the multi-server auth manager
	 */
	getMultiServerAuthManager(): MultiServerAuthManager | undefined {
		return this.multiServerAuthManager;
	}

	/**
	 * Get auth provider for a specific server
	 */
	getAuthProviderForServer(serverId: string): IAuthProvider | undefined {
		return this.multiServerAuthManager?.getProvider(serverId);
	}

	/**
	 * Resolve the logged-in user for a SPECIFIC server, not just whichever
	 * server happens to be `activeServerId` right now.
	 *
	 * `this.currentUser` is only ever updated `if (!serverId ||
	 * serverId === this.activeServerId)` (see loginWithOAuth2/loginWithEmailPassword
	 * above) — a document/share whose own `onpremServerId` differs from the
	 * currently-active server never gets reflected there, even after that
	 * server's own login succeeds. A caller that knows which server it cares
	 * about (any per-document/per-share awareness identity) should go through
	 * this method instead of reading `currentUser` directly.
	 *
	 * `serverId` omitted → legacy behaviour, same as reading `currentUser`
	 * (matches ProviderBacked's own fallback for docs/folders created before
	 * `onpremServerId` existed).
	 */
	getCurrentUserForServer(serverId?: string): Account | undefined {
		return resolveCurrentUserForServer(
			this.currentUser,
			serverId ? this.getAuthProviderForServer(serverId) : undefined,
			serverId,
		);
	}

	/**
	 * Re-authenticate for a sensitive action (e.g. creating agent keys).
	 * Uses silent token refresh (refresh token endpoint) to obtain a new access
	 * token with a recent iat claim — no OAuth popup or external redirect.
	 */
	async reAuthForSensitiveAction(serverId: string): Promise<void> {
		const provider = this.multiServerAuthManager?.getProvider(serverId) ?? this.authProvider;
		if (!provider) return;
		await provider.refreshToken();
	}

	/**
	 * Login to a specific server
	 */
	async loginToServer(serverId: string, email: string, password: string): Promise<boolean> {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server login is only available in relay-onprem mode");
		}

		this.preLoginHook();
		this.log(`Attempting login to server ${serverId} as ${email}`);

		try {
			await this.multiServerAuthManager.loginToServer(serverId, email, password);

			// Update server's lastUserEmail in settings. Mutate the in-memory
			// snapshot for immediate reads within this session, AND persist
			// via SettingsScope.mutateValue() — mutating the snapshot
			// alone never reaches disk, so lastUserEmail was lost on restart.
			if (this.relayOnPremSettings) {
				const server = getServerById(this.relayOnPremSettings, serverId);
				if (server) {
					server.lastUserEmail = email;
				}
			}
			if (this.relayOnPremSettingsStore) {
				await this.relayOnPremSettingsStore.mutateValue((current) =>
					withUpdatedLastUserEmail(current, serverId, email)
				);
			}

			// If this is the active server, update the current user
			if (serverId === this.activeServerId) {
				this.authProvider = this.multiServerAuthManager.getProvider(serverId);
				if (this.authProvider) {
					const currentUser = getCurrentUserFromProvider(this.authProvider);
					if (currentUser) {
						this.currentUser = currentUser;
					}
				}
			}

			this.notifySubscribers();
			this.log(`Login to server ${serverId} successful`);
			return true;
		} catch (error: unknown) {
			this.log(`Login to server ${serverId} failed:`, error);
			this.notifySubscribers();
			throw error;
		}
	}

	/**
	 * Logout from a specific server
	 */
	async logoutFromServer(serverId: string): Promise<void> {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server logout is only available in relay-onprem mode");
		}

		this.log(`Logging out from server ${serverId}`);

		try {
			await this.multiServerAuthManager.logoutFromServer(serverId);

			// If this is the active server, clear the current user
			if (serverId === this.activeServerId) {
				this.currentUser = undefined;
			}

			this.notifySubscribers();
		} catch (error: unknown) {
			this.log(`Logout from server ${serverId} failed:`, error);
			throw error;
		}
	}

	/**
	 * a server's refresh token was rejected by the control plane
	 * (401/403) — that provider already cleared its own internal auth state
	 * and has no way to reach `this.currentUser`/`notifySubscribers` itself, so it
	 * calls back here. Multi-server sync runs against ALL configured
	 * servers concurrently, not just the active one (RelayOnPremShareClientManager
	 * wires every server independently of activeServerId) — so a background
	 * server's expiry is a live, in-use failure mode, not a cosmetic one,
	 * and must still surface a Notice + notifySubscribers() for anything
	 * reading per-server status (e.g. the server list UI). Only the visible
	 * `this.currentUser`/`isAuthenticated` state is scoped to the active server, since
	 * that's the single-user surface the rest of the plugin reads.
	 */
	/** Called with a server id whenever that server's session is refreshed in the background. */
	onTokenRefreshed(listener: (serverId: string) => void): () => void {
		this.refreshListeners.add(listener);
		return () => this.refreshListeners.delete(listener);
	}

	private handleSessionExpired(serverId: string): void {
		this.log(`Session expired for server ${serverId}`);

		const serverName = this.relayOnPremSettings
			? getServerById(this.relayOnPremSettings, serverId)?.name
			: undefined;
		const label = serverName ?? serverId;

		if (serverId === this.activeServerId) {
			this.currentUser = undefined;
			new Notice(`Your session for ${label} has expired. Please log in again.`);
		} else {
			new Notice(`Session for ${label} expired in the background. Reconnect when you're ready.`);
		}

		// notifySubscribers() delivers asynchronously (Notifier -> NotificationDispatcher,
		// ~20ms deferred, not synchronous) — matches every other notifySubscribers()
		// call in this class, so existing subscribers (main.ts's login/logout
		// listener) already tolerate the delay.
		this.notifySubscribers();
	}

	/**
	 * Set the active server for single-user operations
	 */
	setActiveServer(serverId: string): void {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server mode is only available in relay-onprem mode");
		}

		this.log(`Setting active server to ${serverId}`);
		this.activeServerId = serverId;
		this.authProvider = this.multiServerAuthManager.getProvider(serverId);

		// Update current user from the new active server
		if (this.authProvider) {
			const currentUser = getCurrentUserFromProvider(this.authProvider);
			this.currentUser = currentUser || undefined;
		} else {
			this.currentUser = undefined;
		}

		this.notifySubscribers();
	}

	/**
	 * Get the active server ID
	 */
	getActiveServerId(): string | undefined {
		return this.activeServerId;
	}

	/**
	 * Get list of logged-in server IDs
	 */
	getLoggedInServers(): string[] {
		return this.multiServerAuthManager?.getLoggedInServerIds() || [];
	}

	/**
	 * Get auth status for all configured servers
	 */
	getAuthStatusForAllServers(): ServerAuthStatus[] {
		if (!this.multiServerAuthManager || !this.relayOnPremSettings) {
			return [];
		}
		return this.multiServerAuthManager.getAuthStatus(this.relayOnPremSettings.servers);
	}

	/**
	 * Check if logged in to any server
	 */
	isLoggedInToAnyServer(): boolean {
		return this.multiServerAuthManager?.isLoggedInToAny() || false;
	}

	/**
	 * Check if logged in to a specific server
	 */
	isLoggedInToServer(serverId: string): boolean {
		return this.multiServerAuthManager?.isLoggedInToServer(serverId) || false;
	}

	/**
	 * Add a new server to the auth manager
	 */
	addServer(server: RelayOnPremServer): void {
		if (!this.multiServerAuthManager) {
			return;
		}
		this.multiServerAuthManager.addServer(server);
		this.notifySubscribers();
	}

	/**
	 * Remove a server from the auth manager
	 */
	removeServer(serverId: string): void {
		if (!this.multiServerAuthManager) {
			return;
		}

		// If removing the active server, clear user and switch to another
		if (serverId === this.activeServerId) {
			this.currentUser = undefined;
			this.authProvider = undefined;
			this.activeServerId = undefined;

			// Try to switch to another logged-in server
			const loggedInServers = this.getLoggedInServers().filter((id) => id !== serverId);
			if (loggedInServers.length > 0) {
				this.setActiveServer(loggedInServers[0]);
			}
		}

		this.multiServerAuthManager.removeServer(serverId);
		this.notifySubscribers();
	}

	/**
	 * Update server configuration
	 */
	updateServer(server: RelayOnPremServer): void {
		if (!this.multiServerAuthManager) {
			return;
		}
		this.multiServerAuthManager.updateServer(server);
		this.notifySubscribers();
	}

	/**
	 * Logout from all servers
	 */
	async logoutFromAllServers(): Promise<void> {
		if (!this.multiServerAuthManager) {
			return;
		}

		this.log("Logging out from all servers");
		await this.multiServerAuthManager.logoutAll();
		this.currentUser = undefined;
		this.notifySubscribers();
	}

	shutdown() {
		this.currentUser = undefined;
		this.settingsOpener = null as unknown as () => Promise<void>;
		this.multiServerAuthManager = undefined;
		super.destroy();
	}
}
