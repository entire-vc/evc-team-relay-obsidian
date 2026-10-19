<script lang="ts">
	/**
	 * The two independent floating overlays SettingsPanel.svelte renders on
	 * top of whatever view is active: the toast stack (gated behind a featureKey)
	 * and the "you're running a version older than what shipped" badge. Kept
	 * together in one component only because both are non-content chrome
	 * anchored to the modal's corner, not because they're related to each
	 * other -- each condition is independent.
	 */
	import type TeamRelayPlugin from "src/main";
	import FlashCardStack from "./FlashCardStack.svelte";
	import { currentToggles } from "../featureToggleState";

	export let live: TeamRelayPlugin;

	$: toastsEnabled = currentToggles().enableToasts;
	$: runningOutdatedVersion = live.manifest.version !== live.pluginVersion;
</script>

{#if toastsEnabled}
	<FlashCardStack />
{/if}

{#if runningOutdatedVersion}
	<span class="evc-relay-version">
		{live.pluginVersion}
	</span>
{/if}

<style>
	.evc-relay-version {
		border-top-left-radius: 1em;
		padding-left: 1em;
		padding-top: 0.3em;
		padding-right: 1em;
		font-size: xx-small;
		right: 0;
		bottom: 0;
		position: absolute;
		color: var(--text-faint);
		background: var(--color-base-10);
		user-select: auto;
	}
</style>
