<script lang="ts">
	export let errorMessage: string;
	export let onDismiss: () => void;
</script>

<div class="evc-error-banner">
	<div class="evc-error-content">
		<span class="evc-error-icon">⚠️</span>
		<span class="evc-error-text">{errorMessage}</span>
	</div>
	<button class="evc-error-dismiss" on:click={onDismiss} title="Dismiss error">
		×
	</button>
</div>

<style>
	.evc-error-banner {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin: 12px 0;
		padding: 10px 12px;
		background-color: rgba(255, 0, 0, 0.1);
		color: var(--text-normal);
		border: 1px solid rgba(255, 0, 0, 0.3);
		border-radius: var(--radius-s);
		animation: error-slide-in 0.3s ease-out;
	}

	.evc-error-content {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex: 1;
	}

	.evc-error-icon {
		font-size: 1em;
		line-height: 1.2;
		margin-top: 2px;
	}

	.evc-error-text {
		font-size: 0.85em;
		line-height: 1.4;
		color: var(--text-normal);
	}

	.evc-error-dismiss {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 1.2em;
		font-weight: normal;
		cursor: pointer;
		padding: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.2s ease;
		opacity: 0.6;
	}

	.evc-error-dismiss:hover {
		opacity: 1;
	}

	@keyframes error-slide-in {
		0% {
			opacity: 0;
			transform: translateY(-10px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
