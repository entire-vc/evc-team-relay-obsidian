/** Splits `fullText` into lines, applies `mutate` to the line array, and rejoins. */
function withLines(fullText: string, mutate: (lines: string[]) => void): string {
	const lines = fullText.split("\n");
	mutate(lines);
	return lines.join("\n");
}

/** Inserts `newLine` at `position` (0-indexed line number) in `fullText`. */
export function insertLineAt(args: {
	fullText: string;
	newLine: string;
	position: number;
}): string {
	return withLines(args.fullText, (lines) => {
		lines.splice(args.position, 0, args.newLine);
	});
}

/**
 * Replaces `linesToReplace` lines starting at `position` with `newLine`.
 * An empty `newLine` removes those lines entirely instead of leaving a blank one.
 */
export function replaceLineSpan(args: {
	fullText: string;
	newLine: string;
	position: number;
	linesToReplace: number;
}): string {
	return withLines(args.fullText, (lines) => {
		if (args.newLine === "") {
			lines.splice(args.position, args.linesToReplace);
		} else {
			lines.splice(args.position, args.linesToReplace, args.newLine);
		}
	});
}

/** Removes `count` lines starting at `position`. */
export function removeLineSpan(args: {
	fullText: string;
	position: number;
	count: number;
}): string {
	return withLines(args.fullText, (lines) => {
		lines.splice(args.position, args.count);
	});
}

/**
 * Obsidian collapses a completely empty text node when rendering, which makes
 * an "empty line" diff row invisible and unclickable. Substitute an invisible
 * left-to-right mark (U+200E) so the row still has a hit target.
 */
export function ensureVisibleRowText(text: string): string {
	return text === "" ? "‎" : text;
}
