<script lang="ts">
	import { HelpCircle } from "lucide-svelte";
	import { Platform } from "obsidian";
	import InfoPopover from "./InfoPopover.svelte";

	export let heading: HTMLSpanElement | string = "";
	export let helpDescription: string | undefined = undefined;

	let isHelpExpanded = false;

	$: isMobile = Platform?.isMobile ?? false;
	$: showExpandedHelp = !!helpDescription && isHelpExpanded && isMobile;

	function toggleHelp(): void {
		if (!isMobile) return;
		isHelpExpanded = !isHelpExpanded;
	}
</script>

<div class="setting-item setting-item-heading mod-list-item">
	<div class="setting-item-info">
		<div class="setting-item-name">
			<slot name="name">{heading}</slot>
			{#if helpDescription && isMobile}
				<button class="evc-help-button" on:click={toggleHelp} aria-expanded={isHelpExpanded}>
					<HelpCircle size={16} />
				</button>
			{:else if helpDescription}
				<InfoPopover popoverText={helpDescription} />
			{/if}
		</div>
		<slot name="description">
			<div class="setting-item-description">
				<slot name="description" />
			</div>
		</slot>
		{#if showExpandedHelp}
			<div class="evc-help-content" class:expanded={isHelpExpanded}>
				<p>{helpDescription}</p>
			</div>
		{/if}
	</div>
	<div class="setting-item-control">
		<slot />
	</div>
</div>

<style>
	p {
		margin: 0;
	}

	.evc-help-content {
		background: var(--color-base-05);
		border-radius: 4px;
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
		color: var(--text-muted);
		font-size: 0.9em;
		margin-top: 8px;
		padding: 12px 16px;
	}

	.evc-help-button:active {
		color: var(--text-normal);
	}

	@media (hover: hover) {
		.evc-help-button:hover {
			background: transparent;
			border-radius: 0;
			box-shadow: none;
			color: var(--text-normal);
		}
	}

	.evc-help-button {
		-webkit-tap-highlight-color: transparent;
		align-items: center;
		background: transparent;
		border: none;
		border-radius: 50%;
		color: var(--text-muted);
		display: flex;
		height: 24px;
		justify-content: center;
		margin: 0;
		padding: 2px !important;
		width: 24px;
	}

	.setting-item-name {
		align-items: center;
		display: flex;
		gap: 8px;
		overflow: unset;
	}
</style>
