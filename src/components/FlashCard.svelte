<script lang="ts">
	import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-svelte";
	import { createEventDispatcher, onMount } from "svelte";

	export let toastMessage: string;
	export let detailText = "";
	export let severity: "error" | "warning" | "info" | "success" = "error";
	export let dismissAfterMs = 5000;

	const dispatch = createEventDispatcher();
	const ICONS = {
		error: AlertTriangle,
		warning: AlertCircle,
		success: CheckCircle,
		info: Info,
	} as const;

	let dismissTimer: number | undefined;

	function clearDismissTimer() {
		if (dismissTimer !== undefined) window.clearTimeout(dismissTimer);
	}

	function handleDismiss() {
		clearDismissTimer();
		dispatch("dismiss");
	}

	onMount(() => {
		if (dismissAfterMs > 0) {
			dismissTimer = window.setTimeout(() => dispatch("dismiss"), dismissAfterMs);
		}
		return clearDismissTimer;
	});

	$: Icon = ICONS[severity];
</script>

<div aria-live="polite" class="toast toast-{severity}" role="alert">
	<div class="evc-toast-icon">
		<svelte:component this={Icon} class="svg-icon" />
	</div>

	<div class="evc-toast-content">
		<div class="evc-toast-message">{toastMessage}</div>
		{#if detailText}
			<div class="evc-toast-details">{detailText}</div>
		{/if}
	</div>

	<button aria-label="Dismiss error" class="evc-toast-dismiss" on:click={handleDismiss}>
		<X class="svg-icon" />
	</button>
</div>

<style>
	.toast {
		align-items: flex-start;
		animation: slideDown 0.3s ease-out;
		background: var(--background-primary);
		border: 1px solid;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		color: var(--text-normal);
		display: flex;
		gap: 12px;
		left: 50%;
		max-width: 500px;
		min-height: 48px;
		min-width: 300px;
		padding: 12px 16px;
		pointer-events: auto;
		position: absolute;
		top: 20px;
		transform: translateX(-50%);
		width: max-content;
	}

	.toast-error {
		border-color: var(--text-error);
	}

	.toast-warning {
		border-color: var(--text-warning);
	}

	.toast-success {
		border-color: var(--text-success, #4caf50);
	}

	.toast-info {
		border-color: var(--interactive-accent);
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(-10px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	.evc-toast-icon {
		align-items: center;
		display: flex;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.toast-error .evc-toast-icon {
		color: var(--text-error);
	}

	.toast-warning .evc-toast-icon {
		color: var(--text-warning);
	}

	.toast-success .evc-toast-icon {
		color: var(--text-success, #4caf50);
	}

	.toast-info .evc-toast-icon {
		color: var(--interactive-accent);
	}

	.evc-toast-content {
		flex: 1;
		min-width: 0;
	}

	.evc-toast-message {
		color: var(--text-normal);
		font-weight: 500;
		line-height: 1.4;
		margin-bottom: 2px;
	}

	.evc-toast-details {
		color: var(--text-muted);
		font-size: 0.9em;
		line-height: 1.3;
	}

	.evc-toast-dismiss {
		align-items: center;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-muted);
		cursor: pointer;
		display: flex;
		flex-shrink: 0;
		height: 24px;
		justify-content: center;
		padding: 0;
		transition: all 0.15s ease-in-out;
		width: 24px;
	}

	.evc-toast-dismiss:hover {
		background: var(--background-modifier-hover);
		color: var(--text-error);
	}

	.evc-toast-dismiss:focus {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 1px;
	}
</style>
