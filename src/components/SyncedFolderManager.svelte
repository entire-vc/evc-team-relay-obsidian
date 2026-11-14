<script lang="ts">
	import { debounce, Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "src/main";
	import { type VaultShare } from "src/VaultShare";
	import { uploadNotice } from "src/stuckUploads";
	import NavTrail from "./NavTrail.svelte";
	import SettingsCluster from "./SettingsCluster.svelte";
	import ConfigRow from "./ConfigRow.svelte";
	import ConfigSectionHeading from "./ConfigSectionHeading.svelte";
	import StuckUploadsBlock from "./StuckUploadsBlock.svelte";

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
		if (folder) void live.app.fileManager.trashFile(folder);
		dispatch("goBack", {});
	}

	const folderMissing = syncedFolder ? syncedFolder.folderMissing : false;
	let pendingUploads = syncedFolder ? syncedFolder.pendingUploadCount() : 0;
	let stuckPaths: string[] = syncedFolder ? syncedFolder.stuckUploadPaths() : [];
	$: notice = uploadNotice(pendingUploads, stuckPaths.length);
	let retrying = false;

	const relinkTargets: string[] =
		folderMissing && syncedFolder ? live.shareRegistry.relinkTargets(syncedFolder) : [];
	let relinkTarget = relinkTargets[0] ?? "";

	function relinkToOther(): void {
		if (!syncedFolder || !relinkTarget) return;
		try {
			live.shareRegistry.relink(syncedFolder, relinkTarget);
		} catch (e: unknown) {
			new Notice(`Re-link failed: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		new Notice(`Shared folder re-linked to ${relinkTarget}.`);
		dispatch("goBack", {});
	}

	async function retryStuck(): Promise<void> {
		if (!syncedFolder || retrying) return;
		retrying = true;
		try {
			await syncedFolder.retryPendingUploads();
		} finally {
			retrying = false;
			pendingUploads = syncedFolder.pendingUploadCount();
			stuckPaths = syncedFolder.stuckUploadPaths();
		}
	}

	async function removeLocalEntry(): Promise<void> {
		// Local record only: the server share and other members' access are untouched.
		if (syncedFolder) live.shareRegistry.delete(syncedFolder);
		goHome();
	}

	async function relinkFolder(): Promise<void> {
		// Recreates the missing folder at the share's own path; the share keeps
		// its guid and the next sync repopulates it from the server.
		if (!syncedFolder) return;
		await live.app.vault.createFolder(syncedFolder.path);
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

{#if folderMissing}
	<ConfigSectionHeading heading="Folder not found" />
	<SettingsCluster>
		<ConfigRow
			heading="Recreate folder"
			caption="Recreates the folder at {syncedFolder.path} and reconnects it to the same shared folder. Files are downloaded again from the server."
		>
			<button on:click={debounce(relinkFolder)}>Recreate</button>
		</ConfigRow>
		<ConfigRow
			heading="Re-link to another folder"
			caption={relinkTargets.length > 0
				? "Connects an existing folder in this vault to the same shared folder. Its files are synced with the server."
				: "No folder in this vault can be used: every folder is shared already or contains a shared folder."}
		>
			<select class="dropdown" bind:value={relinkTarget} disabled={relinkTargets.length === 0}>
				{#each relinkTargets as target (target)}
					<option value={target}>{target}</option>
				{/each}
			</select>
			<button disabled={!relinkTarget} on:click={debounce(relinkToOther)}>Re-link</button>
		</ConfigRow>
		<ConfigRow
			heading="Remove from this device"
			caption="Removes only this device's record of the shared folder. The shared folder on the server and other people's access are not changed."
		>
			<button class="mod-warning" on:click={debounce(removeLocalEntry)}>Remove</button>
		</ConfigRow>
	</SettingsCluster>
{/if}

{#if notice?.kind === "stuck"}
	<ConfigSectionHeading heading="Files not uploaded" />
	<StuckUploadsBlock
		{stuckPaths}
		more={notice.more}
		{retrying}
		onRetry={debounce(retryStuck)}
	/>
{:else if notice?.kind === "pending"}
	<div style={NOTICE_WRAPPER_STYLE}>
		<p style={NOTICE_TEXT_STYLE}>
			{notice.count} file{notice.count === 1 ? "" : "s"} not uploaded yet. They stay on this
			device and the upload is retried automatically.
		</p>
	</div>
{/if}

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
