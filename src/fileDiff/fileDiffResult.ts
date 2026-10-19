import { type StructuredPatch, type StructuredPatchHunk } from "diff";
import { DiffHunk } from "./diffHunk";

/**
 * Turns the `diff` package's `StructuredPatch` (hunks of context/added/removed
 * lines) into a flat list of `DiffHunk`s — one per *contiguous* run of
 * added/removed lines. A hunk can contain several separate changed runs
 * (interspersed with unchanged context lines); the merge UI needs each run
 * addressable on its own so a single action-line's Accept/Discard buttons
 * only ever touch the lines that belong to it.
 */
export class FileDiffResult {
	public readonly leftFileName?: string;
	public readonly rightFileName?: string;
	public readonly hunks: DiffHunk[];

	private constructor(args: {
		leftFileName?: string;
		rightFileName?: string;
		hunks: DiffHunk[];
	}) {
		this.leftFileName = args.leftFileName;
		this.rightFileName = args.rightFileName;
		this.hunks = args.hunks;
	}

	static fromStructuredPatch(parsedDiff: StructuredPatch): FileDiffResult {
		const hunks: DiffHunk[] = [];

		for (const hunk of parsedDiff.hunks) {
			hunks.push(...FileDiffResult.splitHunkIntoRuns(hunk));
		}

		return new FileDiffResult({
			leftFileName: parsedDiff.oldFileName,
			rightFileName: parsedDiff.newFileName,
			hunks,
		});
	}

	/**
	 * Walks one hunk's lines with a cursor into each file (starting at the
	 * hunk's 0-based offset). Context lines ("  ") advance both cursors by
	 * one; a run of "+"/"-" lines becomes a DiffHunk anchored at the
	 * cursors' current position, and only THOSE cursors advance — the left
	 * one by the number of removed lines in the run, the right one by the
	 * number added.
	 */
	private static splitHunkIntoRuns(hunk: StructuredPatchHunk): DiffHunk[] {
		const runs: DiffHunk[] = [];
		let leftCursor = hunk.oldStart - 1;
		let rightCursor = hunk.newStart - 1;

		let i = 0;
		while (i < hunk.lines.length) {
			const line = hunk.lines[i];
			const isChange = line.startsWith("+") || line.startsWith("-");
			if (!isChange) {
				leftCursor += 1;
				rightCursor += 1;
				i += 1;
				continue;
			}

			let end = i;
			while (
				end + 1 < hunk.lines.length &&
				(hunk.lines[end + 1].startsWith("+") || hunk.lines[end + 1].startsWith("-"))
			) {
				end += 1;
			}

			const run = hunk.lines.slice(i, end + 1);
			const leftLines = run.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
			const rightLines = run.filter((l) => l.startsWith("+")).map((l) => l.slice(1));

			runs.push(
				new DiffHunk({
					leftStart: leftCursor,
					rightStart: rightCursor,
					leftLines,
					rightLines,
				}),
			);

			leftCursor += leftLines.length;
			rightCursor += rightLines.length;
			i = end + 1;
		}

		return runs;
	}
}
