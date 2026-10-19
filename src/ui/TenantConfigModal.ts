import { App, Modal } from "obsidian";
import ServerConfigModalContent from "../components/ServerConfigModalContent.svelte";
import type TeamRelayPlugin from "../main";

const REOPEN_DELAY_MS = 100;

export class TenantConfigModal extends Modal {
	private contentComponent?: ServerConfigModalContent;

	constructor(
		app: App,
		private teamRelayPlugin: TeamRelayPlugin,
		private onReload: () => void,
	) {
		super(app);
		this.setTitle("Enterprise tenant configuration");
	}

	onOpen(): void {
		this.contentComponent = new ServerConfigModalContent({
			target: this.contentEl,
			props: { live: this.teamRelayPlugin },
		});
		this.contentComponent.$on("close", () => this.close());
		this.contentComponent.$on("apply", () => {
			this.close();
			window.setTimeout(() => this.onReload(), REOPEN_DELAY_MS);
		});
	}

	onClose(): void {
		this.contentComponent?.$destroy();
		this.contentEl.empty();
	}
}
