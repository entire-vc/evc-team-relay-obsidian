import { TFile, TFolder } from "obsidian";
import { VaultShare } from "../VaultShare";

// Minimal shape of the rows Obsidian's file-explorer view keeps per vault
// entry (`view.fileItems[path]`), as far as the decorations in this UI layer
// need to reach into them. Obsidian doesn't export this type -- it's a
// private-API surface, so we only describe what we actually touch.
export interface ExplorerRow {
	el: HTMLElement;
}

export interface ExplorerFileRow extends ExplorerRow {
	el: HTMLElement;
	selfEl: HTMLElement;
}

export interface ExplorerFolderRow extends ExplorerRow {
	el: HTMLElement;
	selfEl: HTMLElement;
}

export interface Disposable {
	destroy(): void;
}

export type TeardownFn = () => void;

// One "visitor" is asked about every folder and every file the tree walker
// (ExplorerTreeWalker) crosses. It returns the decoration instance that
// should now be associated with that row -- reusing `storage` (the instance
// from the previous walk, if any) when the row is still decorated, or `null`
// when it isn't (any previous instance is expected to already be destroyed by
// the time `null` comes back).
export interface TreeRowVisitor<T> {
	visitFolder(
		folder: TFolder,
		item: ExplorerFolderRow,
		storage?: T,
		vaultShare?: VaultShare,
	): T | null;
	visitFile(
		file: TFile,
		item: ExplorerFileRow,
		storage?: T,
		vaultShare?: VaultShare,
	): T | null;
}

// Default no-op visitor: concrete visitors only implement the one method
// (folder or file) they actually decorate and inherit the other as a no-op.
export class NoopVisitor<T extends Disposable> implements TreeRowVisitor<T> {
	visitFolder(
		_folder: TFolder,
		_item: ExplorerFolderRow,
		_storage?: T,
		_vaultShare?: VaultShare,
	): T | null {
		return null;
	}

	visitFile(
		_file: TFile,
		_item: ExplorerFileRow,
		_storage?: T,
		_vaultShare?: VaultShare,
	): T | null {
		return null;
	}
}

// Shared shape behind most of the visitors in treeDecorations.ts: "keep the
// existing decoration while the row is still eligible, create one the first
// time it becomes eligible, and tear it down the moment it stops being
// eligible." Centralizing it here means the create/reuse/destroy bookkeeping
// is written -- and can be verified -- exactly once instead of once per
// decoration type.
//
// `guard` is whatever eligibility check narrows to (usually the VaultShare
// itself, once the caller has already tested it truthy alongside the other
// conditions) -- `undefined` means "not eligible right now". Taking it
// instead of a bare boolean lets the factory receive an already-narrowed,
// non-undefined value with no cast at the call site.
export function toggleDecoration<S, T extends Disposable>(
	guard: S | undefined,
	storage: T | undefined,
	factory: (guard: S) => T,
): T | null {
	if (guard !== undefined) {
		return storage ?? factory(guard);
	}
	storage?.destroy();
	return null;
}
