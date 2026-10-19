// Code in this file has been adapted from y-codemirror.next
// LicenseRecord
// [The MIT LicenseRecord](./LICENSE) © Kevin Jahns

import * as Y from "yjs";

/**
 * Defines a range on text using relative positions that can be transformed back to
 * absolute positions. (https://docs.yjs.dev/api/relative-positions)
 */

export class YRange {
	yanchor: Y.RelativePosition;
	yhead: Y.RelativePosition;

	constructor(yanchor: Y.RelativePosition, yhead: Y.RelativePosition) {
		this.yanchor = yanchor;
		this.yhead = yhead;
	}

	toJSON(): unknown {
		return {
			yanchor: Y.relativePositionToJSON(this.yanchor) as unknown,
			yhead: Y.relativePositionToJSON(this.yhead) as unknown,
		};
	}

	static fromJSON(json: unknown): YRange {
		const j = json as { yanchor: unknown; yhead: unknown };
		return new YRange(
			Y.createRelativePositionFromJSON(j.yanchor),
			Y.createRelativePositionFromJSON(j.yhead),
		);
	}
}
