import { App } from "obsidian";
import DiagnosticsModalContent from "../components/DiagnosticsModalContent.svelte";
import type TeamRelayPlugin from "../main";
import { SimpleContentModal } from "./SimpleContentModal";

export class DiagnosticsModal extends SimpleContentModal<{ live: TeamRelayPlugin }> {
	constructor(app: App, plugin: TeamRelayPlugin) {
		super(app, DiagnosticsModalContent, { live: plugin });
	}
}
