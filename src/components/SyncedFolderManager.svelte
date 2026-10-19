<script lang="ts">
	import { debounce } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "src/main";
	import { type VaultShare } from "src/VaultShare";
	import NavTrail from "./NavTrail.svelte";
	import SettingsCluster from "./SettingsCluster.svelte";
	import ConfigRow from "./ConfigRow.svelte";
	import ConfigSectionHeading from "./ConfigSectionHeading.svelte";

	export let live: TeamRelayPlugin;
	export let syncedFolder: VaultShare;

	const dispatch = createEventDispatcher();

	function goHome(): void {
		dispatch("goBack", { clear: true });
	}

	async function deleteMetadata(): Promise<void> {
		if (syncedFolder) live.shareRegistry.delete(syncedFolder);
		goHome();
	}

	function deleteLocalCopy(): void {
		const folder = syncedFolder && live.pluginVault.getFolderByPath(syncedFolder.path);
		if (folder) live.app.vault.trash(folder, false);
		dispatch("goBack", {});
	}

	// Both buttons re-trigger a debounced click guard on every render -- an
	// inline `debounce(() => handler())` named here instead of wrapped in an
	// extra arrow function.
	$: crumbs = [
		{ type: "home" as const, onClick: goHome },
		{ type: "folder" as const, folder: syncedFolder },
	];

	const NOTICE_WRAPPER_STYLE = "padding: 1em; margin: 1em; background: var(--background-secondary)";
	const NOTICE_TEXT_STYLE = "margin: 1em; text-align: center";
</script>

<NavTrail waypoints={crumbs} />

<div style={NOTICE_WRAPPER_STYLE}>
	<p style={NOTICE_TEXT_STYLE}>
		This Shared Folder is not on a Relay Server, or else you do not have permission to access
		it.
	</p>
</div>

{#if syncedFolder}
	<ConfigSectionHeading heading="Irreversible actions" />
	<SettingsCluster>
		<ConfigRow
			heading="Delete metadata"
			caption="Deletes edit history and disables change tracking."
		>
			<button class="mod-destructive" on:click={debounce(deleteMetadata)}>
				Delete metadata
			</button>
		</ConfigRow>

		<ConfigRow
			heading="Delete from vault"
			caption="Delete the local Shared Folder and all of its contents."
		>
			<button class="mod-warning" on:click={debounce(deleteLocalCopy)}>
				Move to trash
			</button>
		</ConfigRow>
	</SettingsCluster>
{/if}
