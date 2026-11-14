"use strict";

/**
 * Opening the plugin's own settings tab at a given panel path.
 *
 * Obsidian registers a plugin's settings tab under the plugin's manifest id
 * (`app.setting.pluginTabs[i].id === manifest.id`), and `openTabById()` with
 * any other id silently does nothing: the settings window stays on whatever
 * tab it showed last (General on a fresh open). A hard-coded id therefore
 * breaks every deep link the day the manifest id changes, with no error
 * anywhere. Callers must pass `this.manifest.id`.
 */

/** The internal `app.setting` surface this module needs. */
export interface SettingsWindow {
	open(): Promise<void>;
	openTabById(id: string): Promise<void>;
}

/** The panel mounted inside the tab, as far as path routing is concerned. */
export interface PathPanel {
	update(patch: { initialPath?: string }): void;
}

/**
 * Delivers a requested path to the settings panel whether the panel is
 * already mounted or is mounted after the request (Obsidian may render the
 * tab after `openTabById()` resolves).
 */
export class SettingsPathRouter {
	private panel?: PathPanel;
	private pending?: string;

	/** A new panel was mounted; it is routed to a path requested before. */
	attach(panel: PathPanel): void {
		this.panel = panel;
		const path = this.pending;
		this.pending = undefined;
		if (path) panel.update({ initialPath: path });
	}

	/** The panel was torn down; later requests wait for the next mount. */
	detach(): void {
		this.panel = undefined;
	}

	show(path: string): void {
		if (!this.panel) {
			this.pending = path;
			return;
		}
		// Clear first so asking again for the path the panel was opened on
		// (after the user navigated away inside it) still re-routes.
		this.panel.update({ initialPath: undefined });
		this.panel.update({ initialPath: path });
	}
}

export async function openSettingsAt(
	setting: SettingsWindow,
	pluginId: string,
	page: { showPath(path: string): void },
	path: string,
): Promise<void> {
	await setting.open();
	await setting.openTabById(pluginId);
	page.showPath(path);
}
