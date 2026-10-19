"use strict";

import * as random from "lib0/random";

interface PresenceColor {
	color: string;
	light: string;
}

// [primary, 20%-alpha] pairs — kept flat so the palette matches the design
// spec by inspection instead of deriving the alpha value at runtime.
const PALETTE: ReadonlyArray<readonly [string, string]> = [
	["#30bced", "#30bced33"],
	["#6eeb83", "#6eeb8333"],
	["#ffbc42", "#ffbc4233"],
	["#ecd444", "#ecd44433"],
	["#ee6352", "#ee635233"],
	["#9ac2c9", "#9ac2c933"],
	["#8acb88", "#8acb8833"],
	["#1be7ff", "#1be7ff33"],
];

export const presencePalette: PresenceColor[] = PALETTE.map(([color, light]) => ({
	color,
	light,
}));

function pickColor(): PresenceColor {
	return presencePalette[random.uint32() % presencePalette.length];
}

export class Account {
	presenceColor: PresenceColor;

	constructor(
		public accountId: string,
		public fullName: string,
		public emailAddress: string,
		public avatarUrl: string,
		public authToken: string,
	) {
		this.presenceColor = pickColor();
	}
}
