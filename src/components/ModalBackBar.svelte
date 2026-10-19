<script lang="ts">
	import { ChevronLeft } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";

	const dispatch = createEventDispatcher();

	function navBack(node: HTMLElement, onBack: () => void) {
		const onClick = () => onBack();
		const onKeypress = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			onBack();
			event.stopPropagation();
		};
		node.addEventListener("click", onClick);
		node.addEventListener("keypress", onKeypress);
		return {
			destroy() {
				node.removeEventListener("click", onClick);
				node.removeEventListener("keypress", onKeypress);
			},
		};
	}
</script>

<div class="modal-setting-nav-bar">
	<div
		aria-label="Back"
		class="clickable-icon"
		role="button"
		tabindex="0"
		use:navBack={() => dispatch("goBack", {})}
	>
		<ChevronLeft />
	</div>
</div>
