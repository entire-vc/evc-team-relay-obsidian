// Concrete decorations applied to file-explorer rows for shared folders, and
// the TreeRowVisitor that decides, per row, whether each one should be
// attached right now. Split out of ExplorerDecorationCoordinator.ts so the
// walker (which owns *when* rows get visited) and the top-level orchestrator
// (which owns *which* visitors run) don't have to carry the decoration
// bodies inline.
import { TFile, TFolder } from "obsidian";
import { VaultShare } from "../VaultShare";
import { OBSIDIAN_VAULT_ROOT_PATH, isRootSharePath } from "../vaultRootPath";
import type { ConnectionState } from "src/ProviderBacked";
import { Document } from "src/Document";
import SyncStatusBadge from "src/components/SyncStatusBadge.svelte";
import TextBadge from "src/components/TextBadge.svelte";
import UploadBadge from "src/components/UploadBadge.svelte";
import type { TransferTask } from "src/TransferQueue";
import type { Unsubscriber } from "src/notifiers/Notifier";
import type { NotifierSet } from "src/notifiers/NotifierSet";
import { AttachmentFile, isAttachmentFile } from "src/AttachmentFile";
import { CanvasDocument } from "src/CanvasDocument";
import { namedLogger } from "src/logging";
import { SiblingAppearanceObserver } from "./SiblingWatcher";
import { NoopVisitor, toggleDecoration } from "./treeVisitor";
import type { Disposable, ExplorerFileRow, ExplorerFolderRow, TeardownFn } from "./treeVisitor";

// A VaultShare's own row is the explorer row for the TFolder it shares. For
// every folder but the vault root this is a plain path match -- but a root
// share's `.path` is `""` (see vaultRootPath.ts) while Obsidian's root
// TFolder itself reports `.path === "/"`, so the two conventions need an
// explicit bridge instead of `===`.
function isShareFolderRow(vaultShare: VaultShare | undefined, folder: TFolder): boolean {
	if (!vaultShare) return false;
	if (isRootSharePath(vaultShare.path)) return folder.path === OBSIDIAN_VAULT_ROOT_PATH;
	return vaultShare.path === folder.path;
}

// Marks the row directly under a shared folder's own row as "live" --
// Obsidian renders that row (the folder's file/subfolder list) as a sibling
// that shows up async, hence the SiblingAppearanceObserver.
class FolderLiveIndicator implements Disposable {
	private readonly siblingObserver: SiblingAppearanceObserver;

	constructor(
		private readonly folderRowEl: HTMLElement,
		readonly vaultShare: VaultShare,
	) {
		this.siblingObserver = new SiblingAppearanceObserver(this.folderRowEl, () =>
			this.markSiblingLive(),
		);
		this.markSiblingLive();
	}

	private markSiblingLive() {
		(this.folderRowEl.nextSibling as HTMLElement)?.addClass("evc-relay-live");
	}

	private clearSiblingLive() {
		(this.folderRowEl.nextSibling as HTMLElement)?.removeClass("evc-relay-live");
	}

	destroy() {
		this.siblingObserver.destroy();
		this.clearSiblingLive();
	}
}

export class FolderLiveIndicatorVisitor extends NoopVisitor<FolderLiveIndicator> {
	visitFolder(
		folder: TFolder,
		item: ExplorerFolderRow,
		storage?: FolderLiveIndicator,
		vaultShare?: VaultShare,
	): FolderLiveIndicator | null {
		const target = isShareFolderRow(vaultShare, folder) ? vaultShare : undefined;
		return toggleDecoration(target, storage, (sf) =>
			new FolderLiveIndicator(item.selfEl, sf),
		);
	}
}

// Renders the connection-status pill on a shared folder's own row.
class FolderStatusPill implements Disposable {
	private readonly el: HTMLElement;
	private readonly pill: SyncStatusBadge;
	private readonly unsubscribe: TeardownFn;

	constructor(
		el: HTMLElement,
		private readonly vaultShare: VaultShare,
	) {
		// clean up failed destroys
		const stalePills = el.querySelectorAll(".evc-relay-folder-icons");
		if (stalePills.length > 1) {
			stalePills.forEach((pill) => pill.remove());
		}

		this.el = el;
		this.el.addClass("evc-relay-pill");

		this.pill = new SyncStatusBadge({
			target: this.el,
			props: {
				connectionStatus: this.vaultShare.connectionState.status,
				hubId: this.vaultShare.workspaceId,
				linked: this.vaultShare.linked,
				progressPercent: 0,
				transferPhase: "pending",
			},
		});

		const unsubs: TeardownFn[] = [
			this.vaultShare.subscribe(this.el, (state: ConnectionState) => {
				this.pill.$set({
					connectionStatus: state.status,
					hubId: this.vaultShare.workspaceId,
					linked: this.vaultShare.linked,
				});
			}),
			this.vaultShare.transfers.onBatchProgress(
				this.vaultShare,
				(progress) => {
					if (progress) {
						this.pill.$set({
							progressPercent: progress.percent,
							transferPhase: progress.phase,
						});
					}
				},
			),
		];
		this.unsubscribe = () => unsubs.forEach((u) => u());
	}

