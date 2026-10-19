<script lang="ts">
	export let heading: HTMLSpanElement | string = "";
	export let caption: string;

	function splitLines(text: string | undefined): string[] {
		return text !== undefined ? text.split("\n") : [];
	}

	$: descriptionLines = splitLines(caption);
</script>

<div class="setting-item">
	<div class="setting-item-info" style="display: grid">
		<div class="setting-item-name" style="display: grid; align-items: center">
			<slot name="name">{heading}</slot>
		</div>
		<div class="setting-item-description">
			<slot name="description">
				{#each descriptionLines as line}
					<div>{line}</div>
				{/each}
			</slot>
		</div>
	</div>
	<div class="setting-item-control">
		<slot />
	</div>
</div>
