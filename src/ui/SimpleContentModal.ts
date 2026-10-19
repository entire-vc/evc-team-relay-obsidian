import { App, Modal } from "obsidian";

type MountedComponent = { $destroy: () => void };

interface SvelteContentConstructor<P> {
	new (options: { target: Element; props: P }): MountedComponent;
}

/**
 * Base for modals whose entire body is one Svelte component with a fixed
 * props object -- mount on open, destroy on close, nothing else. Several
 * plugin modals (Debug, BugReport, IndexedDBAnalysis, ...) were independent
 * copies of exactly this shape; this collects the shared mount/destroy
 * lifecycle so each subclass is just its content component + props.
 */
export abstract class SimpleContentModal<P> extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private readonly ContentComponent: SvelteContentConstructor<P>,
		private readonly props: P,
	) {
		super(app);
	}

	onOpen(): void {
		this.component = new this.ContentComponent({
			target: this.contentEl,
			props: this.props,
		});
	}

	onClose(): void {
		this.component?.$destroy();
		this.contentEl.empty();
	}
}
