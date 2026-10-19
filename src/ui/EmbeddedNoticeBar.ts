"use strict";

const BOX_CLASS = "evc-relay-banner-box";
const BANNER_CLASS = "evc-relay-banner";
const HOST_CLASS = "has-evc-relay-banner";

export class EmbeddedNoticeBar {
	message: string;
	onActivate: () => Promise<boolean>;

	constructor(
		private hostEl: Element | null,
		private anchorEl: Element | null,
		message: string,
		onActivate: () => Promise<boolean>,
	) {
		this.message = message;
		this.onActivate = onActivate;
		this.show();
	}

	private mount(hostEl: Element): Element {
		let box = hostEl.querySelector(`.${BOX_CLASS}`);
		if (box) return box;

		box = createDiv({ cls: BOX_CLASS });
		hostEl.insertBefore(box, this.anchorEl);
		hostEl.classList.add(HOST_CLASS);
		return box;
	}

	show(): boolean {
		const hostEl = this.hostEl;
		if (!hostEl || !this.anchorEl) return true;

		const box = this.mount(hostEl);
		if (box.querySelector(`.${BANNER_CLASS}`)) return true;

		const banner = createDiv({ cls: BANNER_CLASS });
		banner.createSpan().setText(this.message);
		banner.addEventListener("click", () => {
			void this.onActivate().then((shouldDestroy) => {
				if (shouldDestroy) this.destroy();
			});
		});
		box.appendChild(banner);
		return true;
	}

	destroy(): boolean {
		const hostEl = this.hostEl;
		if (!hostEl) return true;

		hostEl.querySelector(`.${BOX_CLASS}`)?.replaceChildren();
		hostEl.classList.remove(HOST_CLASS);
		return true;
	}
}
