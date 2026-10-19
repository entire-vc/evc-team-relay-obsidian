<script lang="ts">
	export let tenantName: string;
	export let url: string;
	export let environment: string | undefined;
	export let logo: string | undefined;
	export let logoAlt: string;
	export let active: boolean;
	export let cardTitle: string;
	export let onActivate: () => void;
	export let onRemove: (() => void) | undefined = undefined;

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" || e.key === " ") {
			onActivate();
		}
	}
</script>

<div
	class="evc-tenant-card"
	class:active
	on:click={onActivate}
	on:keydown={handleKeydown}
	role="button"
	tabindex="0"
	title={cardTitle}
>
	<div class="evc-tenant-info">
		{#if logo}
			<img src={logo} alt={logoAlt} class="evc-tenant-logo" />
		{/if}
		<div class="evc-tenant-details">
			<div class="evc-tenant-name">{tenantName}</div>
			<div class="evc-tenant-url">{url}</div>
			{#if environment}
				<div class="evc-tenant-env">{environment}</div>
			{/if}
		</div>
	</div>
	<div class="evc-tenant-actions">
		{#if onRemove}
			<button
				class="mod-destructive"
				on:click|stopPropagation={onRemove}
				title="Remove this tenant"
			>
				Remove
			</button>
		{/if}
	</div>
</div>

<style>
	.evc-tenant-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
		margin: 8px 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.evc-tenant-card:hover {
		background: var(--background-modifier-hover);
	}

	.evc-tenant-card.active {
		border-color: var(--interactive-accent);
		background: var(--background-modifier-hover);
	}

	.evc-tenant-info {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
	}

	.evc-tenant-logo {
		width: 4em;
		height: 4em;
		object-fit: contain;
		border-radius: 4px;
		background: var(--background-secondary);
		padding: 4px;
	}

	.evc-tenant-details {
		flex: 1;
	}

	.evc-tenant-name {
		font-weight: 500;
		color: var(--text-normal);
		margin-bottom: 2px;
	}

	.evc-tenant-url {
		font-size: 0.85em;
		color: var(--text-muted);
		font-family: var(--font-monospace);
	}

	.evc-tenant-env {
		font-size: 0.8em;
		color: var(--text-faint);
		text-transform: capitalize;
	}

	.evc-tenant-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
