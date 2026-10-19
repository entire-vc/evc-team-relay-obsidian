import { App } from "obsidian";
import type { ShareRegistry } from "../VaultShare";
import FolderPathAutocomplete from "../components/FolderPathAutocomplete.svelte";
import { SuggestPickerModal } from "./SuggestPickerModal";

const DEFAULT_PLACEHOLDER = "Pick or create a folder...";

/** Quick-switcher-style modal for picking (or creating) a vault folder path. */
export class FolderPathPickerModal extends SuggestPickerModal<string, FolderPathAutocomplete> {
	constructor(
		app: App,
		placeholder: string = DEFAULT_PLACEHOLDER,
		blockedPaths: Set<string> = new Set(),
		shareRegistry: ShareRegistry,
		onSelect: (folderPath: string) => void,
	) {
		const suggestProps = {
			obsidianApp: app,
			placeholder,
			excludedPaths: blockedPaths,
			syncedFolders: shareRegistry,
		};
		super(app, FolderPathAutocomplete, suggestProps, onSelect);
	}
}