	destroy() {
		this.pill.$destroy();
		this.unsubscribe();
		this.el.removeClass("evc-relay-pill");
	}
}

export class FolderStatusPillVisitor extends NoopVisitor<FolderStatusPill> {
	visitFolder(
		folder: TFolder,
		item: ExplorerFolderRow,
		storage?: FolderStatusPill,
		vaultShare?: VaultShare,
	): FolderStatusPill | null {
		const target = isShareFolderRow(vaultShare, folder) ? vaultShare : undefined;
		return toggleDecoration(target, storage, (sf) =>
			new FolderStatusPill(item.selfEl, sf),
		);
	}
}

// Toggles `.evc-relay-syncing` / `.evc-relay-downloading` on a file's title
// element while that file sits in the active sync/download queues.
class SyncQueueIndicator implements Disposable {
	private readonly teardowns: Unsubscriber[];
	private readonly labelEl: HTMLElement;

	constructor(
		el: HTMLElement,
		private readonly rowPath: string,
		private readonly activeUploads: NotifierSet<TransferTask>,
		private readonly activeFetches: NotifierSet<TransferTask>,
	) {
		this.labelEl = el.querySelector(".nav-file-title") || el;
		this.teardowns = [
			this.activeUploads.subscribe(() => this.refreshBadges()),
			this.activeFetches.subscribe(() => this.refreshBadges()),
		];
		this.refreshBadges();
	}

	private refreshBadges() {
		const isSyncing = this.activeUploads.any((item) => item.absolutePath === this.rowPath);
		const isDownloading = this.activeFetches.any(
			(item) => item.absolutePath === this.rowPath,
		);

		this.labelEl.toggleClass("evc-relay-syncing", isSyncing);
		this.labelEl.toggleClass("evc-relay-downloading", isDownloading);
	}

	destroy() {
		this.labelEl.removeClass("evc-relay-uploading");
		this.labelEl.removeClass("evc-relay-downloading");
		this.teardowns.forEach((unsub) => unsub());
	}
}

export class SyncQueueIndicatorVisitor extends NoopVisitor<SyncQueueIndicator> {
	constructor(
		private readonly activeUploads: NotifierSet<TransferTask>,
		private readonly activeFetches: NotifierSet<TransferTask>,
	) {
		super();
	}

	visitFile(
		file: TFile,
		item: ExplorerFileRow,
		storage?: SyncQueueIndicator,
		vaultShare?: VaultShare,
	): SyncQueueIndicator | null {
		const target =
			vaultShare &&
			vaultShare.isPrepared &&
			vaultShare.containsPath(file.path) &&
			Document.matchesTrackedExtension(file.path)
				? vaultShare
				: undefined;
		return toggleDecoration(target, storage, () =>
			new SyncQueueIndicator(
				item.el,
				file.path,
				this.activeUploads,
				this.activeFetches,
			),
		);
	}
}

// Shows the upload-progress pill ("uploading", "uploaded", etc.) on a
// syncable non-document file (an attachment tracked by AttachmentFile rather than
// by the Yjs-backed Document flow).
class FileUploadPill implements Disposable {
	private badge?: UploadBadge;
	private readonly unsubscribes: Unsubscriber[];

	constructor(
		private readonly rowEl: HTMLElement,
		readonly attachment: AttachmentFile,
	) {
		this.rowEl.querySelectorAll(".evc-relay-uploadpill").forEach((el) => {
			el.remove();
		});
		this.unsubscribes = [this.attachment.subscribe(() => this.refreshBadge())];
	}

	private refreshBadge() {
		if (!this.attachment) return;
		if (this.attachment.hasRemoteMeta) {
			this.badge?.$destroy();
			return;
		}
		const pillText = this.attachment.statusTag;
		const tintColor = this.attachment.lastUploadError
			? "var(--text-error)"
			: undefined;
		if (!this.badge) {
			this.badge = new UploadBadge({
				target: this.rowEl,
				props: { pillText, ariaLabel: pillText, tintColor },
			});
		} else {
			this.badge.$set({ pillText, ariaLabel: pillText, tintColor });
		}
	}

