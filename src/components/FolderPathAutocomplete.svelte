<script lang="ts">
	import { App, TFolder } from "obsidian";
	import { Layers } from "lucide-svelte";
	import SearchAutocomplete from "./SearchAutocomplete.svelte";
	import type { ShareRegistry } from "../VaultShare";

	interface FolderPickerOption {
		folderPath: string;
		isNewFolder: boolean;
		isSyncedShare: boolean;
		isRelayLinked: boolean;
	}

	export let obsidianApp: App;
	export let placeholder = "Pick or create a folder...";
	export let excludedPaths: Set<string> = new Set();
	export let syncedFolders: ShareRegistry;
	export let focusOnMount = false;
	export let onChoose: (folderPath: string) => void = () => {};

	const MAX_SUGGESTIONS = 100;

	function collectSharedRelayStatus(): Map<string, boolean> {
		const map = new Map<string, boolean>();
		syncedFolders?.each((folder) => map.set(folder.path, !!folder.workspaceId));
		return map;
	}

	function collectAllFolders(sharedRelayStatus: Map<string, boolean>, query: string) {
		const suggestions: FolderPickerOption[] = [];
		const existingPaths = new Set<string>();

		const visit = (folder: TFolder) => {
			const blocked = excludedPaths.has(folder.path) && folder.path !== "/";
			const matches = !query || folder.path.toLowerCase().includes(query);

			if (!blocked && matches && !excludedPaths.has(folder.path)) {
				suggestions.push({
					folderPath: folder.path,
					isNewFolder: false,
					isSyncedShare: sharedRelayStatus.has(folder.path),
					isRelayLinked: sharedRelayStatus.get(folder.path) || false,
				});
				existingPaths.add(folder.path.toLowerCase());
			}
			if (!blocked) {
				for (const child of folder.children) {
					if (child instanceof TFolder) visit(child);
				}
			}
		};

		visit(obsidianApp.vault.getRoot());
		return { suggestions, existingPaths };
	}

	function rankSuggestions(a: FolderPickerOption, b: FolderPickerOption): number {
		if (a.isNewFolder !== b.isNewFolder) return a.isNewFolder ? -1 : 1;

		const aUnlinked = a.isSyncedShare && !a.isRelayLinked;
		const bUnlinked = b.isSyncedShare && !b.isRelayLinked;
		if (aUnlinked && !bUnlinked) return -1;
		if (bUnlinked && !aUnlinked) return 1;

		return a.folderPath.localeCompare(b.folderPath);
	}

	function getFolderSuggestions(query: string): FolderPickerOption[] {
		const sharedRelayStatus = collectSharedRelayStatus();
		const { suggestions, existingPaths } = collectAllFolders(
			sharedRelayStatus,
			query.toLowerCase(),
		);

		const trimmed = query.trim();
		if (trimmed && !existingPaths.has(trimmed.toLowerCase())) {
			suggestions.unshift({
				folderPath: trimmed,
				isNewFolder: true,
				isSyncedShare: false,
				isRelayLinked: false,
			});
		}

		return suggestions.sort(rankSuggestions).slice(0, MAX_SUGGESTIONS);
	}

	function handleSelect(suggestion: FolderPickerOption) {
		onChoose(suggestion.folderPath);
	}
</script>

<SearchAutocomplete
	{focusOnMount}
	fetchSuggestions={getFolderSuggestions}
	keyboardHints={[
		{ command: "↑/↓", purpose: "Navigate" },
		{ command: "Enter", purpose: "Choose and share folder" },
		{ command: "Esc", purpose: "Cancel" },
	]}
	on:customInput={(e) => onChoose(e.detail.value)}
	onChoose={handleSelect}
	{placeholder}
>
	<svelte:fragment let:item slot="suggestion">
		{#if item.isNewFolder}
			<span class="suggestion-create-prefix">Create: </span>{item.folderPath}
		{:else}
			{item.folderPath}
		{/if}
	</svelte:fragment>

	<svelte:fragment let:item slot="suggestion-aux">
		{#if item.isNewFolder}
			<span class="suggestion-action">Enter to create</span>
		{:else if item.isSyncedShare && !item.isRelayLinked}
			<div class="suggestion-icon">
				<Layers class="evc-relay-svg-icon" size={16} />
			</div>
		{:else}
			<div class="suggestion-icon"></div>
		{/if}
	</svelte:fragment>
</SearchAutocomplete>

<style>
	.suggestion-create-prefix {
		color: var(--text-muted);
		font-style: italic;
	}

	.suggestion-action {
		color: var(--text-muted);
		font-size: var(--font-smaller);
	}

	.suggestion-icon {
		align-items: center;
		display: flex;
	}

	:global(.evc-relay-svg-icon) {
		color: var(--text-muted);
		opacity: 0.6;
	}
</style>
