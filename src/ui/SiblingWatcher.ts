// Watches a DOM node's parent for a mutation that gives the node a next
// sibling, then fires a one-shot callback and stops observing. Used by the
// folder-tree decorations below: Obsidian's file-explorer sometimes inserts
// a folder row's "collapse indicator" sibling asynchronously, after the row
// itself is created, so a decoration that needs to sit next to it has to
// wait for that sibling to show up.
export class SiblingAppearanceObserver {
	private observer: MutationObserver | null;

	constructor(
		private readonly el: HTMLElement,
		private readonly onSiblingAppears: (el: HTMLElement) => void,
	) {
		this.observer = new MutationObserver((mutations, observer) => {
			for (const mutation of mutations) {
				if (mutation.type !== "childList") continue;
				if (!el.nextSibling) continue;
				onSiblingAppears(el);
				observer.disconnect();
				break;
			}
		});
		this.observer.observe(el.parentElement as HTMLElement, {
			childList: true,
			subtree: true,
		});
	}

	destroy() {
		this.observer?.disconnect();
		this.observer = null;
	}
}
