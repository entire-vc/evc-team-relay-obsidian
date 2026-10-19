<script lang="ts">
	import type TeamRelayPlugin from "../main";
	import { onMount } from "svelte";
	import type { StorageUsageSummary, ObjectStoreReport } from "../StorageDiagnostics";
	import { surveyLocalDatabases, deleteObjectStore } from "../StorageDiagnostics";
	import ConfigRow from "./ConfigRow.svelte";
	import ConfigSectionHeading from "./ConfigSectionHeading.svelte";

	export let live: TeamRelayPlugin;

	let isLoading = true;
	let progress = 0;
	let stats: StorageUsageSummary | null = null;
	let error: string | null = null;
	let searchAcrossVaults = false;

	function describeError(action: string, e: unknown): string {
		const detail = e instanceof Error ? e.message : String(e);
		return `${action}: ${detail}`;
	}

	// Buckets large stores by relay ("local" for anything without one) and
	// hands back the buckets already ordered for display: the local bucket
	// pinned first, everything else alphabetical.
	function groupAndOrderByRelay(
		largeStores: ObjectStoreReport[],
	): Array<[string, ObjectStoreReport[]]> {
		const byRelay = new Map<string, ObjectStoreReport[]>();
		for (const store of largeStores) {
			const relay = store.relayLabel || "local";
			const bucket = byRelay.get(relay);
			if (bucket) {
				bucket.push(store);
			} else {
				byRelay.set(relay, [store]);
			}
		}
		return [...byRelay.entries()].sort(([a], [b]) => {
			if (a === "local") return -1;
			if (b === "local") return 1;
			return a.localeCompare(b);
		});
	}

	$: relayGroups = stats ? groupAndOrderByRelay(stats.oversizedStores) : [];

	async function analyzeStores() {
		isLoading = true;
		error = null;
		try {
			stats = await surveyLocalDatabases({
				appId: live.instanceAppId,
				filterByAppId: !searchAcrossVaults,
				onProgress: (p) => {
					progress = p;
				},
			});
		} catch (e: unknown) {
			error = describeError("Analysis failed", e);
		} finally {
			isLoading = false;
		}
	}

	function toggleSearchAcrossVaults() {
		searchAcrossVaults = !searchAcrossVaults;
		analyzeStores();
	}

	function handleCheckboxKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggleSearchAcrossVaults();
		}
	}

	async function handleDelete(storeKey: string) {
		try {
			await deleteObjectStore(storeKey);
			if (stats) {
				stats.oversizedStores = stats.oversizedStores.filter(
					(store) => store.storeKey !== storeKey,
				);
			}
		} catch (e: unknown) {
			error = describeError(`Failed to delete ${storeKey}`, e);
		}
	}

	onMount(analyzeStores);
</script>

