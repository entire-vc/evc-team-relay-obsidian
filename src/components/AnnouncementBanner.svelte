<script lang="ts">
	import { renderInlineEmphasis } from "src/inlineEmphasis";
	import type ServiceHealthMonitor from "src/ServiceHealthMonitor";

	type ServiceHealthReport = NonNullable<InstanceType<typeof ServiceHealthMonitor>["lastReport"]>;

	export let serviceStatus: ServiceHealthReport;
	export let onInstall: () => void;

	function stripHtml(s: string): string {
		return s.replace(/<[^>]+>/g, "");
	}

	function activate() {
		if (serviceStatus.versions) {
			onInstall();
		} else if (serviceStatus.link) {
			window.open(serviceStatus.link);
		}
	}

	function handleActivateKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			activate();
		}
	}
</script>

<div
	class="modal-setting-nav-bar evc-relay-announcement-banner"
	on:click={activate}
	role="button"
	tabindex="0"
	on:keydown={handleActivateKeydown}
	style="background-color: {serviceStatus.backgroundColor
		? serviceStatus.backgroundColor
		: 'var(--color-accent)'} !important"
>
	<span
		class="evc-relay-announcement"
		style="color: {serviceStatus.color ? serviceStatus.color : 'var(--text-on-accent)'} !important"
	>
		{stripHtml(renderInlineEmphasis(serviceStatus.status))}
	</span>
</div>

<style>
	.evc-relay-announcement-banner {
		padding-left: 48px !important;
	}
	.evc-relay-announcement {
		color: var(--text-on-accent);
	}
</style>
