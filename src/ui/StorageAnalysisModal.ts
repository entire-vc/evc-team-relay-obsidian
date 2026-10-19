import { App } from "obsidian";
import BrowserStorageAnalysisModalContent from "../components/BrowserStorageAnalysisModalContent.svelte";
import type TeamRelayPlugin from "../main";
import { SimpleContentModal } from "./SimpleContentModal";

export class StorageAnalysisModal extends SimpleContentModal<{ live: TeamRelayPlugin }> {
	constructor(app: App, plugin: TeamRelayPlugin) {
		super(app, BrowserStorageAnalysisModalContent, { live: plugin });
	}
}
