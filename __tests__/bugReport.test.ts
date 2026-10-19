import { describe, test, expect } from "@jest/globals";
import { buildMetadataJson, buildFullReport, buildIssueUrl } from "../src/bugReport";

// GitHub's issue-compose URL 414s above ~7000 chars (measured live against
// github.com during PR #147 review). Budget well under that so a
// future regression has margin to be caught before it's user-visible.
const GITHUB_URL_BUDGET = 7000;

function hugeLogs(): string {
	// readAllLogs() can return up to ~6MB (current log file + up to 5
	// backups) — simulate that scale to prove it's excluded, not just a
	// small log that happens to fit.
	return "log line\n".repeat(200_000); // ~1.8MB
}

describe("buildIssueUrl", () => {
	test("never embeds log content, even when includeLogs is true", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay", version: "0.1.0" },
			loadTime: 123,
			description: "Something broke",
		});
		const url = buildIssueUrl(metadataJson, true);

		expect(url).not.toContain("log line");
		expect(url.length).toBeLessThan(GITHUB_URL_BUDGET);
	});

	test("stays well under GitHub's URL budget with a large description", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay", version: "0.1.0" },
			loadTime: 123,
			description: "x".repeat(2000),
		});
		const url = buildIssueUrl(metadataJson, false);

		expect(url.length).toBeLessThan(GITHUB_URL_BUDGET);
	});

	test("points the user at the clipboard for logs when includeLogs is true", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay" },
			loadTime: 1,
			description: "desc",
		});
		const url = buildIssueUrl(metadataJson, true);
		const body = new URL(url).searchParams.get("body") ?? "";

		expect(body).toContain("copied to your clipboard");
	});

	test("omits the clipboard pointer when includeLogs is false", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay" },
			loadTime: 1,
			description: "desc",
		});
		const url = buildIssueUrl(metadataJson, false);
		const body = new URL(url).searchParams.get("body") ?? "";

		expect(body).not.toContain("clipboard");
	});
});

describe("buildFullReport", () => {
	test("includes the full log content for the clipboard copy, unlike the issue URL", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay" },
			loadTime: 1,
			description: "desc",
		});
		const logs = hugeLogs();
		const report = buildFullReport(metadataJson, logs);

		expect(report).toContain(logs);
	});

	test("omits log content entirely when logs is null", () => {
		const metadataJson = buildMetadataJson({
			userAgent: "test-agent",
			manifest: { id: "team-relay" },
			loadTime: 1,
			description: "desc",
		});
		const report = buildFullReport(metadataJson, null);

		expect(report).not.toContain("log line");
	});
});