<div class="modal-title">Team Relay database analysis</div>
<div class="evc-relay-indexeddb-analysis">
	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Search across vaults</div>
			<div class="setting-item-description">
				<div class="mod-warning">
					Warning: This is a dangerous setting. It allows you to delete relay
					databases from other vaults.
				</div>
			</div>
		</div>
		<div class="setting-item-control">
			<div
				role="checkbox"
				aria-checked={searchAcrossVaults}
				tabindex="0"
				on:keydown={handleCheckboxKeydown}
				class="checkbox-container evc-relay-dangerous"
				class:is-enabled={searchAcrossVaults}
				on:click={toggleSearchAcrossVaults}
			>
				<input type="checkbox" tabindex="-1" checked={searchAcrossVaults} />
				<div class="checkbox-toggle" />
			</div>
		</div>
	</div>

	{#if isLoading}
		<div class="evc-relay-loading-container">
			<div class="evc-relay-loading-spinner" />
			<div class="evc-loading-text">Analyzing Databases...</div>
			<div class="evc-relay-progress-bar">
				<div class="evc-relay-progress-fill" style="width: {progress}%" />
			</div>
		</div>
	{:else if error}
		<div class="evc-relay-error-message">
			{error}
		</div>
	{:else if stats}
		<div class="evc-relay-summary-stats">
			<div class="evc-relay-stat-item evc-relay-global-count">
				<div class="evc-relay-stat-label">Global Database Limit</div>
				<div
					class="evc-relay-stat-value"
					class:evc-relay-warning={stats.browserDatabaseCount > 40000}
					class:evc-relay-critical={stats.browserDatabaseCount > 45000}
				>
					{stats.browserDatabaseCount.toLocaleString()} / 50,000
				</div>
				{#if stats.browserDatabaseCount > 45000}
					<div class="evc-relay-warning-text evc-relay-critical">
						Critical: approaching IndexedDB database limit!<br />
						Your browser may start deleting old databases soon.
					</div>
				{:else if stats.browserDatabaseCount > 40000}
					<div class="evc-relay-warning-text">
						Warning: high number of databases.<br />
						Consider cleaning up unused databases.
					</div>
				{/if}
			</div>
			<div class="evc-relay-stat-item">
				<div class="evc-relay-stat-label">Team Relay Databases</div>
				<div class="evc-relay-stat-value">{stats.relayDatabaseCount}</div>
			</div>
			<div class="evc-relay-stat-item">
				<div class="evc-relay-stat-label">Document Updates</div>
				<div class="evc-relay-stat-value">
					{stats.documentUpdateCount.toLocaleString()}
				</div>
			</div>
			<div class="evc-relay-stat-item">
				<div class="evc-relay-stat-label">Total Size</div>
				<div class="evc-relay-stat-value">{stats.totalSizeMegabytes.toFixed(2)} MB</div>
			</div>
		</div>

		{#if stats.oversizedStores.length > 0}
			<ConfigSectionHeading heading="Large Stores (>1MB)" />
			{#each relayGroups as [relay, relayStores]}
				<ConfigSectionHeading
					heading={relay === "local" ? "Tracked Documents" : `Relay: ${relay}`}
				/>
				{#each relayStores as store}
					<ConfigRow
						heading={store.docPath || store.storeKey}
						caption="Size: {store.approxSizeMB}MB, Items: {store.itemCount}"
					>
						<div class="evc-relay-actions">
							<button
								class="mod-warning"
								on:click={() => handleDelete(store.storeKey)}
								title="Delete all data in this store"
							>
								Delete
							</button>
						</div>
					</ConfigRow>
				{/each}
			{/each}
		{/if}
	{/if}
</div>

<style>
	.evc-relay-dangerous:enabled {
		background-color: var(--background-modifier-error);
	}
	.evc-relay-indexeddb-analysis {
		padding: 1rem;
		max-height: 500px;
		overflow-y: auto;
	}

	.evc-relay-loading-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 200px;
		gap: 1rem;
	}

	.evc-relay-loading-spinner {
		border: 4px solid var(--background-modifier-border);
		border-top: 4px solid var(--interactive-accent);
		border-radius: 50%;
		width: 40px;
		height: 40px;
		animation: spin 1s linear infinite;
	}

	.evc-relay-progress-bar {
		width: 80%;
		height: 8px;
		border-radius: 4px;
		background-color: var(--background-secondary);
		overflow: hidden;
		margin: 0 auto;
	}

	.evc-relay-progress-fill {
		height: 100%;
		background-color: var(--color-accent);
		border-radius: 4px;
		transition: width 0.3s ease;
		min-width: 0%;
		max-width: 100%;
	}

	.evc-relay-error-message {
		color: var(--text-error);
		padding: 1rem;
		background-color: var(--mod-error);
		border-radius: 4px;
	}

	.evc-relay-actions {
		display: flex;
		gap: 0.5rem;
	}

	.evc-relay-summary-stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		margin-bottom: 2rem;
		padding: 1rem;
		background-color: var(--background-secondary);
		border-radius: 4px;
	}

	.evc-relay-stat-item {
		text-align: center;
	}

	.evc-relay-global-count {
		grid-column: 1 / -1;
		padding-top: 0.5rem;
		margin-top: 0.5rem;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-relay-warning {
		color: var(--text-warning);
	}

	.evc-relay-critical {
		color: var(--text-error);
	}

	.evc-relay-warning-text {
		font-size: 0.8em;
		margin-top: 0.5rem;
		color: var(--text-warning);
		line-height: 1.4;
	}

	.evc-relay-warning-text.evc-relay-critical {
		color: var(--text-error);
		font-weight: bold;
	}

	.evc-relay-stat-label {
		font-size: 0.9em;
		color: var(--text-muted);
		margin-bottom: 0.5rem;
	}

	.evc-relay-stat-value {
		font-size: 1.2em;
		font-weight: bold;
	}

	@keyframes spin {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}
</style>
