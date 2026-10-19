<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type TeamRelayPlugin from "../main";
	import type { Invite } from "../RelayOnPremShareClient";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import { uiText } from "../wording/uiText";

	export let live: TeamRelayPlugin;
	export let share: ShareWithServer;

	const dispatch = createEventDispatcher<{
		created: void;
		cancel: void;
	}>();

	let role: "viewer" | "editor" = "editor";
	let expiresInDays = "7";
	let maxUses = "";
	let creating = false;

	async function handleCreate() {
		const maxUsesNum = maxUses.trim() ? parseInt(maxUses.trim(), 10) : null;
		if (maxUsesNum !== null && (isNaN(maxUsesNum) || maxUsesNum < 1)) {
			new Notice(uiText("createInvite.maxUsesInvalidNotice"));
			return;
		}

		const days = parseInt(expiresInDays, 10);

		creating = true;
		try {
			if (live.shareClientManager) {
				await live.shareClientManager.createInvite(
					share.serverId,
					share.id,
					{
						role,
						expires_in_days: days === 0 ? null : days,
						max_uses: maxUsesNum,
					},
				);
			} else if (live.shareClient) {
				await live.shareClient.createInvite(share.id, {
					role,
					expires_in_days: days === 0 ? null : days,
					max_uses: maxUsesNum,
				});
			} else {
				throw new Error(uiText("shared.noShareClientError"));
			}

			new Notice(uiText("createInvite.createdNotice"));
			dispatch("created");
		} catch (e: unknown) {
			new Notice(uiText("createInvite.createFailedNotice", { error: e instanceof Error ? e.message : uiText("shared.unknownError") }));
		} finally {
			creating = false;
		}
	}
</script>

<div class="evc-create-invite">
	<div class="evc-section-title">{uiText("createInvite.title")}</div>
	<div class="evc-section-desc">{uiText("createInvite.forLabel", { path: share.path })}</div>

	<div class="evc-form-field">
		<label for="evc-invite-role">{uiText("createInvite.roleLabel")}</label>
		<select id="evc-invite-role" class="dropdown" bind:value={role}>
			<option value="viewer">{uiText("shared.viewerOption")}</option>
			<option value="editor">{uiText("shared.editorOption")}</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-expiry">{uiText("createInvite.expirationLabel")}</label>
		<select id="evc-invite-expiry" class="dropdown" bind:value={expiresInDays}>
			<option value="7">{uiText("createInvite.expires7Days")}</option>
			<option value="14">{uiText("createInvite.expires14Days")}</option>
			<option value="30">{uiText("createInvite.expires30Days")}</option>
			<option value="0">{uiText("shared.noExpiration")}</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-maxuses">{uiText("createInvite.maxUsesLabel")}</label>
		<input
			id="evc-invite-maxuses"
			type="number"
			min="1"
			placeholder={uiText("createInvite.unlimitedPlaceholder")}
			bind:value={maxUses}
		/>
	</div>

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating}>
			{creating ? uiText("shared.creatingEllipsis") : uiText("createInvite.createButton")}
		</button>
		<button on:click={() => dispatch('cancel')}>{uiText("shared.cancelButton")}</button>
	</div>
</div>

<style>
	.evc-create-invite {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-section-desc {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: -8px;
	}

	.evc-form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.evc-form-field label {
		font-size: 0.9em;
		color: var(--text-muted);
		font-weight: 500;
	}

	.evc-form-field input,
	.evc-form-field select {
		width: 100%;
	}

	.evc-form-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
</style>
