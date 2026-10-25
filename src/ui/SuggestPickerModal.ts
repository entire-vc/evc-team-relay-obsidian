import { App, Modal } from "obsidian";
import type { Component } from "svelte";
import { mountComponent, type MountedComponent } from "../svelteMount";

/**
 * The suggest component must accept `focusOnMount` and `onChoose` on top of
 * whatever else it declares (`P`) -- those two are supplied by this modal,
 * not by the caller (see `mountProps` below).
 */
type SuggestProps<T, P> = P & {
	focusOnMount?: boolean;
	onChoose?: (item: T) => void;
};

export class SuggestPickerModal<T, P extends Record<string, unknown>> extends Modal {
	private mountedComponent?: MountedComponent<SuggestProps<T, P>>;

	constructor(
		app: App,
		private pickerComponent: Component<SuggestProps<T, P>>,
		private mountProps: P,
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
		this.mountedComponent = mountComponent(this.pickerComponent, {
			target: this.resolveHost(),
			props: {
				...this.mountProps,
				focusOnMount: true,
				onChoose: (item: T) => {
					this.onPick(item);
					this.close();
				},
			},
		});
	}

	onClose(): void {
		this.mountedComponent?.destroy();
	}

	dismantle(): void {
		this.pickerComponent = null as unknown as Component<SuggestProps<T, P>>;
		this.mountProps = null as unknown as P;
		this.onPick = null as unknown as (item: T) => void;
	}
}
