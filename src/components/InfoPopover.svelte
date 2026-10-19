<script lang="ts">
	import { HelpCircle } from "lucide-svelte";

	export let popoverText: string;

	const EDGE_MARGIN = 20;

	let isVisible = false;
	let position: "left" | "right" = "right";
	let buttonEl: HTMLButtonElement;
	let popoverEl: HTMLDivElement;

	function fitsOnRight(button: HTMLButtonElement, popover: HTMLDivElement): boolean {
		const buttonRect = button.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		return buttonRect.right + popoverRect.width <= window.innerWidth - EDGE_MARGIN;
	}

	$: if (isVisible && buttonEl && popoverEl) {
		position = fitsOnRight(buttonEl, popoverEl) ? "right" : "left";
	}

	function show(): void {
		isVisible = true;
	}

	function hide(): void {
		isVisible = false;
	}

	function toggle(): void {
		isVisible = !isVisible;
	}
</script>

<div class="evc-help-container">
	<button
		bind:this={buttonEl}
		on:mouseenter={show}
		on:mouseleave={hide}
		on:click={toggle}
		type="button"
	>
		<HelpCircle size={16} />
	</button>

	{#if isVisible}
		<div bind:this={popoverEl} class="popover {position}">
			<div class="arrow {position}" />
			<p>{popoverText}</p>
		</div>
	{/if}
</div>

<style>
	p {
		color: var(--text-normal);
		margin: 0;
	}

	.arrow.right {
		left: 8px;
	}

	.arrow.left {
		right: 8px;
	}

	.arrow {
		background-color: var(--background-primary);
		border-left: 1px solid var(--background-modifier-border);
		border-top: 1px solid var(--background-modifier-border);
		height: 8px;
		position: absolute;
		top: -5px;
		transform: rotate(45deg);
		width: 8px;
	}

	.evc-help-container > .popover.right {
		left: 0;
	}

	.evc-help-container > .popover.left {
		margin-right: 8px;
		right: 100%;
	}

	.evc-help-container > .popover {
		background-color: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		box-shadow: var(--shadow-s);
		font-size: 0.875rem;
		padding: 8px;
		position: absolute;
		top: 32px;
		transition-delay: 0.1s;
		width: 256px;
		z-index: 70;
	}

	button:focus {
		box-shadow: none;
		color: var(--icon-color-focus);
		outline: none;
	}

	button:hover {
		background-color: transparent;
		border-radius: 0;
		box-shadow: none;
		color: var(--icon-color-hover);
		opacity: var(--icon-opacity-hover);
	}

	button {
		align-items: center;
		background: transparent;
		border: none;
		border-radius: 50%;
		box-shadow: none;
		color: var(--text-muted);
		display: flex;
		height: 24px;
		justify-content: center;
		margin: 0;
		padding: 2px;
		width: 24px;
	}

	.evc-help-container {
		display: inline-block;
		position: relative;
	}
</style>
