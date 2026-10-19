import { App, Modal } from "obsidian";
import type { ComponentProps, ComponentType, SvelteComponent } from "svelte";

/**
 * The suggest component must accept `focusOnMount` and `onChoose` on top of
 * whatever else it declares -- those two are supplied by this modal, not by
 * the caller (see `mountProps` below).
 */
type SuggestComponent<T> = SvelteComponent<{
	focusOnMount?: boolean;
	onChoose?: (item: T) => void;
}>;

export class SuggestPickerModal<T, C extends SuggestComponent<T>> extends Modal {
	private mountedComponent?: C;

	constructor(
		app: App,
		private componentCtor: ComponentType<C>,
		private mountProps: Omit<ComponentProps<C>, "focusOnMount" | "onChoose">,
		private onPick: (item: T) => void,
	) {
		super(app);
	}

	private resolveHost(): Element {
		// The Svelte suggest component draws its own modal chrome, so hide
		// Obsidian's default wrapper and mount into its container instead
		// (falling back to modalEl itself if there's no wrapper to find).
		this.modalEl.addClass("evc-hidden");
		return this.modalEl.closest(".modal-container") ?? this.modalEl;
	}

	onOpen(): void {
		this.mountedComponent = new this.componentCtor({
			target: this.resolveHost(),
			props: {
				...this.mountProps,
				focusOnMount: true,
				onChoose: (item: T) => {
					this.onPick(item);
					this.close();
				},
			} as ComponentProps<C>,
		});
	}

	onClose(): void {
		this.mountedComponent?.$destroy();
	}

	dismantle(): void {
		this.componentCtor = null as unknown as ComponentType<C>;
		this.mountProps = null as unknown as Omit<ComponentProps<C>, "focusOnMount" | "onChoose">;
		this.onPick = null as unknown as (item: T) => void;
	}
}
