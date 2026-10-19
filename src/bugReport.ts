/**
 * Pure helpers for IssueReportModalContent.svelte's report content, split out
 * so the URL-length invariant is directly unit-testable without
 * mounting the Svelte component: readAllLogs() can return up to ~6MB (current
 * log file + up to 5 backups), while GitHub's issue-compose URL 414s above
 * ~7000 chars. Logs must never be embedded in the issue URL's body param —
 * only in the clipboard copy, which has no such limit.
 */

export interface BugReportMetadata {
	userAgent: string;
	manifest: unknown;
	loadTime: unknown;
	description: string;
}

export function buildMetadataJson(metadata: BugReportMetadata): string {
	return JSON.stringify(metadata, null, 2);
}

export function buildFullReport(metadataJson: string, logs: string | null): string {
	let report = "Bug Report\n\n" + metadataJson + "\n\n";
	if (logs !== null) {
		report += logs;
	}
	return report;
}

const GITHUB_ISSUE_REPO_URL =
	"https://github.com/entire-vc/evc-team-relay-obsidian/issues/new";

export function buildIssueUrl(metadataJson: string, includeLogs: boolean): string {
	const body =
		"Bug Report\n\n" +
		metadataJson +
		(includeLogs
			? "\n\n(Full report including debug logs was copied to your clipboard — paste it here.)"
			: "");
	return (
		GITHUB_ISSUE_REPO_URL +
		"?" +
		new URLSearchParams({ title: "Bug Report", body }).toString()
	);
}
