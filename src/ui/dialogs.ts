/**
 * Obsidian-native dialog helpers.
 *
 * Replaces browser built-ins (confirm, prompt, alert) which are forbidden by
 * the Obsidian plugin review guidelines (no-alert rule).
 */

import { App, Modal, Setting } from "obsidian";

/**
 * Show a confirmation dialog with "Confirm" and "Cancel" buttons.
 * Resolves to true when the user confirms, false otherwise.
 */
export function confirmDialog(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		let resolved = false;
		const modal = new Modal(app);

		modal.contentEl.createEl("p", { text: message });

		new Setting(modal.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						resolved = true;
						modal.close();
						resolve(true);
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					modal.close();
					resolve(false);
				})
			);

		modal.onClose = () => {
			if (!resolved) resolve(false);
		};

		modal.open();
	});
}

/**
 * Show a prompt dialog with a text input field, "OK" and "Cancel" buttons.
 * Resolves to the entered string when the user clicks OK, or null on cancel.
 */
export function promptDialog(
	app: App,
	message: string,
	defaultValue?: string
): Promise<string | null> {
	return new Promise((resolve) => {
		let resolved = false;
		let inputValue = defaultValue ?? "";
		const modal = new Modal(app);

		modal.contentEl.createEl("p", { text: message });

		new Setting(modal.contentEl).addText((text) => {
			text.setValue(inputValue).onChange((v) => {
				inputValue = v;
			});
			// Focus the input when modal opens
			window.setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(modal.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("OK")
					.setCta()
					.onClick(() => {
						resolved = true;
						modal.close();
						resolve(inputValue);
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					modal.close();
					resolve(null);
				})
			);

		modal.onClose = () => {
			if (!resolved) resolve(null);
		};

		modal.open();
	});
}

/**
 * Show a choice dialog for picking between named string options.
 * Resolves to the chosen value, or null on cancel.
 */
export function choiceDialog(
	app: App,
	message: string,
	choices: { label: string; value: string }[]
): Promise<string | null> {
	return new Promise((resolve) => {
		let resolved = false;
		const modal = new Modal(app);

		modal.contentEl.createEl("p", { text: message });

		const setting = new Setting(modal.contentEl);
		for (const choice of choices) {
			setting.addButton((btn) =>
				btn
					.setButtonText(choice.label)
					.setCta()
					.onClick(() => {
						resolved = true;
						modal.close();
						resolve(choice.value);
					})
			);
		}
		setting.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				modal.close();
				resolve(null);
			})
		);

		modal.onClose = () => {
			if (!resolved) resolve(null);
		};

		modal.open();
	});
}
