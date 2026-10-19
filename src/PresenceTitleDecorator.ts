import { Loggable } from "./logging";
import { MarkdownView } from "obsidian";
import { Document } from "./Document";
import { type DocumentViewBinding } from "./ViewBindings";
import CollaboratorAwareness from "./components/CollaboratorAwareness.svelte";

const WRAPPER_CLASS = "title-with-awareness";

/**
 * Splice a wrapper `<div>` in around the note's inline-title element and
 * return an (always-created) sibling container for the awareness avatars, or
 * `null` if there's no inline-title element to anchor to at all.
 *
 * NB: the wrapper/avatar-container elements are still built and returned
 * even if `inlineTitle` unexpectedly has no `parentNode` to splice into —
 * matching the pre-rewrite shape, which only bailed on a missing
 * inline-title, not a detached one. In practice `inlineTitle` is found via
 * `containerEl.querySelector`, so it's always attached and this is dead.
 */
function wrapInlineTitle(containerEl: HTMLElement): HTMLElement | null {
	const inlineTitle = containerEl.querySelector<HTMLElement>(".inline-title");
	if (!inlineTitle) {
		return null;
	}

	const wrapper = createDiv({
		cls: [WRAPPER_CLASS, "evc-flex", "evc-align-center", "evc-justify-between", "evc-w-full"],
	});

	const avatarContainer = createDiv({ cls: "evc-user-awareness-container" });

	if (inlineTitle.parentNode) {
		inlineTitle.parentNode.insertBefore(wrapper, inlineTitle);
		wrapper.appendChild(inlineTitle);
		wrapper.appendChild(avatarContainer);
	}

	return avatarContainer;
}

/** Undo wrapInlineTitle(): pull the inline-title back out and drop the wrapper. */
function unwrapInlineTitle(avatarContainer: HTMLElement): void {
	const wrapper = avatarContainer.parentElement;
	if (wrapper?.className !== WRAPPER_CLASS) {
		avatarContainer.remove();
		return;
	}
	// NB: if the wrapper's there but the inline-title isn't found inside it
	// (foreign DOM mutation), neither side is torn down here — matches the
	// pre-rewrite behavior, which also silently no-ops in that case rather
	// than removing a wrapper that might still be load-bearing.
	const inlineTitle = wrapper.querySelector(".inline-title");
	if (inlineTitle && wrapper.parentNode) {
		wrapper.parentNode.insertBefore(inlineTitle, wrapper);
		wrapper.remove();
	}
}

export class PresenceTitleDecorator extends Loggable {
	documentBinding: DocumentViewBinding<MarkdownView>;
	liveDocument: Document;
	private dismantled = false;
	private avatarsComponent?: CollaboratorAwareness;
	private avatarsContainerEl?: HTMLElement;

	constructor(view: DocumentViewBinding<MarkdownView>) {
		super();
		this.documentBinding = view;
		this.liveDocument = view.boundDocument;
		this.setLoggers(`[AwarenessView](${this.liveDocument.entryPath})`);
		void this.attachAwareness();
	}

	private async attachAwareness() {
		if (!this.documentBinding || this.dismantled) return;

		this.log("Installing awareness component for", this.documentBinding.hostView.file?.path);

		// Wait for the document to be ready
		await this.liveDocument.awaitFullyConnected();
		if (this.dismantled) return;

		// Set up the awareness component immediately - it will handle connection states
		this.setupAwarenessComponent();
	}

	private setupAwarenessComponent() {
		if (!this.documentBinding.hostView.containerEl || this.dismantled) return;

		const avatarContainer = wrapInlineTitle(this.documentBinding.hostView.containerEl);
		if (!avatarContainer) {
			this.warn("Could not find inline-title element to position awareness component");
			return;
		}
		this.avatarsContainerEl = avatarContainer;

		const awareness = this.liveDocument._liveProvider?.awareness;
		if (!awareness) {
			this.warn("No awareness provider available");
			return;
		}

		try {
			this.avatarsComponent = new CollaboratorAwareness({
				target: avatarContainer,
				props: {
					collabAwareness: awareness,
				},
			});
			this.log("Awareness component successfully mounted");
		} catch (error: unknown) {
			this.warn("Failed to create awareness component:", error);
		}
	}

	private teardownAwarenessComponent(): void {
		if (!this.avatarsComponent) return;
		try {
			this.avatarsComponent.$destroy();
			this.avatarsComponent = undefined;
			this.log("Awareness component destroyed");
		} catch (error: unknown) {
			this.warn("Error destroying awareness component:", error);
		}
	}

	dismantle() {
		this.dismantled = true;

		this.teardownAwarenessComponent();

		if (this.avatarsContainerEl) {
			unwrapInlineTitle(this.avatarsContainerEl);
			this.avatarsContainerEl = undefined;
		}

		this.documentBinding = null as unknown as DocumentViewBinding<MarkdownView>;
		this.liveDocument = null as unknown as Document;
	}
}
