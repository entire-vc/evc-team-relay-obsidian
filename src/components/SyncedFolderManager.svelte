<script lang="ts">
	import { debounce, Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "src/main";
	import type { VaultShare } from "src/VaultShare";
	import { uiText } from "../wording/uiText";
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
			new Notice(
				uiText("syncedFolder.missing.relinkFailedNotice", {
					error: e instanceof Error ? e.message : String(e),
				}),
			);
			return;
		}
		new Notice(uiText("syncedFolder.missing.relinkedNotice", { path: relinkTarget }));
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

<!-- Off for a missing folder: the share is fine, its folder is what is gone. -->
{#if !folderMissing}
	<div style={NOTICE_WRAPPER_STYLE}>
		<p style={NOTICE_TEXT_STYLE}>{uiText("syncedFolder.notOnServer")}</p>
	</div>
{/if}

{#if folderMissing}
	<ConfigSectionHeading heading={uiText("syncedFolder.missing.heading")} />
	<SettingsCluster>
		<ConfigRow
			heading={uiText("syncedFolder.missing.recreateHeading")}
			caption={uiText("syncedFolder.missing.recreateCaption", { path: syncedFolder.path })}
		>
			<button on:click={debounce(relinkFolder)}>
				{uiText("syncedFolder.missing.recreateButton")}
			</button>
		</ConfigRow>
		<ConfigRow
			heading={uiText("syncedFolder.missing.relinkHeading")}
			caption={relinkTargets.length > 0
				? uiText("syncedFolder.missing.relinkCaption")
				: uiText("syncedFolder.missing.relinkNoTargets")}
		>
			<select class="dropdown" bind:value={relinkTarget} disabled={relinkTargets.length === 0}>
				{#each relinkTargets as target (target)}
					<option value={target}>{target}</option>
				{/each}
			</select>
			<button disabled={!relinkTarget} on:click={debounce(relinkToOther)}>
				{uiText("syncedFolder.missing.relinkButton")}
			</button>
		</ConfigRow>
		<ConfigRow
			heading={uiText("syncedFolder.missing.removeHeading")}
			caption={uiText("syncedFolder.missing.removeCaption")}
		>
			<button class="mod-warning" on:click={debounce(removeLocalEntry)}>
				{uiText("syncedFolder.missing.removeButton")}
			</button>
		</ConfigRow>
	</SettingsCluster>
{/if}

{#if notice?.kind === "stuck"}
	<ConfigSectionHeading heading={uiText("syncedFolder.uploads.stuckHeading")} />
	<StuckUploadsBlock
		{stuckPaths}
		more={notice.more}
		{retrying}
		onRetry={debounce(retryStuck)}
	/>
{:else if notice?.kind === "pending"}
	<div style={NOTICE_WRAPPER_STYLE}>
		<p style={NOTICE_TEXT_STYLE}>
			{uiText(
				notice.count === 1 ? "syncedFolder.uploads.pendingOne" : "syncedFolder.uploads.pendingOther",
				{ count: notice.count },
			)}
		</p>
	</div>
{/if}

{#if syncedFolder}
	<ConfigSectionHeading heading={uiText("syncedFolder.irreversible.heading")} />
	<SettingsCluster>
		<ConfigRow
			heading={uiText("syncedFolder.irreversible.deleteMetadataHeading")}
			caption={uiText("syncedFolder.irreversible.deleteMetadataCaption")}
		>
			<button class="mod-destructive" on:click={debounce(deleteMetadata)}>
				{uiText("syncedFolder.irreversible.deleteMetadataButton")}
			</button>
		</ConfigRow>

		<!-- Off for a missing folder: there is nothing local to trash. -->
		{#if !folderMissing}
			<ConfigRow
				heading={uiText("syncedFolder.irreversible.deleteFromVaultHeading")}
				caption={uiText("syncedFolder.irreversible.deleteFromVaultCaption")}
			>
				<button class="mod-warning" on:click={debounce(deleteLocalCopy)}>
					{uiText("syncedFolder.irreversible.moveToTrashButton")}
				</button>
			</ConfigRow>
		{/if}
	</SettingsCluster>
{/if}
