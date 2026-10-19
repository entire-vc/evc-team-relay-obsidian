<script lang="ts">
	import { requireApiVersion } from "obsidian";

	const MIN_GROUP_LAYOUT_VERSION = "1.11.0";
	const supportsGroupLayout = requireApiVersion(MIN_GROUP_LAYOUT_VERSION);
</script>

{#if !supportsGroupLayout}
	<slot></slot>
{:else}
	<div class="evc-setting-group"><div class="setting-items"><slot></slot></div></div>
{/if}
