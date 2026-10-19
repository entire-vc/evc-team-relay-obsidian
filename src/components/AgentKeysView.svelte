<script lang="ts">
	import { copyToClipboard } from "../utils/clipboard";
	import { onMount, onDestroy } from "svelte";
	import { Notice } from "obsidian";
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import type { AgentKey, RelayOnPremShare } from "../RelayOnPremShareClient";
	import { uiText } from "../wording/uiText";

	export let live: TeamRelayPlugin;
	export let server: RelayOnPremServer;
	export let initialShare: ShareWithServer | null = null;

	// Data
	let shares: RelayOnPremShare[] = [];
	let keysByShare: Record<string, AgentKey[]> = {};
	let loadingShares = true;

	// Create modal state
	let showCreateModal = false;
	let newKeyLabel = "";
	let newKeyShareId = "";
	let newKeyExpiryChoice = "never";
	let creating = false;
	let createError: string | null = null;
	let createNeeds401Reauth = false;

	// Reveal modal state
	let revealedKey: { key: string; label: string | null; shareId: string; shareName: string; expiresAt: string | null } | null = null;
	let revealCopied = false;
	let revealCloseWarning = false;

	// Revoke confirm state
	let revokeTarget: { key: AgentKey; shareId: string } | null = null;

	// Visibility change handler ref
	let visibilityHandler: () => void;

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	function timeAgo(dateStr: string): string {
		const now = Date.now();
		const then = new Date(dateStr).getTime();
		if (isNaN(then)) return dateStr;
		const diffMs = now - then;
		const diffSec = Math.floor(diffMs / 1000);
		const diffMin = Math.floor(diffSec / 60);
		const diffHour = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHour / 24);
		const diffMonth = Math.floor(diffDay / 30);
		if (diffSec < 60) return uiText("agentKeys.justNow");
		if (diffMin < 60) return uiText("agentKeys.minutesAgo", { count: diffMin });
		if (diffHour < 24) return uiText(diffHour === 1 ? "agentKeys.hourAgo" : "agentKeys.hoursAgo", { count: diffHour });
		if (diffDay < 30) return uiText(diffDay === 1 ? "agentKeys.dayAgo" : "agentKeys.daysAgo", { count: diffDay });
		return uiText(diffMonth === 1 ? "agentKeys.monthAgo" : "agentKeys.monthsAgo", { count: diffMonth });
	}

	function expiryChoiceToIso(choice: string): string | undefined {
		if (choice === "never") return undefined;
		const now = new Date();
		if (choice === "30d") now.setDate(now.getDate() + 30);
		else if (choice === "90d") now.setDate(now.getDate() + 90);
		else if (choice === "1y") now.setFullYear(now.getFullYear() + 1);
		else return undefined;
		return now.toISOString();
	}

	function downloadKey(key: string, label: string | null, expiresAt: string | null): void {
		const displayLabel = label || "(unnamed)";
		const content = [
			`Agent Key: ${displayLabel}`,
			`Key: ${key}`,
			expiresAt ? `Expires: ${expiresAt}` : "Expires: Never",
			`Downloaded: ${new Date().toISOString()}`,
		].join("\n");
		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = activeDocument.createElement("a");
		a.href = url;
		a.download = `agent-key-${displayLabel.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.txt`;
		activeDocument.body.appendChild(a);
		a.click();
		activeDocument.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// -------------------------------------------------------------------------
	// Data loading
	// -------------------------------------------------------------------------

	async function loadSharesAndKeys() {
		loadingShares = true;
		try {
			// Get all shares for this server
			let allShares: RelayOnPremShare[] = [];
			const client =
				live.shareClientManager?.getClient?.(server.id) ??
				live.shareClient ?? null;
			if (client) {
				allShares = await client.listShares();
			}

			// Get current user to filter to owned shares
			const multiServerAuth = live.authSession.getMultiServerAuthManager?.();
			const currentUser = multiServerAuth
				? multiServerAuth.getUserForServer?.(server.id)
				: live.authSession.getAuthProvider?.()?.getCurrentUser?.();

			const ownedShares = currentUser
				? allShares.filter((s) => s.owner_user_id === currentUser.id)
				: allShares;

			shares = ownedShares;

			// Load keys per share in parallel
			const newKeysByShare: Record<string, AgentKey[]> = {};
			await Promise.all(
				ownedShares.map(async (share) => {
					try {
						let keys: AgentKey[] = [];
						if (live.shareClientManager) {
							keys = await live.shareClientManager.listAgentKeys(server.id, share.id);
						} else if (live.shareClient) {
							keys = await live.shareClient.listAgentKeys(share.id);
						}
						newKeysByShare[share.id] = keys;
					} catch {
						newKeysByShare[share.id] = [];
					}
				}),
			);

			keysByShare = newKeysByShare;
		} finally {
			loadingShares = false;
		}
	}

	// -------------------------------------------------------------------------
	// Create modal
	// -------------------------------------------------------------------------

	function openCreateModal(preselectedShareId?: string) {
		newKeyLabel = "";
		newKeyShareId = preselectedShareId ?? initialShare?.id ?? shares[0]?.id ?? "";
		newKeyExpiryChoice = "never";
		createError = null;
		createNeeds401Reauth = false;
		showCreateModal = true;
	}

	async function createKey() {
		if (!newKeyLabel.trim()) return;
		creating = true;
		createError = null;
		createNeeds401Reauth = false;
		try {
			const expiresAt = expiryChoiceToIso(newKeyExpiryChoice);
			const request = {
				label: newKeyLabel.trim(),
				...(expiresAt ? { expires_at: expiresAt } : {}),
			};
			let response;
			if (live.shareClientManager) {
				response = await live.shareClientManager.createAgentKey(server.id, newKeyShareId, request);
			} else if (live.shareClient) {
				response = await live.shareClient.createAgentKey(newKeyShareId, request);
			}
			if (response) {
				const shareName = shares.find((s) => s.id === newKeyShareId)?.path ?? newKeyShareId;
				revealedKey = {
					key: response.key,
					label: response.label,
					shareId: newKeyShareId,
					shareName,
					expiresAt: response.expires_at ?? null,
				};
				revealCopied = false;
				revealCloseWarning = false;
				showCreateModal = false;
				await loadSharesAndKeys();
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
				createNeeds401Reauth = true;
				createError = uiText("agentKeys.sessionExpiredError");
			} else {
				createError = uiText("agentKeys.createError", { error: msg });
			}
		} finally {
			creating = false;
		}
	}

	// -------------------------------------------------------------------------
	// Revoke
	// -------------------------------------------------------------------------

	async function confirmRevoke() {
		if (!revokeTarget) return;
		const { key, shareId } = revokeTarget;

		// Optimistic removal
		const prev = [...(keysByShare[shareId] ?? [])];
		keysByShare = { ...keysByShare, [shareId]: prev.filter((k) => k.id !== key.id) };

		revokeTarget = null;

		try {
			if (live.shareClientManager) {
				await live.shareClientManager.revokeAgentKey(server.id, shareId, key.id);
			} else if (live.shareClient) {
				await live.shareClient.revokeAgentKey(shareId, key.id);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("404")) {
				new Notice(uiText("agentKeys.shareRemovedNotice"));
			} else {
				// Restore key on failure
				keysByShare = { ...keysByShare, [shareId]: prev };
				new Notice(uiText("agentKeys.revokeError", { error: msg }));
			}
		}
	}

	// -------------------------------------------------------------------------
	// Reveal modal handlers
	// -------------------------------------------------------------------------

	function handleRevealClose() {
		if (!revealCloseWarning) {
			revealCloseWarning = true;
			return;
		}
		revealedKey = null;
		revealCloseWarning = false;
	}

	function dismissRevealedKey() {
		revealedKey = null;
		revealCloseWarning = false;
	}

	function copyRevealedKey() {
		if (!revealedKey) return;
		copyToClipboard(revealedKey.key).then(() => {
			revealCopied = true;
			window.setTimeout(() => { revealCopied = false; }, 2000);
		}).catch(() => {
			new Notice(uiText("agentKeys.copyError"));
		});
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	onMount(async () => {
		await loadSharesAndKeys();
		visibilityHandler = () => {
			if (!activeDocument.hidden) loadSharesAndKeys();
		};
		activeDocument.addEventListener("visibilitychange", visibilityHandler);
	});

	onDestroy(() => {
		if (visibilityHandler) {
			activeDocument.removeEventListener("visibilitychange", visibilityHandler);
		}
	});
</script>

<!-- Main view -->
<div class="ak-view">
	<div class="ak-header-row">
		<h3 class="ak-title">{uiText("shell.breadcrumb.agentKeys")}</h3>
		<button class="evc-small-btn mod-cta" on:click={() => openCreateModal()}>{uiText("agentKeys.createAgentKeyButton")}</button>
	</div>

	{#if loadingShares}
		<div class="ak-state-msg">{uiText("agentKeys.loading")}</div>
	{:else if shares.length === 0}
		<div class="ak-state-msg ak-empty">
			{uiText("agentKeys.noShares")}
		</div>
	{:else}
		{#each shares as share (share.id)}
			<div class="ak-share-group">
				<div class="ak-share-header">
					<span class="ak-share-path">{share.path}</span>
					<button class="evc-small-btn" on:click={() => openCreateModal(share.id)}>{uiText("agentKeys.createKeyButton")}</button>
				</div>
				{#if (keysByShare[share.id] ?? []).length === 0}
					<div class="ak-no-keys">{uiText("agentKeys.noKeys")}</div>
				{:else}
					<table class="ak-table">
						<thead>
							<tr>
								<th>{uiText("agentKeys.label")}</th>
								<th>{uiText("agentKeys.created")}</th>
								<th>{uiText("agentKeys.expires")}</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each (keysByShare[share.id] ?? []) as key (key.id)}
								<tr>
									<td class="ak-label">{key.label || uiText("agentKeys.unnamed")}</td>
									<td title={key.created_at}>{timeAgo(key.created_at)}</td>
									<td>{key.expires_at ? new Date(key.expires_at).toLocaleDateString() : uiText("agentKeys.never")}</td>
									<td>
										<button
											class="evc-small-btn evc-btn-danger"
											on:click={() => { revokeTarget = { key, shareId: share.id }; }}
										>
											{uiText("agentKeys.revokeButton")}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<!-- Create modal -->
{#if showCreateModal}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">{uiText("agentKeys.createTitle")}</span>
				<button class="ak-close-btn" on:click={() => { showCreateModal = false; }}>✕</button>
			</div>

			<div class="ak-modal-body">
				<div class="ak-field">
					<label for="ak-label-input">{uiText("agentKeys.label")}</label>
					<input
						id="ak-label-input"
						type="text"
						placeholder={uiText("agentKeys.labelPlaceholder")}
						bind:value={newKeyLabel}
						required
						disabled={creating}
						on:keydown={(e) => { if (e.key === "Enter" && newKeyLabel.trim()) createKey(); }}
					/>
				</div>

				{#if initialShare}
					<div class="ak-field">
						<label>{uiText("agentKeys.share")}</label>
						<span class="ak-static-share">{initialShare.path}</span>
					</div>
				{:else}
					<div class="ak-field">
						<label for="ak-share-select">{uiText("agentKeys.share")}</label>
						<select id="ak-share-select" bind:value={newKeyShareId} disabled={creating}>
							{#each shares as s (s.id)}
								<option value={s.id}>{s.path}</option>
							{/each}
						</select>
					</div>
				{/if}

				<div class="ak-field">
					<label for="ak-expiry-select">{uiText("agentKeys.expiry")}</label>
					<select id="ak-expiry-select" bind:value={newKeyExpiryChoice} disabled={creating}>
						<option value="never">{uiText("agentKeys.never")}</option>
						<option value="30d">{uiText("agentKeys.thirtyDays")}</option>
						<option value="90d">{uiText("agentKeys.ninetyDays")}</option>
						<option value="1y">{uiText("agentKeys.oneYear")}</option>
					</select>
				</div>

				{#if createError}
					<div class="ak-error-banner">
						{createError}
						{#if createNeeds401Reauth}
							<button class="evc-small-btn ak-reauth-btn" on:click={async () => {
								try {
									await live.authSession.reAuthForSensitiveAction(server.id);
									createError = null;
									createNeeds401Reauth = false;
								} catch (e) {
									new Notice(uiText("agentKeys.reauthError", { error: e instanceof Error ? e.message : uiText("agentKeys.genericError") }));
								}
							}}>{uiText("agentKeys.reauthButton")}</button>
						{/if}
					</div>
				{/if}
			</div>

			<div class="ak-modal-footer">
				<button class="evc-small-btn" on:click={() => { showCreateModal = false; }} disabled={creating}>{uiText("shared.cancelButton")}</button>
				<button
					class="evc-small-btn mod-cta"
					on:click={createKey}
					disabled={creating || !newKeyLabel.trim()}
				>
					{creating ? uiText("shared.creatingEllipsis") : uiText("agentKeys.createSubmitButton")}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Reveal modal -->
{#if revealedKey}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">{uiText("agentKeys.createdTitle", { label: revealedKey.label || uiText("agentKeys.unnamed") })}</span>
				<button class="ak-close-btn" on:click={handleRevealClose} title={uiText("agentKeys.close")}>✕</button>
			</div>

			{#if revealCloseWarning}
				<div class="ak-warn-banner">{uiText("agentKeys.notCopiedWarning")}</div>
			{/if}

			<div class="ak-modal-body">
				<p class="ak-reveal-warning">{uiText("agentKeys.saveKeyPrefix")}<strong>{uiText("agentKeys.saveKeyEmphasis")}</strong>{uiText("agentKeys.saveKeySuffix")}</p>

				<code class="ak-key-block">{revealedKey.key}</code>

				<div class="ak-reveal-actions">
					<button class="evc-small-btn" on:click={copyRevealedKey}>
						{revealCopied ? uiText("agentKeys.copied") : uiText("agentKeys.copyButton")}
					</button>
					<button class="evc-small-btn" on:click={() => revealedKey && downloadKey(revealedKey.key, revealedKey.label, revealedKey.expiresAt)}>
						{uiText("agentKeys.downloadButton")}
					</button>
				</div>

				<div class="ak-reveal-meta">
					<span>{uiText("agentKeys.shareMeta", { share: revealedKey.shareName })}</span>
					{#if revealedKey.expiresAt}
						<span>{uiText("agentKeys.expiresMeta", { date: new Date(revealedKey.expiresAt).toLocaleString() })}</span>
					{:else}
						<span>{uiText("agentKeys.expiresMeta", { date: uiText("agentKeys.never") })}</span>
					{/if}
				</div>
			</div>

			<div class="ak-modal-footer">
				<button class="evc-small-btn mod-cta" on:click={dismissRevealedKey}>
					{uiText("agentKeys.copiedCloseButton")}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Revoke confirm modal -->
{#if revokeTarget}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">{uiText("agentKeys.revokeTitle")}</span>
			</div>
			<div class="ak-modal-body">
				<p>{uiText("agentKeys.revokePrefix")}<strong>{revokeTarget.key.label || uiText("agentKeys.unnamed")}</strong>{uiText("agentKeys.revokeSuffix")}</p>
			</div>
			<div class="ak-modal-footer">
				<button class="evc-small-btn" on:click={() => { revokeTarget = null; }}>{uiText("shared.cancelButton")}</button>
				<button class="evc-small-btn evc-btn-danger" on:click={confirmRevoke}>{uiText("agentKeys.revokeSubmitButton")}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Main view */
	.ak-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ak-header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-title {
		margin: 0;
		font-size: 1.1em;
		font-weight: 600;
	}

	.ak-state-msg {
		color: var(--text-muted);
		font-size: 0.9em;
		padding: 12px 0;
	}

	.ak-empty {
		font-style: italic;
	}

	/* Share groups */
	.ak-share-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.ak-share-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-share-path {
		font-weight: 600;
		font-size: 0.95em;
		word-break: break-all;
	}

	.ak-no-keys {
		color: var(--text-muted);
		font-size: 0.85em;
	}

	/* Keys table */
	.ak-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85em;
	}

	.ak-table th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 500;
		padding: 4px 6px 4px 0;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ak-table td {
		padding: 6px 6px 6px 0;
		vertical-align: middle;
	}

	.ak-label {
		font-weight: 500;
	}

	/* Overlay + modal */
	.ak-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ak-modal {
		background: var(--background-primary);
		border-radius: 8px;
		padding: 20px;
		max-width: 440px;
		width: 90%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ak-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-modal-title {
		font-weight: 600;
		font-size: 1em;
	}

	.ak-close-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 6px;
		color: var(--text-muted);
		font-size: 1em;
		line-height: 1;
		box-shadow: none;
	}

	.ak-close-btn:hover {
		color: var(--text-normal);
	}

	.ak-modal-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ak-modal-footer {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	/* Form fields */
	.ak-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ak-field label {
		font-size: 0.85em;
		color: var(--text-muted);
		font-weight: 500;
	}

	.ak-field input,
	.ak-field select {
		width: 100%;
	}

	.ak-static-share {
		font-size: 0.9em;
		color: var(--text-normal);
		padding: 4px 0;
	}

	/* Error / warning banners */
	.ak-error-banner {
		padding: 10px 12px;
		background: rgba(var(--color-red-rgb, 220, 50, 50), 0.1);
		border: 1px solid rgba(var(--color-red-rgb, 220, 50, 50), 0.3);
		border-radius: 4px;
		font-size: 0.85em;
		color: var(--color-red, #dc3232);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ak-reauth-btn {
		align-self: flex-start;
	}

	.ak-warn-banner {
		padding: 8px 12px;
		background: rgba(180, 120, 0, 0.1);
		border: 1px solid rgba(180, 120, 0, 0.3);
		border-radius: 4px;
		font-size: 0.85em;
		color: var(--text-warning, #b08800);
	}

	/* Reveal modal */
	.ak-reveal-warning {
		margin: 0;
		font-size: 0.9em;
	}

	.ak-key-block {
		display: block;
		padding: 10px 12px;
		background: var(--background-secondary);
		border-radius: 4px;
		font-family: monospace;
		font-size: 0.85em;
		word-break: break-all;
		user-select: all;
	}

	.ak-reveal-actions {
		display: flex;
		gap: 8px;
	}

	.ak-reveal-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8em;
		color: var(--text-muted);
	}

	/* Shared button styles */
	.evc-small-btn {
		font-size: 0.85em;
		padding: 4px 10px;
		cursor: pointer;
	}

	.evc-btn-danger {
		color: var(--color-red, var(--text-error));
		border-color: var(--color-red, var(--text-error));
	}

	.evc-btn-danger:hover {
		background: var(--color-red, var(--text-error));
		color: var(--text-on-accent, white);
	}
</style>
