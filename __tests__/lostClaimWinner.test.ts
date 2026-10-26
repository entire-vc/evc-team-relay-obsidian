/**
 * Unit tests: lostClaimWinner
 *
 * Two clients receive the same new file from the server's files index and
 * both try to publish it. The loser's local file is identical to what the
 * winner will upload, but the winner's document can sync in with its text
 * still pending. Comparing against that empty placeholder used to save an
 * "upload race" copy that matched the original, and the copy then synced to
 * every member.
 */

import { describe, test, expect } from "@jest/globals";
import { awaitWinnerContent, lostClaimAction } from "../src/lostClaimWinner";
import { hasUnsyncedEdit } from "../src/preserveBeforeTrash";

const textEmpty = (text: string) => text === "";

function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

describe("lostClaimAction", () => {
	test("winner's text not uploaded yet is not a conflict", () => {
		expect(lostClaimAction("# doc 234\nbody", "", hasUnsyncedEdit, textEmpty)).toBe(
			"await-winner",
		);
	});

	test("identical content needs nothing", () => {
		expect(
			lostClaimAction("# doc 234\nbody", "# doc 234\nbody", hasUnsyncedEdit, textEmpty),
		).toBe("keep");
	});

	test("real, different winner content is still preserved and adopted", () => {
		expect(lostClaimAction("ours", "theirs", hasUnsyncedEdit, textEmpty)).toBe(
			"preserve-and-adopt",
		);
	});

	test("an empty local file still adopts the winner", () => {
		expect(lostClaimAction("", "theirs", hasUnsyncedEdit, textEmpty)).toBe("preserve-and-adopt");
		expect(lostClaimAction("", "", hasUnsyncedEdit, textEmpty)).toBe("keep");
	});
});

describe("awaitWinnerContent", () => {
	test("returns the winner's text once it lands", async () => {
		const clock = fakeClock();
		let reads = 0;
		const winner = await awaitWinnerContent(
			() => (++reads >= 3 ? "# doc 234\nbody" : ""),
			textEmpty,
			{ maxWaitMs: 10_000, pollMs: 250, ...clock },
		);
		expect(winner).toBe("# doc 234\nbody");
		expect(clock.now()).toBe(500);
	});

	test("gives up at the deadline and returns the empty placeholder", async () => {
		const clock = fakeClock();
		const winner = await awaitWinnerContent(() => "", textEmpty, {
			maxWaitMs: 1_000,
			pollMs: 250,
			...clock,
		});
		expect(winner).toBe("");
		expect(clock.now()).toBe(1_000);
	});

	test("does not wait when the winner already has content", async () => {
		const clock = fakeClock();
		await awaitWinnerContent(() => "x", textEmpty, clock);
		expect(clock.now()).toBe(0);
	});
});
