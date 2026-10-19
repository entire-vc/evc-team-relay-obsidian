<script lang="ts">
	import FlashCard from "./FlashCard.svelte";
	import { hideFlash, flashStore, type FlashMessage } from "../utils/flashStore";

	const isVisible = ([, toast]: [string, FlashMessage]) => toast.isShown;
	$: visibleToasts = Object.entries($flashStore).filter(isVisible);
</script>

<div class="evc-toast-container">
	{#each visibleToasts as [key, toast] (key)}
		<FlashCard
			dismissAfterMs={toast.autoDismissMs}
			detailText={toast.detailText}
			toastMessage={toast.toastMessage}
			on:dismiss={() => hideFlash(key)}
			severity={toast.type}
		/>
	{/each}
</div>

<style>
	.evc-toast-container {
		height: 0;
		left: 0;
		pointer-events: none;
		position: fixed;
		top: 0;
		width: 100vw;
		z-index: 1000;
	}
</style>
