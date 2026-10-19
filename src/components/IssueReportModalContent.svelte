<script lang="ts">
	import { copyToClipboard } from "../utils/clipboard";
	import ConfigRow from "./ConfigRow.svelte";
	import type TeamRelayPlugin from "../main";
	import { listLogFiles, readAllLogs } from "../logging";
	import { buildMetadataJson, buildFullReport, buildIssueUrl } from "../bugReport";

	export let live: TeamRelayPlugin;

	type Phase = "form" | "sending" | "sent";

	let phase: Phase = "form";
	let bugDescription = "";
	let includeLogs = false;
	let logFiles: string[] = [];

	listLogFiles().then((files) => {
		logFiles = files;
	});

	function toggleIncludeLogs() {
		includeLogs = !includeLogs;
	}

	// TR·plugin: this used to PUT the report straight to a
	// third-party bug-report endpoint — our users' account IDs, debug logs
	// and descriptions went to infrastructure we don't operate or see
	// reports from, with no review step. Route to our own GitHub issues
	// instead (same repo the plugin's other outbound links already point
	// at — see RelayOnPremSettings.svelte), pre-filled but NOT
	// auto-submitted: the user reviews the exact content on GitHub's
	// compose page before anything is public.
	//
	// Logs are deliberately NEVER put in the issue URL's body param:
	// readAllLogs() can return up to ~6MB (current log file + up to 5
	// backups), while GitHub 414s a compose URL above ~7000 chars —
	// nowhere close to silent truncation, an oversized URL just fails to
	// open at all. The full report (metadata + description + logs if
	// requested) always goes to the clipboard instead; the issue body
	// carries only the metadata/description plus a pointer to paste the
	// clipboard contents in.
	async function copyReportToClipboard(report: string) {
		try {
			await copyToClipboard(report);
		} catch (e: unknown) {
			// Clipboard access can be denied in some contexts; the
			// pre-filled issue body still carries the metadata and
			// description (just not the logs), so this is not fatal.
		}
	}

	async function send() {
		phase = "sending";

		const metadataJson = buildMetadataJson({
			userAgent: navigator.userAgent,
			manifest: live.manifest,
			loadTime: live.startupDurationMs,
			description: bugDescription,
		});
		const logs = includeLogs ? await readAllLogs() : null;
		await copyReportToClipboard(buildFullReport(metadataJson, logs));

		const issueUrl = buildIssueUrl(metadataJson, includeLogs);
		const opened = window.open(issueUrl, "_blank");
		// window.open can return null (popup blocked, etc). Without this
		// fallback, phase stays "sending" forever and the button stays
		// disabled with no way out — the report is still safely on the
		// clipboard, so drop back to the form rather than stranding the
		// user on a permanent spinner.
		phase = opened ? "sent" : "form";
	}

	// This element is a div with role="checkbox", not a native <input>, so it
	// gets no built-in keyboard activation — a focusable control that only
	// responds to the mouse. Enter and Space are what WAI-ARIA specifies for
	// role="checkbox"; preventDefault on Space stops the modal scrolling
	// underneath the toggle. This used to be `on:keypress={() => {}}`, an
	// empty handler that silenced Svelte's a11y-click-events-have-key-events
	// warning without implementing the behaviour it asks for; verified live
	// over CDP that Space/Enter did nothing while the mouse worked.
	function handleCheckboxKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggleIncludeLogs();
		}
	}
</script>

<div class="modal-title">Send Bug Report</div>
<div class="modal-content evc-relay-bug-report">
	{#if phase === "sent"}
		<div class="evc-centered-message">
			<ConfigRow
				heading="Thank you!"
				caption="Thanks — your report helps us improve Team Relay."
			></ConfigRow>
		</div>
	{:else if phase === "form"}
		<div class="evc-report-container">
			<div class="evc-form-content">
				<ConfigRow
					heading="Description"
					caption="Please describe what went wrong and what you were trying to do."
				></ConfigRow>
				<textarea
					bind:value={bugDescription}
					placeholder="Describe the issue here..."
				></textarea>

				<ConfigRow
					heading="Include Logs"
					caption="Attach debug logs. They may contain names and paths of files in your vault, and will be visible in a public issue on GitHub."
				>
					<div
						role="checkbox"
						tabindex="0"
						aria-checked={includeLogs}
						class:is-enabled={includeLogs}
						class="checkbox-container"
						on:keydown={handleCheckboxKeydown}
						on:click={toggleIncludeLogs}
					>
						<input type="checkbox" tabindex="-1" checked={includeLogs} />
						<div class="checkbox-toggle"></div>
					</div>
				</ConfigRow>
				{#if includeLogs}
					<ConfigRow heading="Logs" caption="">
						<div slot="description">
							{#each logFiles as lfile}
								<div>
									{`${lfile}\n`}
								</div>
							{/each}
						</div>
					</ConfigRow>
				{/if}
			</div>

			<ConfigRow heading="" caption="">
				<button on:click={send}>Send</button>
			</ConfigRow>
		</div>
	{:else}
		<div class="evc-centered-message">
			<div id="spinner" class="d-flex align-items-center">
				<strong>Sending Bug Report...</strong>
				<div
					role="status"
					aria-hidden="true"
					class="spinner-border ms-auto"
				></div>
			</div>
		</div>
	{/if}
</div>

<style>
	.evc-report-container,
	.evc-relay-bug-report {
		display: flex;
		flex-direction: column;
	}

	.evc-relay-bug-report {
		height: 100%;
		min-height: 30em;
	}

	.evc-report-container {
		flex: 1;
	}

	.evc-centered-message {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		padding-bottom: 5em;
	}

	.evc-form-content {
		flex: 1;
		overflow-y: auto;
	}

	textarea {
		width: 100%;
		height: 300px;
		resize: vertical;
	}
</style>