	destroy() {
		this.unsubscribes.forEach((off) => off());
		this.rowEl.querySelectorAll(".evc-relay-uploadpill").forEach((el) => {
			el.remove();
		});
		this.badge?.$destroy();
	}
}

export class FileUploadPillVisitor extends NoopVisitor<FileUploadPill> {
	visitFile(
		tfile: TFile,
		item: ExplorerFileRow,
		storage?: FileUploadPill,
		vaultShare?: VaultShare,
	): FileUploadPill | null {
		if (
			vaultShare &&
			!Document.matchesTrackedExtension(tfile.path) &&
			!CanvasDocument.matchesTrackedExtension(tfile.path) &&
			vaultShare.isSyncableVaultFile(tfile) &&
			vaultShare.isPrepared &&
			vaultShare.isOnline
		) {
			try {
				const file = vaultShare.rootRelative.peekAttachment(tfile.path);
				if (file && isAttachmentFile(file)) {
					if (storage && storage.attachment === file) {
						return storage;
					}
					return new FileUploadPill(item.selfEl, file);
				}
			} catch (e: unknown) {
				namedLogger("FileUploadPillVisitor.visitFile", "error")(e);
			}
		}
		storage?.destroy();
		return null;
	}
}

// Marks a file as excluded from sync (extension not covered by any syncable
// type) with a "NOT SYNCED" pill. `text`/`label` are copy read by the user
// and must stay byte-for-byte stable — do not reword casually.
class UnsyncedFilePill implements Disposable {
	private readonly pill: TextBadge;

	constructor(private readonly el: HTMLElement) {
		this.el.querySelectorAll(".evc-relay-filepill").forEach((el) => {
			el.remove();
		});
		// TODO: Ensure the not-synced pill comes last
		this.pill = new TextBadge({
			target: this.el,
			props: {
				pillText: "NOT SYNCED",
				ariaLabel: "Syncing this file type is disabled",
			},
		});
	}

	destroy() {
		this.pill.$destroy();
		this.el.querySelectorAll(".evc-relay-filepill").forEach((el) => {
			el.remove();
		});
	}
}

export class UnsyncedFilePillVisitor extends NoopVisitor<UnsyncedFilePill> {
	visitFile(
		file: TFile,
		item: ExplorerFileRow,
		storage?: UnsyncedFilePill,
		vaultShare?: VaultShare,
	): UnsyncedFilePill | null {
		const target =
			vaultShare &&
			vaultShare.containsPath(file.path) &&
			!vaultShare.isSyncableVaultFile(file)
				? vaultShare
				: undefined;
		return toggleDecoration(target, storage, () =>
			new UnsyncedFilePill(item.selfEl),
		);
	}
}

// Reflects a Document's live-connection state as CSS classes on the file
// row (connecting / connected / disconnected / none).
class DocumentConnectionStatus implements Disposable {
	private document?: Document;

	constructor(
		private readonly el: HTMLElement,
		document: Document,
		_doc: TFile,
	) {
		this.document = document;
		this.document.subscribe(el, (status) => this.applyStatus(status));
		this.applyStatus(this.document.connectionState);
	}

	private applyStatus(status?: ConnectionState) {
		const connected = status?.status === "connected";
		const connecting = status?.status === "connecting";
		const live = connected || connecting || status?.status === "disconnected";

		this.el.toggleClass("evc-relay-connected", connected);
		this.el.toggleClass("evc-relay-connecting", connecting);
		this.el.toggleClass("evc-relay-live", live);
	}

	destroy() {
		this.document?.removeListener(this.el);
		this.applyStatus();
	}
}

export class DocumentConnectionStatusVisitor extends NoopVisitor<DocumentConnectionStatus> {
	visitFile(
		file: TFile,
		item: ExplorerFileRow,
		storage?: DocumentConnectionStatus,
		vaultShare?: VaultShare,
	): DocumentConnectionStatus | null {
		if (vaultShare) {
			try {
				const vpath = vaultShare.toVirtualPath(file.path);
				const guid = vaultShare.folderIndex.guidFor(vpath);
				if (!guid) return null;
				const document = vaultShare.trackedEntries.get(guid);
				if (!(document instanceof Document)) return null;
				return storage ?? new DocumentConnectionStatus(item.el, document, file);
			} catch {
				// document doesn't exist yet...
				return null;
			}
		}
		storage?.destroy();
		return null;
	}
}
