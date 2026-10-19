<script lang="ts">
	import ConfigRow from "./ConfigRow.svelte";

	export let url: string;
	export let urlValid: boolean;
	export let showInputError: boolean;
	export let invalidTitle: string;
	export let isValidating: boolean;
	export let onAddTenant: () => void;
</script>

<ConfigRow
	heading="Add Enterprise Tenant"
	caption="Enter your organization's tenant URL"
>
	<div class="evc-add-tenant-container">
		<input
			type="text"
			placeholder="https://auth.example.com"
			bind:value={url}
			class="evc-endpoint-url-input"
			class:evc-endpoint-input-invalid={!urlValid || showInputError}
			title={invalidTitle}
		/>
		<button
			class="mod-cta"
			on:click={onAddTenant}
			disabled={isValidating || !url.trim() || !urlValid}
		>
			{isValidating ? "Adding..." : "Add Tenant"}
		</button>
	</div>
</ConfigRow>

<style>
	.evc-add-tenant-container {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.evc-endpoint-url-input {
		flex: 1;
		padding: 6px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		color: var(--text-normal);
	}

	.evc-endpoint-input-invalid {
		border-color: var(--text-error) !important;
		box-shadow: 0 0 0 1px var(--text-error) !important;
		transition:
			border-color 0.3s ease,
			box-shadow 0.3s ease;
	}

	.evc-endpoint-input-invalid:focus {
		border-color: var(--text-error) !important;
		box-shadow: 0 0 0 2px var(--text-error) !important;
	}

	.evc-add-tenant-container button.mod-cta {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		padding: 6px 12px;
		white-space: nowrap;
	}
</style>
