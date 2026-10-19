<script lang="ts">
	import { writable } from "svelte/store";
	import { debounce } from "obsidian";
	import ConfigRow from "./ConfigRow.svelte";
	import ConfigSectionHeading from "./ConfigSectionHeading.svelte";
	import SettingsCluster from "./SettingsCluster.svelte";
	import type TeamRelayPlugin from "../main";
	import { listLogFiles } from "src/logging";

	export let live: TeamRelayPlugin;

	const safeStringify = (fn: () => string, fallback: string) => {
		try {
			return fn();
		} catch (e: unknown) {
			return fallback;
		}
	};

	const detectResponse = () => safeStringify(() => Response.toString(), "undefined");
	const detectFetch = () => safeStringify(() => fetch.toString(), "undefined");
	const detectBlinkFetch = () =>
		safeStringify(
			() =>
				(window as unknown as Record<string, unknown>)?.blinkfetch !== undefined
					? "Yes"
					: "No",
			"No",
		);

	const responseImpl = writable(detectResponse());
	const fetchImpl = writable(detectFetch());
	const usingBlink = writable(detectBlinkFetch());
	const logFiles = writable<string[]>([]);

	void listLogFiles().then((files) => logFiles.set(files));

	function refresh() {
		responseImpl.set(detectResponse());
		fetchImpl.set(detectFetch());
		usingBlink.set(detectBlinkFetch());
	}
</script>

<div class="modal-title">Debug Info</div>
<div class="modal-content">
	<ConfigSectionHeading heading="Environment">
		<button on:click={debounce(refresh)}>Refresh</button>
	</ConfigSectionHeading>

	<SettingsCluster>
		<ConfigRow caption="" heading="User Agent">
			{navigator.userAgent}
		</ConfigRow>

		<ConfigRow caption="" heading="Fetch">
			{$fetchImpl}
		</ConfigRow>

		<ConfigRow caption="" heading="Response">
			{$responseImpl}
		</ConfigRow>

		<ConfigRow caption="" heading="Blink Fetch">
			{$usingBlink}
		</ConfigRow>

		<ConfigRow caption="" heading="Startup Time">
			{live.startupDurationMs ? `${live.startupDurationMs}ms` : "unknown"}
		</ConfigRow>
	</SettingsCluster>

	<ConfigSectionHeading heading="Log Files" />
	<SettingsCluster>
		<ConfigRow caption="" heading="">
			<div slot="description">
				{#each $logFiles as lfile}
					<div>{lfile}</div>
				{/each}
			</div>
		</ConfigRow>
	</SettingsCluster>
</div>
