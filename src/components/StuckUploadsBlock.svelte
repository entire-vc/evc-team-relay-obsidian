<script lang="ts">
	import SettingsCluster from "./SettingsCluster.svelte";
	import ConfigRow from "./ConfigRow.svelte";
	import { uiText } from "../wording/uiText";

	/** Files pending for more than 7 days. */
	export let stuckPaths: string[];
	/** Other files still waiting for their first upload. */
	export let more: number;
	export let retrying: boolean;
	export let onRetry: () => void;

	let showFiles = false;
	$: stuck = stuckPaths.length;
</script>

<!-- One block: the stuck row, its file list right under it, the "more" line last. -->
<SettingsCluster>
	<ConfigRow
		heading={uiText(stuck === 1 ? "stuckUploads.headingOne" : "stuckUploads.headingOther", {
			count: stuck,
		})}
		caption={uiText("stuckUploads.caption")}
	>
		<button on:click={() => (showFiles = !showFiles)}>
			{showFiles ? uiText("stuckUploads.hideFilesButton") : uiText("stuckUploads.showFilesButton")}
		</button>
		<button class="mod-cta" disabled={retrying} on:click={onRetry}>
			{retrying ? uiText("stuckUploads.retryingButton") : uiText("stuckUploads.retryButton")}
		</button>
	</ConfigRow>
	{#if showFiles}
		<div class="setting-item evc-stuck-upload-files">
			<ul class="evc-stuck-upload-list">
				{#each stuckPaths as path (path)}
					<li>{path}</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#if more > 0}
		<!-- A setting-item row without a control: same padding as the rows above it. -->
		<div class="setting-item evc-stuck-upload-more">
			<div class="setting-item-info">
				<div class="setting-item-description">
					{uiText(more === 1 ? "stuckUploads.moreOne" : "stuckUploads.moreOther", { count: more })}
				</div>
			</div>
		</div>
	{/if}
</SettingsCluster>
