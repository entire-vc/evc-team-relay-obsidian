/**
 * A single clickable action ("Accept incoming", "Keep local", ...) rendered
 * inside a diff action-line. Deliberately dumb: it owns no state, it just
 * renders `text` as a link and wires `onClick` to it.
 */
export class HunkActionButton {
	public label: string;
	public onActivate: (e: MouseEvent) => void;

	constructor(args: { label: string; onActivate: (e: MouseEvent) => void }) {
		this.label = args.label;
		this.onActivate = args.onActivate;
	}

	renderInto(actionLine: HTMLDivElement): void {
		const link = actionLine.createEl("a", {
			text: this.label,
			cls: "no-decoration text-xxs evc-file-diff__action-line",
		});
		link.onClickEvent(this.onActivate);
	}
}
