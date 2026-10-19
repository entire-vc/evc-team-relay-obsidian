/**
 * One contiguous block of lines that differ between two versions of a file,
 * expressed as a pair of line ranges (start offset + the lines themselves)
 * rather than a patch string — the diff view renders each side directly from
 * `leftLines`/`rightLines` and needs the starting line number to compute
 * where an accept/reject edit should be spliced back into the full text.
 */
export class DiffHunk {
	public readonly leftStart: number;
	public readonly rightStart: number;
	public readonly leftLines: string[];
	public readonly rightLines: string[];

	constructor(args: {
		leftStart: number;
		rightStart: number;
		leftLines: string[];
		rightLines: string[];
	}) {
		this.leftStart = args.leftStart;
		this.rightStart = args.rightStart;
		this.leftLines = args.leftLines;
		this.rightLines = args.rightLines;
	}
}
