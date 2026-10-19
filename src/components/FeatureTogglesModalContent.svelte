<script lang="ts">
	import { onMount } from "svelte";
	import { setIcon } from "obsidian";
	import { FeatureToggleState, currentToggles } from "../featureToggleState";
	import { isToggleName, type FeatureToggles } from "../featureToggles";

	export let applyChanges: () => void;

	const featureToggleState = FeatureToggleState.getShared();

	$: settings = { ...$featureToggleState.currentToggles };
	$: entries = Object.entries(settings)
		.filter(([key]) => isToggleName(key))
		.sort();

	function toggleFlag(flagName: keyof FeatureToggles) {
		settings[flagName] = !settings[flagName];
		featureToggleState.writeFlag(flagName, settings[flagName]);
	}

	function onFlagInteract(flagName: string) {
		if (!isToggleName(flagName)) {
			throw new Error("Unexpected feature flag!");
		}
		toggleFlag(flagName);
	}

	function handleCheckboxKeydown(event: KeyboardEvent, flagName: string) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onFlagInteract(flagName);
		}
	}

	onMount(() => {
		for (const flagName of Object.keys(settings)) {
			const toggleEl = activeDocument.getElementById(`toggle-${flagName}`);
			if (toggleEl) setIcon(toggleEl, "check");
		}
	});
</script>

<div class="evc-feature-flag-toggle-modal">
	<h2>Feature Flags</h2>
	{#each entries as [flagName, value]}
		<div class="evc-feature-flag-item setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">{flagName}</div>
				<div class="setting-item-description">Toggle {flagName} on or off</div>
			</div>
			<div class="setting-item-control">
				<div
					aria-checked={value}
					class="checkbox-container"
					class:is-enabled={value}
					on:click={() => onFlagInteract(flagName)}
					on:keydown={(e) => handleCheckboxKeydown(e, flagName)}
					role="checkbox"
					tabindex="0"
				>
					<input checked={value} tabindex="-1" type="checkbox" />
					<div class="checkbox-toggle"></div>
				</div>
			</div>
		</div>
	{/each}

	<div class="setting-item">
		<div class="setting-item-control">
			<button aria-label="apply flag settings" on:click={applyChanges} tabindex="0">
				Apply
			</button>
		</div>
	</div>
</div>

<style>
	.evc-feature-flag-toggle-modal {
		padding: 1rem;
	}

	.evc-feature-flag-item {
		align-items: center;
		border-top: 1px solid var(--background-modifier-border);
		display: flex;
		justify-content: space-between;
		padding: 0.5rem 0;
	}

	.checkbox-container {
		cursor: pointer;
	}
</style>
