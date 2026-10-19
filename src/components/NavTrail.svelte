<script lang="ts">
	import {
		ChevronRight,
		Folder as FolderIcon,
		FolderLock,
		Home as HomeIcon,
		Layers,
		Satellite as SatelliteIcon,
	} from "lucide-svelte";
	import type { RelayWorkspace, RemoteFolderRecord } from "src/RelayModel";
	import type { VaultShare } from "src/VaultShare";

	// A shared base carries the one field every breadcrumb kind has in
	// common, so each concrete variant only spells out what makes it
	// different (its discriminant + payload).
	interface BreadcrumbBase {
		onClick?: () => void;
	}

	interface HomeWaypoint extends BreadcrumbBase {
		type: "home";
	}

	interface TextWaypoint extends BreadcrumbBase {
		type: "text";
		text: string;
	}

	interface RelayWaypoint extends BreadcrumbBase {
		type: "relay";
		relay: RelayWorkspace;
	}

	interface FolderWaypoint extends BreadcrumbBase {
		type: "folder";
		folder: VaultShare;
	}

	interface RemoteFolderWaypoint extends BreadcrumbBase {
		type: "remoteFolder";
		remoteFolder: RemoteFolderRecord;
	}

	type NavWaypoint =
		| HomeWaypoint
		| TextWaypoint
		| RelayWaypoint
		| FolderWaypoint
		| RemoteFolderWaypoint;

	export let waypoints: NavWaypoint[];
	export let tagName = "h4";

	function activate(item: NavWaypoint): void {
		item.onClick?.();
	}

	function handleKeypress(item: NavWaypoint, e: KeyboardEvent): void {
		if (e.key === "Enter" || e.key === " ") activate(item);
	}

	function iconFor(item: NavWaypoint) {
		switch (item.type) {
			case "home":
				return HomeIcon;
			case "relay":
				return SatelliteIcon;
			case "folder":
				return Layers;
			case "remoteFolder":
				return item.remoteFolder?.isPrivate ? FolderLock : FolderIcon;
			default:
				return null;
		}
	}

	// Each rule is independent (not mutually exclusive): a single-item list
	// gets both "first-item" and "evc-last-item" on that one element, mirroring
	// three separate ternaries rather than one if/else chain.
	function positionClasses(index: number, total: number): string {
		const classes: string[] = [];
		if (index === 0) classes.push("first-item");
		if (index === total - 1) classes.push("evc-last-item");
		if (index > 0 && index < total - 1) classes.push("middle-item");
		return classes.join(" ");
	}
</script>

<svelte:element this={tagName} class="evc-breadcrumb-container">
	{#each waypoints as item, index}
		<!-- The separator is grouped with its item in one segment (rather than
		     rendered as a preceding sibling) so a mobile rule that hides an
		     icon-less middle item can hide its chevron along with it — otherwise
		     the chevron survives as an orphaned separator around invisible
		     content. See the icon-less .middle-item rule below. -->
		<span
			class="evc-breadcrumb-segment {positionClasses(index, waypoints.length)} {iconFor(item)
				? ''
				: 'no-icon'}"
		>
			{#if index > 0}
				<ChevronRight size={16} class="evc-breadcrumb-separator" />
			{/if}

			<span class="evc-breadcrumb-item-wrapper">
				<span
					on:click={() => activate(item)}
					on:keypress={(e) => handleKeypress(item, e)}
					tabindex="0"
					role="button"
					class="evc-breadcrumb-item {positionClasses(index, waypoints.length)}"
				>
					{#if iconFor(item)}
						<svelte:component this={iconFor(item)} class="svg-icon evc-breadcrumb-icon" />
					{/if}
					{#if item.type !== "home"}
						<!-- "home" carries no text by design (icon-only waypoint) —
						     rendering the wrapper anyway left a permanently empty
						     .evc-breadcrumb-text span as the first breadcrumb
						     segment. Skipping it removes that empty segment
						     without adding any label. -->
						<span class="evc-breadcrumb-text">
							{#if item.type === "folder"}
								{item.folder.folderLabel}
							{:else if item.type === "remoteFolder"}
								{#if item.remoteFolder.folderName}
									{item.remoteFolder.folderName}
								{:else}
									<span class="faint">(Untitled folder)</span>
								{/if}
							{:else if item.type === "relay"}
								{#if item.relay.displayName}
									{item.relay.displayName}
								{:else}
									<span class="faint">(Untitled Relay Server)</span>
								{/if}
							{:else if item.type === "text"}
								{item.text}
							{/if}
						</span>
					{/if}
				</span>
			</span>
		</span>
	{/each}
</svelte:element>

<style>
	@media (max-width: 768px) {
		.middle-item .evc-breadcrumb-text {
			display: none;
		}

		/* An icon-less middle item has nothing left to show once its text is
		   hidden above -- without this, its own leading separator survives as
		   an orphaned chevron next to empty space. Hiding the whole segment
		   (chevron + item) removes the gap instead of just its text. Icon-
		   bearing middle items are unaffected: their icon still communicates
		   the crumb, so only their text hides (rule above). */
		.evc-breadcrumb-segment.middle-item.no-icon {
			display: none;
		}

		/* Was `.evc-breadcrumb-item-wrapper:last-child` back when the wrapper
		   was a direct flex child of the container -- now that each item is
		   grouped with its separator in a .evc-breadcrumb-segment, `:last-child`
		   would match every segment's (only) wrapper, not just the final one.
		   Target the segment itself via its semantic last-item class instead. */
		.evc-breadcrumb-segment.evc-last-item {
			flex: 1;
			min-width: 0;
			overflow: hidden;
		}

		.evc-last-item,
		.evc-last-item .evc-breadcrumb-text {
			overflow: hidden;
		}

		.evc-last-item .evc-breadcrumb-text {
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	}

	.evc-breadcrumb-text {
		display: inline-block;
	}

	.evc-breadcrumb-item {
		align-items: center;
		cursor: pointer;
		display: flex;
		gap: 0.3em;
		min-width: 0;
	}

	.evc-breadcrumb-item-wrapper {
		align-items: center;
		display: flex;
		gap: 0.3em;
		min-width: 0;
	}

	/* Groups a separator with its item (see the each-block comment above).
	   gap:8px here reproduces the spacing the container's own gap:8px used to
	   provide between the separator and the wrapper when both were its direct
	   children -- visually identical for any segment that stays visible. */
	.evc-breadcrumb-segment {
		align-items: center;
		display: flex;
		gap: 8px;
		min-width: 0;
	}

	.evc-breadcrumb-container {
		align-items: center;
		display: flex;
		gap: 8px;
		overflow: hidden;
	}

	.faint {
		color: var(--text-faint);
	}
</style>
