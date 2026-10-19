import { App } from "obsidian";
import IssueReportModalContent from "../components/IssueReportModalContent.svelte";
import type TeamRelayPlugin from "../main";
import { SimpleContentModal } from "./SimpleContentModal";

export class IssueReportModal extends SimpleContentModal<{ live: TeamRelayPlugin }> {
	constructor(app: App, plugin: TeamRelayPlugin) {
		super(app, IssueReportModalContent, { live: plugin });
	}
}
