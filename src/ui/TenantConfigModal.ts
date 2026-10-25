import { App, Modal } from "obsidian";
import ServerConfigModalContent from "../components/ServerConfigModalContent.svelte";
import type TeamRelayPlugin from "../main";
import { mountComponent, type MountedComponent } from "../svelteMount";

const REOPEN_DELAY_MS = 100;

export class TenantConfigModal extends Modal {
	private contentComponent?: MountedComponent<Record<string, unknown>>;

	constructor(
		app: App,
		private teamRelayPlugin: TeamRelayPlugin,
		private onReload: () => void,
	) {
		super(app);
		this.setTitle("Enterprise tenant configuration");
	}

	onOpen(): void {
		this.contentComponent = mountComponent(ServerConfigModalContent, {
			target: this.contentEl,
			props: {
				live: this.teamRelayPlugin,
				onClose: () => this.close(),
				onApply: () => {
					this.close();
					window.setTimeout(() => this.onReload(), REOPEN_DELAY_MS);
				},
			},
		});
	}

	onClose(): void {
		this.contentComponent?.destroy();
		this.contentEl.empty();
	}
}
