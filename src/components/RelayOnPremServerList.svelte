<script lang="ts">
	import { Notice, Platform } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import {
		EVC_SERVER_ID,
		isWellKnownServer,
		generateServerId,
		validateServerConfig,
		findDuplicateServer,
		isServerVersionSupported,
		serverCompatMessage,
		crossServerAccountNote,
	} from "../RelayOnPremConfig";
	import { RelayOnPremLoginModal } from "../ui/RelayOnPremLoginModal";
	import { OAuthCancelledError } from "../auth/OAuthCancelledError";
	import { InFlightGuard } from "../inFlightGuard";
	import { platformFetch } from "../platformFetch";
	import { confirmDialog } from "../ui/dialogs";
	import evcLogo from "../assets/evc-logo.png";
	import { uiText } from "../wording/uiText";

	export let live: TeamRelayPlugin;

	const dispatch = createEventDispatcher<{
		serversChanged: void;
		openShares: { server: RelayOnPremServer };
		openBilling: { server: RelayOnPremServer };
		openAgentKeys: { server: RelayOnPremServer };
	}>();

	const relayOnPremSettings = live.relayOnPremSettings;

	// Subscribe to settings
	let settings = $relayOnPremSettings;
	$: settings = $relayOnPremSettings;
	$: servers = settings.servers || [];
	$: defaultServerId = settings.defaultServerId;

	// Editing state
	let editingServer: RelayOnPremServer | null = null;
	let isAddingServer = false;

	// New server form
	let newServerName = "";
	let newControlPlaneUrl = "";
	let newRelayServerUrl = "";
	let formError = "";

	// Testing state
	let testingServerId: string | null = null;

	// Browser (OAuth) sign-in in progress, per server. While an entry exists the card shows a
	// persistent status row with Cancel / "Sign in with password" instead of relying on a
	// short-lived toast (the wait can last up to 5 minutes).
	let oauthWaiting: Record<string, { controller: AbortController; toPassword: boolean } | undefined> = {};

	function endOAuthWait(serverId: string) {
		const { [serverId]: _done, ...rest } = oauthWaiting;
		oauthWaiting = rest;
	}

	function cancelOAuth(serverId: string) {
		oauthWaiting[serverId]?.controller.abort();
	}

	function usePasswordInstead(serverId: string) {
		const entry = oauthWaiting[serverId];
		if (!entry) return;
		entry.toPassword = true;
		entry.controller.abort();
	}

	// Track which servers support billing (enterprise + billing_enabled)
	let serverBillingSupport: Record<string, boolean> = {};

	// Per-server branding logo: the server's own logo_url, and whether it failed to load
	// (a server with no branding, or an unreachable image, falls back to evcLogo below).
	let serverLogoUrl: Record<string, string | undefined> = {};
	let serverLogoFailed: Record<string, boolean> = {};

	function handleServerLogoError(serverId: string) {
		serverLogoFailed[serverId] = true;
		serverLogoFailed = serverLogoFailed; // trigger reactivity
	}

	// Refresh key to force auth status recalculation
	let authRefreshKey = 0;

	function getAuthStatus(serverId: string, _refreshKey: number): { isLoggedIn: boolean; email?: string } {
		const lm = live.authSession;
		if (!lm || typeof lm.isLoggedInToServer !== "function") {
			return { isLoggedIn: false };
		}
		const isLoggedIn = lm.isLoggedInToServer(serverId);
		const msam = lm.getMultiServerAuthManager?.();
		const user = msam?.getUserForServer?.(serverId);
		return { isLoggedIn, email: user?.email };
	}

	function refreshAuthStatus() {
		authRefreshKey = authRefreshKey + 1;
		dispatch("serversChanged");
	}

	// Check billing support for all servers on load
	async function checkBillingSupport() {
		for (const s of servers) {
			if (serverBillingSupport[s.id] !== undefined) continue;
			const info = await fetchServerInfo(s.controlPlaneUrl);
			if (info) {
				serverBillingSupport[s.id] = info.edition === "enterprise" && info.features?.billing_enabled === true;
				serverBillingSupport = serverBillingSupport; // trigger reactivity
				serverLogoUrl[s.id] = info.branding?.logo_url;
				serverLogoUrl = serverLogoUrl; // trigger reactivity
			}
		}
	}

	// Run on component init
	import { onMount } from "svelte";
	onMount(() => { checkBillingSupport(); });

	function startAddServer() {
		isAddingServer = true;
		editingServer = null;
		newServerName = "";
		newControlPlaneUrl = "";
		newRelayServerUrl = "";
		formError = "";
	}

	function startEditServer(server: RelayOnPremServer) {
		editingServer = { ...server };
		isAddingServer = false;
		newServerName = server.name;
		newControlPlaneUrl = server.controlPlaneUrl;
		newRelayServerUrl = server.relayServerUrl || "";
		formError = "";
	}

	function cancelEdit() {
		isAddingServer = false;
		editingServer = null;
		formError = "";
	}

	interface ServerFeatures {
		multi_user: boolean;
		share_members: boolean;
		audit_logging: boolean;
		admin_ui: boolean;
		oauth_enabled?: boolean;
		oauth_provider?: string | null;
		billing_enabled?: boolean;
	}

	interface ServerBranding {
		name?: string;
		logo_url?: string;
		favicon_url?: string;
	}

	interface ServerInfo {
		id: string;
		name: string;
		version: string;
		relay_url: string;
		edition?: string;
		features: ServerFeatures;
		branding?: ServerBranding;
	}

	async function fetchServerInfo(url: string): Promise<ServerInfo | null> {
		try {
			console.log("[RelayOnPrem] Fetching server info from:", `${url}/v1/server/info`);
			const response = await platformFetch(`${url}/v1/server/info`, { method: "GET" });
			console.log("[RelayOnPrem] Server info response status:", response.status);
			if (response.ok) {
				const data = await response.json();
				console.log("[RelayOnPrem] Server info data:", data);
				return data;
			} else {
				console.warn("[RelayOnPrem] Server info failed with status:", response.status);
			}
		} catch (error: unknown) {
			// Server info endpoint might not exist on older servers
			console.error("[RelayOnPrem] Server info fetch error:", error);
		}
		return null;
	}

	async function testConnection(url: string, serverId?: string, showNotice = true) {
		if (serverId) {
			testingServerId = serverId;
		}
		try {
			const response = await platformFetch(`${url}/v1/health`, { method: "GET" });
			if (response.ok) {
				if (showNotice) new Notice(uiText("serverList.connectionSuccessNotice"));
				return true;
			} else {
				if (showNotice) new Notice(uiText("serverList.cannotConnectError"));
				return false;
			}
		} catch {
			if (showNotice) new Notice(uiText("serverList.cannotConnectError"));
			return false;
		} finally {
			testingServerId = null;
		}
	}

	async function saveServer() {
		formError = "";

		// Validate inputs
		if (!newControlPlaneUrl.trim()) {
			formError = uiText("serverList.controlPlaneUrlRequiredError");
			return;
		}

		// The form owns validation feedback; connection-test notices are for
		// the standalone Test button, not a second message during saving.
		const connectionOk = await testConnection(newControlPlaneUrl.trim(), undefined, false);
		if (!connectionOk) {
			formError = uiText("serverList.cannotConnectError");
			return;
		}

		// Try to fetch server info for auto-configuration
		const serverInfo = await fetchServerInfo(newControlPlaneUrl.trim());

		// reject a server below this plugin's compatibility floor here,
		// at connect time — otherwise it saves fine and only fails later with
		// confusing unversioned 404s on whichever endpoint the server predates.
		// Only block on a CONCRETE version we know is too old — fetchServerInfo()
		// returns null both for "server predates this endpoint" and for a plain
		// network hiccup (it already succeeded a /health check moments ago via
		// testConnection above), and conflating those would false-block saving
		// an already-compatible server on a transient blip. A server that
		// genuinely never returns a version is a rarer, softer case than the
		// audit's actual finding (version fetched but not checked) — not
		// hard-blocked here, same as before this fix.
		if (serverInfo?.version && !isServerVersionSupported(serverInfo.version)) {
			formError = serverCompatMessage(serverInfo.version);
			return;
		}

		// Use server info or fallback to user input
		const serverName = newServerName.trim() || serverInfo?.name || new URL(newControlPlaneUrl).hostname;
		const relayUrl = newRelayServerUrl.trim() || serverInfo?.relay_url || undefined;

		// Generate or use existing ID (prefer server's own ID if available)
		const serverId = editingServer?.id || serverInfo?.id || generateServerId(newControlPlaneUrl);

		// Reject adding a server that duplicates an existing one (same id or
		// same URL under a different id) — editing an existing entry is exempt,
		// it's expected to keep its own id.
		if (!editingServer) {
			const duplicate = findDuplicateServer(servers, serverId, newControlPlaneUrl);
			if (duplicate) {
				formError = uiText("serverList.duplicateUrlError", { name: duplicate.name });
				return;
			}
		}

		const serverConfig: RelayOnPremServer = {
			id: serverId,
			name: serverName,
			controlPlaneUrl: newControlPlaneUrl.trim(),
			relayServerUrl: relayUrl,
			isValidated: true,
			lastValidated: Date.now(),
			lastUserEmail: editingServer?.lastUserEmail,
		};

		// Validate server config
		const validation = validateServerConfig(serverConfig);
		if (!validation.valid) {
			formError = validation.errors.join(", ");
			return;
		}

		// Update settings
		await relayOnPremSettings.mutateValue((current) => {
			const newServers = [...(current.servers || [])];

			if (editingServer) {
				// Update existing
				const index = newServers.findIndex((s) => s.id === editingServer!.id);
				if (index >= 0) {
					newServers[index] = serverConfig;
				}
			} else {
				// Add new
				newServers.push(serverConfig);
			}

			// If this is the first server, make it default
			const newDefaultServerId =
				current.defaultServerId || (newServers.length === 1 ? serverConfig.id : current.defaultServerId);

			return {
				...current,
				servers: newServers,
				defaultServerId: newDefaultServerId,
			};
		});

		// Update AuthSession
		if (editingServer) {
			live.authSession.updateServer(serverConfig);
		} else {
			live.authSession.addServer(serverConfig);
		}

		cancelEdit();
		dispatch("serversChanged");
		new Notice(editingServer ? uiText("serverList.serverUpdatedNotice") : uiText("serverList.serverAddedNotice"));
	}

	async function removeServer(serverId: string) {
		const server = servers.find((s) => s.id === serverId);
		if (!server) return;

		// Confirm removal
		if (!(await confirmDialog(live.app, uiText("serverList.removeConfirmMessage", { name: server.name })))) {
			return;
		}

		// Remove from settings
		await relayOnPremSettings.mutateValue((current) => {
			const newServers = current.servers.filter((s) => s.id !== serverId);
			const newDefaultServerId =
				current.defaultServerId === serverId
					? newServers.length > 0
						? newServers[0].id
						: undefined
					: current.defaultServerId;

			return {
				...current,
				servers: newServers,
				defaultServerId: newDefaultServerId,
			};
		});

		// Remove from AuthSession
		live.authSession.removeServer(serverId);

		dispatch("serversChanged");
		new Notice(uiText("serverList.serverRemovedNotice", { name: server.name }));
	}

	// Taken synchronously on the first click: `oauthWaiting` is only set after the
	// server-info fetch below, so on its own it lets a fast double click start two
	// browser sign-ins, one of which can no longer be cancelled.
	const loginInFlight = new InFlightGuard<string>();

	async function loginToServer(server: RelayOnPremServer) {
		await loginInFlight.run(server.id, () => startLogin(server));
	}

	async function startLogin(server: RelayOnPremServer) {
		// A browser sign-in is already being waited for on this card.
		if (oauthWaiting[server.id]) return;

		// First, fetch server info to check if OAuth is enabled
		const serverInfo = await fetchServerInfo(server.controlPlaneUrl);
		console.log("[RelayOnPrem] Server info:", serverInfo);

		// Track billing support for this server
		if (serverInfo) {
			serverBillingSupport[server.id] = serverInfo.edition === "enterprise" && serverInfo.features?.billing_enabled === true;
		}

		// If OAuth is enabled, try OAuth-first flow. OAuthCallbackServer
		// needs the Electron desktop app (Node's http module) — on mobile this
		// attempt is doomed before it starts, and would flash a technical
		// "OAuth failed: ... only supported on the desktop app" Notice before
		// falling back. Skip straight to the password modal instead, which
		// already explains SSO isn't available on mobile.
		if (
			Platform.isDesktopApp &&
			serverInfo?.features?.oauth_enabled &&
			serverInfo.features.oauth_provider
		) {
			console.log("[RelayOnPrem] OAuth enabled, provider:", serverInfo.features.oauth_provider);

			const authProvider = live.authSession.getAuthProviderForServer(server.id);
			console.log("[RelayOnPrem] Auth provider for server:", server.id, "exists:", !!authProvider);

			if (authProvider) {
				const wait = { controller: new AbortController(), toPassword: false };
				oauthWaiting = { ...oauthWaiting, [server.id]: wait };
				try {
					new Notice(uiText("serverList.oauthStartingNotice", { provider: serverInfo.features.oauth_provider }));
					// Route through AuthSession (not the authProvider directly) so
					// this.user gets set and notifySubscribers() fires — see // — otherwise main.ts's post-login hook never runs and
					// shares/live-sync don't start until the plugin is reloaded.
					await live.authSession.loginWithOAuth2(
						serverInfo.features.oauth_provider,
						server.id,
						wait.controller.signal,
					);
					new Notice(uiText("serverList.loggedInNotice", { name: server.name }));
					refreshAuthStatus();
					return;
				} catch (error: unknown) {
					// A cancel that lands while the authorize URL is still being fetched can surface
					// as a plain fetch error; the user's intent (abort) still wins.
					if (error instanceof OAuthCancelledError || wait.controller.signal.aborted) {
						// The user chose to stop waiting: either drop the attempt quietly, or
						// go straight to the password form ("Sign in with password").
						if (!wait.toPassword) {
							new Notice(uiText("serverList.oauthCancelledNotice"));
							return;
						}
					} else {
						// OAuth failed, fall back to password login
						console.error("[RelayOnPrem] OAuth login failed:", error);
						new Notice(
							uiText("serverList.oauthFailedNotice", {
								error: error instanceof Error ? error.message : uiText("shared.unknownError"),
							})
						);
					}
				} finally {
					endOAuthWait(server.id);
				}
			} else {
				console.warn("[RelayOnPrem] No auth provider found for server:", server.id);
				new Notice(uiText("serverList.authProviderNotReadyNotice"));
			}
		}

		// Show password login modal (default or fallback)
		const modal = new RelayOnPremLoginModal(
			live.app,
			live.authSession,
			() => {
				new Notice(uiText("serverList.loggedInNotice", { name: server.name }));
				refreshAuthStatus();
			},
			server.id,
			undefined,
			server.name,
			crossServerAccountNote(servers, server.id)
		);
		modal.open();
	}

	async function logoutFromServer(serverId: string) {
		try {
			await live.authSession.logoutFromServer(serverId);
			new Notice(uiText("serverList.loggedOutNotice"));
			refreshAuthStatus();
		} catch (error: unknown) {
			new Notice(
				uiText("serverList.logoutFailedNotice", {
					error: error instanceof Error ? error.message : uiText("shared.unknownError"),
				})
			);
		}
	}

	function openSharesForServer(server: RelayOnPremServer) {
		dispatch('openShares', { server });
	}

	async function toggleDefaultServer(serverId: string, isCurrentlyDefault: boolean) {
		if (isCurrentlyDefault) {
			// Unset default
			await relayOnPremSettings.mutateValue((current) => ({
				...current,
				defaultServerId: undefined,
			}));
			new Notice(uiText("serverList.defaultClearedNotice"));
		} else {
			// Set as default
			await relayOnPremSettings.mutateValue((current) => ({
				...current,
				defaultServerId: serverId,
			}));
			new Notice(uiText("serverList.defaultSetNotice"));
		}
		dispatch("serversChanged");
	}
