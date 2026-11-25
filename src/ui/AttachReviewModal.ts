/**
 * The attach check's UI (GH #114): progress while notes are
 * compared, the choice dialog when any differ, and the persistent notice
 * with "Review" when the folder was attached by the startup auto-connect.
 * The logic lives in attachReview.ts and VaultShare.runAttachReview(); this
 * file only renders and reports the choice.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type { AttachReviewUi, VaultShare } from "../VaultShare";
import type { AttachChoice, AttachEntryPoint, AttachReviewModel } from "../attachReview";
import { ATTACH_SUMMARY_NOTICE_MS } from "../attachConflictSummary";
import { confirmDialog } from "./dialogs";
import { uiText } from "../wording/uiText";

export type AttachDecision = AttachChoice | "cancel";

export function attachReviewTitle(model: Pick<AttachReviewModel, "count">): string {
	return model.count === 1
		? uiText("attachReview.titleOne")
		: uiText("attachReview.titleMany", { count: model.count });
}

/** The list the dialog shows: the first paths and "+K more". */
export function attachReviewListItems(model: Pick<AttachReviewModel, "paths" | "more">): string[] {
	return model.more > 0
		? [...model.paths, uiText("attachReview.moreFiles", { count: model.more })]
		: [...model.paths];
}

export class AttachReviewModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private readonly model: AttachReviewModel,
		private readonly onDecision: (decision: AttachDecision) => void,
	) {
		super(app);
		this.setTitle(attachReviewTitle(model));
	}

	onOpen(): void {
		const { contentEl, model } = this;
		contentEl.empty();
		contentEl.addClass("evc-attach-review");

		contentEl.createEl("p", { text: uiText("attachReview.intro", { folder: model.folderName }) });
		const list = contentEl.createEl("ul", { cls: "evc-attach-review-list" });
		for (const item of attachReviewListItems(model)) list.createEl("li", { text: item });

		new Setting(contentEl)
			.setName(uiText("attachReview.keepBoth.name"))
			.setDesc(uiText("attachReview.keepBoth.desc"))
			.addButton((btn) =>
				btn
					.setButtonText(uiText("attachReview.keepBoth.button"))
					.setCta()
					.onClick(() => this.decide("keep-both")),
			);

		new Setting(contentEl)
			.setName(uiText("attachReview.keepServer.name"))
			.setDesc(uiText("attachReview.keepServer.desc", { backup: model.backupFolder }))
			.addButton((btn) =>
				btn
					.setButtonText(uiText("attachReview.keepServer.button"))
					.onClick(() => this.decide("keep-server")),
			);

		new Setting(contentEl)
			.setName(uiText("attachReview.keepLocal.name"))
			.setDesc(
				model.canKeepLocal
					? uiText("attachReview.keepLocal.desc", { backup: model.backupFolder })
					: uiText("attachReview.keepLocal.noWriteDesc"),
			)
			.addButton((btn) => {
				btn.setButtonText(uiText("attachReview.keepLocal.button")).setWarning();
				btn.setDisabled(!model.canKeepLocal);
				btn.onClick(() => void this.confirmKeepLocal());
			});

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(uiText("attachReview.cancelButton")).onClick(() => this.decide("cancel")),
		);
	}

	private async confirmKeepLocal(): Promise<void> {
		if (!this.model.canKeepLocal) return;
		const message =
			this.model.count === 1
				? uiText("attachReview.keepLocal.confirmOne", { backup: this.model.backupFolder })
				: uiText("attachReview.keepLocal.confirmMany", {
						count: this.model.count,
						backup: this.model.backupFolder,
					});
		if (await confirmDialog(this.app, message)) this.decide("keep-local");
	}

	private decide(decision: AttachDecision): void {
		if (this.decided) return;
		this.decided = true;
		this.close();
		this.onDecision(decision);
	}

	onClose(): void {
		this.contentEl.empty();
		// Esc or the close button: the attach is cancelled (spec: Cancel / Esc).
		if (!this.decided) {
			this.decided = true;
			this.onDecision("cancel");
		}
	}
}

interface PendingReview {
	share: VaultShare;
	open(): void;
}

/**
 * The AttachReviewUi main.ts registers. One notice per held folder, reused
 * for progress, the offline message and the "Review" prompt.
 */
export class AttachReviewPresenter implements AttachReviewUi {
	private readonly notices = new Map<VaultShare, Notice>();
	private readonly pending = new Map<VaultShare, PendingReview>();

	constructor(
		private readonly app: App,
		private readonly onCancelled: (share: VaultShare, entry: AttachEntryPoint) => void,
	) {}

	progress(share: VaultShare, done: number, total: number, cancel: () => void): void {
		const message = createFragment((frag) => {
			frag.createSpan({
				text: uiText("attachReview.progressNotice", { folder: folderLabel(share), done, total }),
			});
			const button = frag.createEl("button", {
				text: uiText("attachReview.progressCancel"),
				cls: "evc-attach-review-notice-button",
			});
			button.addEventListener("click", () => cancel());
		});
		this.show(share, message);
	}

	offline(share: VaultShare): void {
		this.show(share, uiText("attachReview.offlineNotice", { folder: folderLabel(share) }));
	}

	decide(share: VaultShare, model: AttachReviewModel, entry: AttachEntryPoint): Promise<AttachDecision> {
		return new Promise((resolve) => {
			const open = () => {
				this.pending.delete(share);
				this.hide(share);
				new AttachReviewModal(this.app, model, resolve).open();
			};
			if (entry === "manual") {
				open();
				return;
			}
			this.pending.set(share, { share, open });
			const message = createFragment((frag) => {
				frag.createSpan({
					text:
						model.count === 1
							? uiText("attachReview.reviewNoticeOne", { folder: model.folderName })
							: uiText("attachReview.reviewNoticeMany", {
									folder: model.folderName,
									count: model.count,
								}),
				});
				const button = frag.createEl("button", {
					text: uiText("attachReview.reviewButton"),
					cls: "evc-attach-review-notice-button",
				});
				button.addEventListener("click", open);
			});
			this.show(share, message);
		});
	}

	finished(share: VaultShare, summary: string | null): void {
		this.pending.delete(share);
		this.hide(share);
		if (summary) new Notice(summary, ATTACH_SUMMARY_NOTICE_MS);
	}

	cancelled(share: VaultShare, entry: AttachEntryPoint): void {
		this.onCancelled(share, entry);
	}

	/** Reopens a review whose notice was dismissed (command palette). */
	reviewPending(): boolean {
		const next = this.pending.values().next();
		if (next.done) return false;
		next.value.open();
		return true;
	}

	hideAll(): void {
		for (const notice of this.notices.values()) notice.hide();
		this.notices.clear();
		this.pending.clear();
	}

	private show(share: VaultShare, message: string | DocumentFragment): void {
		const existing = this.notices.get(share);
		if (existing?.noticeEl?.isConnected) {
			existing.setMessage(message);
			return;
		}
		this.notices.set(share, new Notice(message, 0));
	}

	private hide(share: VaultShare): void {
		this.notices.get(share)?.hide();
		this.notices.delete(share);
	}
}

function folderLabel(share: VaultShare): string {
	return share.path.split("/").pop() || share.path || "/";
}
