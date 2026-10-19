<script lang="ts">
	import { Layers, Satellite } from "lucide-svelte";
	import type { ConnectionStatus } from "src/ProviderBacked";
	import type { RemoteFolderRecord } from "src/RelayModel";

	export let connectionStatus: ConnectionStatus = "disconnected";
	export let hubId: string | undefined;
	export let linked: RemoteFolderRecord | undefined;
	export let progressPercent = 0;
	export let transferPhase: "pending" | "running" | "completed" | "failed" = "pending";

	$: progressVisible = progressPercent > 0 && (progressPercent < 100 || transferPhase !== "completed");
	$: relayLabel = `${linked?.workspace.displayName ?? "Relay Server"} (${connectionStatus})`;
</script>

<div class="evc-relay-folder-icons">
	{#if progressVisible}
		<span class="evc-relay-progress-text evc-relay-{transferPhase}" style="opacity: 1"
			>{progressPercent}%</span
		>
	{/if}
	{#if hubId}
		<span aria-label="Tracking Changes" class="notebook evc-relay-icon hidden">
			<Layers class="evc-inline-icon" style="width: 0.8em" />
		</span>
		<span aria-label={relayLabel} class="satellite evc-relay-icon evc-relay-{connectionStatus}">
			<Satellite class="evc-inline-icon" />
		</span>
	{:else}
		<span aria-label="Tracking Changes" class="notebook evc-relay-icon">
			<Layers class="evc-inline-icon" style="width: 0.8em" />
		</span>
	{/if}
</div>

<style>
	.evc-relay-folder-icons {
		align-items: center;
		background-color: var(--color-base-05);
		border-radius: var(--radius-m);
		display: inline-flex;
		margin-right: 0.6em;
		padding-left: 0.2em;
		padding-right: 0.2em;
		position: relative;
		transition: width 0.3s ease;
		vertical-align: middle;
	}

	.evc-relay-icon {
		display: flex;
		margin-left: 0.2em;
		margin-right: 0.2em;
		transition: display 0.3s ease;
		width: 1em;
	}

	span.notebook {
		color: var(--color-accent);
	}

	span.evc-relay-connected {
		color: var(--color-accent);
	}

	span.evc-relay-disconnected {
		color: var(--color-base-40);
	}

	span.hidden {
		display: none;
	}

	.evc-relay-progress-text {
		color: var(--color-accent);
		font-size: 0.8em;
		margin-right: 0.4em;
		opacity: 1;
		transition: opacity 0.3s ease;
	}

	.evc-relay-progress-text.failed {
		color: var(--color-red);
	}

	.evc-relay-progress-text.completed {
		animation: fadeOutDelay 0.3s ease forwards;
	}

	@keyframes fadeOutDelay {
		0%,
		50% {
			opacity: 1;
		}
		100% {
			display: none;
			opacity: 0;
		}
	}
</style>
