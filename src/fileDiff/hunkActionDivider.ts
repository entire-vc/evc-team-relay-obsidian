/** A thin "|" separator between two ActionLineButtons on the same action line. */
export class HunkActionDivider {
	static build(actionLine: HTMLDivElement): void {
		actionLine.createSpan({
			text: "|",
			cls: "text-xxs evc-file-diff__action-line",
		});
	}
}
