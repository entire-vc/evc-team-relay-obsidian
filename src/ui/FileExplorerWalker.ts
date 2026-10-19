// Walks a shared-folder subtree of Obsidian's built-in file-explorer view and
// runs every registered TreeRowVisitor against each row, keeping each
// visitor's decoration storage (create/reuse/destroy) up to date as the tree
// changes shape between walks.
import { TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { VaultShare, ShareRegistry } from "../VaultShare";
import type {
	Disposable,
	ExplorerFileRow,
	TreeRowVisitor,
	ExplorerFolderRow,
	ExplorerRow,
} from "./treeVisitor";

export class ExplorerTreeWalker {
	private readonly visitorStore: Map<
		TreeRowVisitor<Disposable>,
		Map<ExplorerRow, Disposable>
	>;

	constructor(
		private readonly explorerLeaf: WorkspaceLeaf,
		private readonly shareRegistry: ShareRegistry,
		private readonly rowVisitors: TreeRowVisitor<Disposable>[],
	) {
		this.visitorStore = new Map(
			this.rowVisitors.map((visitor) => [
				visitor,
				new Map<ExplorerRow, Disposable>(),
			]),
		);
	}

	// Obsidian doesn't expose a public way to go from a vault path to that
	// path's file-explorer row, so this reaches into the view's private
	// `fileItems` map. Wrapped defensively -- that internal shape isn't a
	// contract, and another plugin (or a future Obsidian release) could
	// reshape or remove it.
	private lookupItem<T>(path: string): T | null {
		try {
			type FileExplorerView = { fileItems?: Record<string, unknown> };
			const view = this.explorerLeaf.view as unknown as FileExplorerView;
			return (view.fileItems?.[path] as T | undefined) ?? null;
		} catch {
			return null;
		}
	}

	// Runs every visitor against one row and reconciles that visitor's
	// storage: drop the entry once a visitor stops decorating the row, keep/
	// replace it otherwise. Shared between the folder branch and the file
	// branch of `walk` below, which were previously duplicated.
	private applyVisitors<Item extends ExplorerRow>(
		key: Item,
		visit: (
			visitor: TreeRowVisitor<Disposable>,
			prior?: Disposable,
		) => Disposable | null,
	) {
		this.visitorStore.forEach((store, visitor) => {
			const prior = store.get(key);
			const update = visit(visitor, prior);
			if (prior && !update) {
				store.delete(key);
			} else if (update) {
				store.set(key, update);
			}
		});
	}

	traverse(folder: TFolder, inheritedVaultShare?: VaultShare) {
		if (this.explorerLeaf.view.getViewType() !== "file-explorer") {
			return;
		}
		const vaultShare: VaultShare | undefined =
			this.shareRegistry.locate((sf) => sf.path === folder.path) ??
			inheritedVaultShare;

		const folderItem = this.lookupItem<ExplorerFolderRow>(folder.path);
		if (folderItem) {
			this.applyVisitors(folderItem, (visitor, prior) =>
				visitor.visitFolder(folder, folderItem, prior, vaultShare),
			);
		}

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				this.traverse(child, vaultShare);
				continue;
			}
			if (!(child instanceof TFile)) continue;

			const fileItem = this.lookupItem<ExplorerFileRow>(child.path);
			if (!fileItem) {
				// Android bug?
				continue;
			}
			this.applyVisitors(fileItem, (visitor, prior) =>
				visitor.visitFile(child, fileItem, prior, vaultShare),
			);
		}
	}

	destroy() {
		this.visitorStore.forEach((store) => {
			store.forEach((item) => item.destroy());
		});
	}
}
