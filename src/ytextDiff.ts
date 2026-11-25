import * as Y from "yjs";
import { namedLogger } from "./logging";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { currentToggles } from "./featureToggleState";

type DeltaLog = (...args: unknown[]) => void;

/** No-op unless the `enableDeltaLogging` featureKey is on — this path runs on every
 * disk-write reconciliation, so logging is opt-in to avoid flooding debug output. */
function deltaLogger(): DeltaLog {
	if (!currentToggles().enableDeltaLogging) {
		return () => {};
	}
	return namedLogger("[applyDiffToYText]", "debug");
}

/**
 * One handler per diff-match-patch operation code (see `Diff` from the
 * `diff-match-patch` package: 1 insert / 0 equal / -1 delete). Dispatching
 * through this table rather than a switch keeps `applyDiffToYText` itself to a
 * plain loop, and makes each op's cursor arithmetic independently testable
 * in isolation from the transaction plumbing around it.
 */
const DIFF_OP_HANDLERS: Record<
	number,
	(ytext: Y.Text, cursor: number, text: string, log: DeltaLog) => number
> = {
	1: (ytext, cursor, text, log) => {
		log(`Inserting "${text}" at position ${cursor}`);
		ytext.insert(cursor, text);
		return cursor + text.length;
	},
	0: (_ytext, cursor, text, log) => {
		log(`Keeping "${text}" (length: ${text.length})`);
		return cursor + text.length;
	},
	[-1]: (ytext, cursor, text, log) => {
		log(`Deleting "${text}" at position ${cursor}`);
		ytext.delete(cursor, text.length);
		return cursor;
	},
};

export function applyDiffToYText(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: unknown,
): void {
	const ytext = ydoc.getText("contents");
	const currentContent = ytext.toJSON();
	const log = deltaLogger();
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	const dmp = new diff_match_patch();
	const diffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);
	dmp.diff_cleanupSemantic(diffs);
	if (diffs.length === 0) {
		return;
	}

	ydoc.transact(() => {
		let cursor = 0;
		for (const [operation, text] of diffs) {
			const applyOp = DIFF_OP_HANDLERS[operation];
			cursor = applyOp ? applyOp(ytext, cursor, text, log) : cursor;
			log("intermediate", ytext.toJSON());
		}
	}, origin);

	log("result", ytext.toJSON());
	log("Update complete. New content length:", ytext.toJSON().length);
}
