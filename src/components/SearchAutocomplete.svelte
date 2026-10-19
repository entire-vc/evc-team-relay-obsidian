<script lang="ts">
	import { createEventDispatcher, onMount } from "svelte";

	export let placeholder: string = "Search...";
	export let focusOnMount = false;
	export let onChoose: (item: any) => void = () => {};
	export let fetchSuggestions: (query: string) => any[] = () => [];
	export let keyboardHints: Array<{ command: string; purpose: string }> = [
		{ command: "↑/↓", purpose: "Navigate" },
		{ command: "Enter", purpose: "Select" },
		{ command: "Esc", purpose: "Cancel" },
	];

	const FOCUS_DELAY_MS = 10;
	const dispatch = createEventDispatcher();

	let inputEl: HTMLInputElement;
	let query = "";
	let suggestions: any[] = [];
	let activeIndex = 0;

	function refreshSuggestions() {
		suggestions = fetchSuggestions(query);
		activeIndex = 0;
	}

	function choose(item: any) {
		onChoose(item);
		dispatch("select", { item });
	}

	function moveActive(delta: number) {
		activeIndex = Math.max(-1, Math.min(activeIndex + delta, suggestions.length - 1));
	}

	function chooseActiveOrFirst() {
		if (activeIndex >= 0) {
			choose(suggestions[activeIndex]);
		} else if (suggestions.length > 0) {
			choose(suggestions[0]);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveActive(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveActive(-1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (activeIndex >= 0) {
				choose(suggestions[activeIndex]);
			} else if (query.trim() && suggestions.length === 0) {
				dispatch("customInput", { value: query.trim() });
			}
		} else if (e.key === "Tab" && !e.shiftKey) {
			e.preventDefault();
			chooseActiveOrFirst();
		}
	}

	function handleInput() {
		refreshSuggestions();
		dispatch("input", { value: query });
	}

	onMount(() => {
		if (focusOnMount && inputEl) {
			window.setTimeout(() => inputEl.focus(), FOCUS_DELAY_MS);
		}
		refreshSuggestions();
	});
</script>

<div class="prompt">
	<div class="prompt-input-container">
		<input
			autocapitalize="off"
			bind:this={inputEl}
			bind:value={query}
			class="prompt-input"
			enterkeyhint="done"
			on:input={handleInput}
			on:keydown={handleKeydown}
			{placeholder}
			spellcheck="false"
			type="text"
		/>
		<div class="prompt-input-cta"></div>
		<div class="search-input-clear-button"></div>
	</div>

	<div class="prompt-results">
		{#each suggestions as item, i}
			<div
				aria-selected={i === activeIndex}
				class="suggestion-item mod-complex"
				class:is-selected={i === activeIndex}
				on:click={() => choose(item)}
				on:keydown={(e) => e.key === "Enter" && choose(item)}
				on:mouseenter={() => (activeIndex = i)}
				on:mousedown|preventDefault
				role="option"
				tabindex="-1"
			>
				<div class="suggestion-content">
					<div class="suggestion-title">
						<slot index={i} name="suggestion" {item}>
							{item}
						</slot>
					</div>
				</div>
				<div class="suggestion-aux">
					<slot index={i} name="suggestion-aux" {item}>
						<div class="suggestion-icon"></div>
					</slot>
				</div>
			</div>
		{/each}
	</div>

	<div class="prompt-instructions">
		{#each keyboardHints as instruction}
			<div class="prompt-instruction">
				<span class="prompt-instruction-command">{instruction.command}</span>
				<span>{instruction.purpose}</span>
			</div>
		{/each}
	</div>
</div>
