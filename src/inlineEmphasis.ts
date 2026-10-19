/**
 * renderInlineEmphasis — tiny inline-emphasis transform, not a general markdown parser.
 * `*text*` becomes `<u>text</u>`, `**text**` becomes `<strong>text</strong>`.
 * Single-pass scan: no separate tokenize/parse phases, no token array.
 */
type Mode = "plain" | "underline" | "bold";

export function renderInlineEmphasis(markdown: string): string {
	let out = "";
	let mode: Mode = "plain";
	let i = 0;

	while (i < markdown.length) {
		const isDouble = markdown[i] === "*" && markdown[i + 1] === "*";
		const isSingle = !isDouble && markdown[i] === "*";

		if (isDouble) {
			if (mode === "bold") {
				out += "</strong>";
				mode = "plain";
			} else if (mode === "underline") {
				// Found a bold marker mid-emphasis — close underline, open bold.
				out += "</u><strong>";
				mode = "bold";
			} else {
				out += "<strong>";
				mode = "bold";
			}
			i += 2;
			continue;
		}

		if (isSingle) {
			if (mode === "bold") {
				// A lone star inside a bold run has nowhere to go — keep it literal.
				out += "*";
			} else if (mode === "underline") {
				out += "</u>";
				mode = "plain";
			} else {
				out += "<u>";
				mode = "underline";
			}
			i += 1;
			continue;
		}

		out += markdown[i];
		i += 1;
	}

	// Auto-close whatever run never found its closing marker.
	if (mode === "underline") out += "</u>";
	if (mode === "bold") out += "</strong>";

	return out;
}