</script>

<div class="relay-server-list">
	{#if servers.length === 0 && !isAddingServer}
		<div class="relay-server-empty">
			<p>{uiText("serverList.emptyNotice")}</p>
		</div>
	{/if}

	{#each servers as server (server.id)}
		{@const authStatus = getAuthStatus(server.id, authRefreshKey)}
		<div class="relay-server-item" class:is-default={server.id === defaultServerId}>
			<img
				src={serverLogoUrl[server.id] && !serverLogoFailed[server.id] ? serverLogoUrl[server.id] : evcLogo}
				alt=""
				class="relay-server-logo"
				on:error={() => handleServerLogoError(server.id)}
			/>
			<div class="relay-server-info">
				<div class="relay-server-name">
					<span class="relay-status-dot" class:is-connected={authStatus.isLoggedIn}></span>
					{server.name}
					{#if server.id === defaultServerId}
						<span class="relay-server-badge default">{uiText("serverList.defaultBadge")}</span>
					{/if}
				</div>
				<div class="relay-server-url">{server.controlPlaneUrl}</div>
				{#if authStatus.isLoggedIn && authStatus.email}
					<div class="relay-server-user">{uiText("serverList.loggedInAs", { email: authStatus.email })}</div>
				{/if}
				{#if oauthWaiting[server.id]}
					<div class="relay-server-oauth-wait" role="status">
						<span>{uiText("serverList.oauthWaitingStatus")}</span>
						<span class="relay-server-oauth-wait-actions">
							<button class="relay-server-btn" on:click={() => cancelOAuth(server.id)}>
								{uiText("serverList.oauthCancelButton")}
							</button>
							<button class="relay-server-btn" on:click={() => usePasswordInstead(server.id)}>
								{uiText("serverList.oauthUsePasswordButton")}
							</button>
						</span>
					</div>
				{/if}
			</div>
			<div class="relay-server-actions">
				{#if authStatus.isLoggedIn}
					<button class="relay-server-btn" on:click={() => logoutFromServer(server.id)}>
						{uiText("serverList.logoutButton")}
					</button>
				{:else}
					<button
						class="relay-server-btn mod-cta"
						on:click={() => loginToServer(server)}
						disabled={!!oauthWaiting[server.id]}
					>
						{uiText("connect.login.loginButton")}
					</button>
				{/if}
				<button
					class="relay-server-btn"
					on:click={() => testConnection(server.controlPlaneUrl, server.id)}
					disabled={testingServerId === server.id}
				>
					{testingServerId === server.id ? "..." : uiText("serverList.testButton")}
				</button>
				<button
					class="relay-server-btn"
					on:click={() => openSharesForServer(server)}
					disabled={!authStatus.isLoggedIn}
					title={authStatus.isLoggedIn ? undefined : uiText("serverList.loginRequiredHint")}
				>
					{uiText("serverList.sharesButton")}
				</button>
				{#if serverBillingSupport[server.id]}
					<button
						class="relay-server-btn"
						on:click={() => dispatch('openBilling', { server })}
						disabled={!authStatus.isLoggedIn}
						title={authStatus.isLoggedIn ? undefined : uiText("serverList.loginRequiredHint")}
					>
						{uiText("shell.breadcrumb.planUsage")}
					</button>
				{/if}
				<button
					class="relay-server-btn"
					on:click={() => dispatch('openAgentKeys', { server })}
					disabled={!authStatus.isLoggedIn}
					title={authStatus.isLoggedIn ? undefined : uiText("serverList.loginRequiredHint")}
				>
					{uiText("shell.breadcrumb.agentKeys")}
				</button>
				<button class="relay-server-btn" on:click={() => startEditServer(server)}>
					{uiText("serverList.editButton")}
				</button>
				{#if !isWellKnownServer(server.id)}
					<button class="relay-server-btn mod-warning" on:click={() => removeServer(server.id)}>
						{uiText("serverList.removeButton")}
					</button>
				{/if}
			</div>
			<div class="relay-server-default">
				<label class="relay-default-checkbox">
					<input
						type="checkbox"
						checked={server.id === defaultServerId}
						on:change={() => toggleDefaultServer(server.id, server.id === defaultServerId)}
					/>
					<span>{uiText("serverList.defaultBadge")}</span>
				</label>
			</div>
		</div>
	{/each}

	{#if isAddingServer || editingServer}
		<div class="relay-server-form">
			<h4>{editingServer ? uiText("serverList.editServerTitle") : uiText("serverList.addServerTitle")}</h4>

			<div class="relay-server-form-field">
				<label for="control-plane-url">{uiText("serverList.controlPlaneUrlLabel")}</label>
				<input
					id="control-plane-url"
					type="text"
					placeholder="https://cp.example.com"
					bind:value={newControlPlaneUrl}
				/>
			</div>

			<div class="relay-server-form-field">
				<label for="server-name">{uiText("serverList.serverNameLabel")}</label>
				<input
					id="server-name"
					type="text"
					placeholder={uiText("serverList.autoDetectPlaceholder")}
					bind:value={newServerName}
				/>
			</div>

			<div class="relay-server-form-field">
				<label for="relay-server-url">{uiText("serverList.relayServerUrlLabel")}</label>
				<input
					id="relay-server-url"
					type="text"
					placeholder={uiText("serverList.autoDetectPlaceholder")}
					bind:value={newRelayServerUrl}
				/>
			</div>

			{#if formError}
				<div class="relay-server-form-error">{formError}</div>
			{/if}

			<div class="relay-server-form-actions">
				<button class="mod-cta" on:click={saveServer}>
					{editingServer ? uiText("serverList.saveChangesButton") : uiText("serverList.addServerTitle")}
				</button>
				<button on:click={cancelEdit}>{uiText("shared.cancelButton")}</button>
			</div>
		</div>
	{:else}
		<button class="relay-server-add-btn" on:click={startAddServer}>
			{uiText("serverList.addServerCta")}
		</button>
	{/if}
</div>

<style>
	.relay-server-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.relay-server-empty {
		padding: 20px;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 6px;
	}

	.relay-server-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 12px;
		padding: 12px;
		background: var(--background-secondary);
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	.relay-server-item.is-default {
		border-color: var(--interactive-accent);
	}

	.relay-server-logo {
		width: 2em;
		height: 2em;
		object-fit: contain;
		border-radius: 4px;
		background: var(--background-primary);
		flex-shrink: 0;
	}

	.relay-server-info {
		/* TR: name/URL column previously used flex:1 + min-width:0 with no
		   floor, so once the actions column below grew to 7 buttons
		   (Logout/Test/Shares/Plan & Usage/Agent Keys/Edit/Remove) it got
		   squeezed toward zero width and wrapped character-by-character
		   (word-break:break-all on the URL made this a single-char-per-line).
		   flex-wrap on the row (above) lets the actions/checkbox drop to their
		   own line instead of stealing the info column's width; the 200px
		   floor here keeps the name/URL readable even when they DO share a
		   line with a couple of buttons. */
		flex: 1 1 200px;
		min-width: 200px;
	}

	.relay-server-name {
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.relay-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}

	.relay-status-dot.is-connected {
		background: var(--color-green, #28a745);
	}

	.relay-server-badge {
		font-size: 0.75em;
		padding: 2px 6px;
		border-radius: 4px;
		font-weight: 500;
	}

	.relay-server-badge.default {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	.relay-server-url {
		font-size: 0.85em;
		color: var(--text-muted);
		word-break: break-all;
		margin-top: 4px;
	}

	.relay-server-user {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.relay-server-oauth-wait {
		margin-top: 6px;
		font-size: 0.85em;
		color: var(--text-muted);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.relay-server-oauth-wait-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.relay-server-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.relay-server-btn {
		padding: 4px 8px;
		font-size: 0.85em;
		cursor: pointer;
	}

	.relay-server-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.relay-server-form {
		padding: 16px;
		background: var(--background-secondary);
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	.relay-server-form h4 {
		margin: 0 0 12px 0;
	}

	.relay-server-form-field {
		margin-bottom: 12px;
	}

	.relay-server-form-field label {
		display: block;
		margin-bottom: 4px;
		font-size: 0.9em;
		color: var(--text-muted);
	}

	.relay-server-form-field input {
		width: 100%;
	}

	.relay-server-form-error {
		color: var(--text-error);
		font-size: 0.9em;
		margin-bottom: 12px;
	}

	.relay-server-form-actions {
		display: flex;
		gap: 8px;
	}

	.relay-server-add-btn {
		padding: 12px;
		background: var(--background-secondary);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-muted);
		transition: all 0.15s ease;
	}

	.relay-server-add-btn:hover {
		background: var(--background-secondary-alt);
		color: var(--text-normal);
	}

	.relay-server-default {
		display: flex;
		align-items: center;
	}

	.relay-default-checkbox {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85em;
		color: var(--text-muted);
		cursor: pointer;
	}

	.relay-default-checkbox input {
		margin: 0;
		cursor: pointer;
	}

	.relay-default-checkbox input:checked + span {
		color: var(--interactive-accent);
		font-weight: 500;
	}
</style>
