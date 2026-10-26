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
import {
	LostClaimSettler,
	awaitWinnerContent,
	lostClaimAction,
	settleLostClaim,
} from "../src/lostClaimWinner";
import { hasUnsyncedEdit } from "../src/preserveBeforeTrash";

const textEmpty = (text: string) => text === "";

/** A winner doc whose text lands when the test says so, on a fake clock. */
function fakeWinner(initial = "") {
	let text = initial;
	const listeners = new Set<() => void>();
	const timers: { at: number; fn: () => void }[] = [];
	let now = 0;
	return {
		read: () => text,
		isEmpty: textEmpty,
		subscribe: (onChange: () => void) => {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		scheduleTimeout: (fn: () => void, ms: number) => {
			const timer = { at: now + ms, fn };
			timers.push(timer);
			return timer;
		},
		cancelTimeout: (handle: unknown) => {
			timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1);
		},
		/** Remote update: the winner's upload reached the relay. */
		land(next: string) {
			text = next;
			for (const l of [...listeners]) l();
		},
		advance(ms: number) {
			now += ms;
			for (const t of timers.filter((t) => t.at <= now)) {
				timers.splice(timers.indexOf(t), 1);
				t.fn();
			}
		},
		listenerCount: () => listeners.size,
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
	test("resolves on the update that brings the winner's text", async () => {
		const w = fakeWinner();
		let got: string | undefined;
		void awaitWinnerContent({ ...w, maxWaitMs: 60_000 }).then((v) => (got = v));
		w.land("");
		await flush();
		expect(got).toBeUndefined();
		w.land("# doc 234\nbody");
		await flush();
		expect(got).toBe("# doc 234\nbody");
		expect(w.listenerCount()).toBe(0);
	});

	test("gives up at the deadline with the empty placeholder", async () => {
		const w = fakeWinner();
		let got: string | undefined;
		void awaitWinnerContent({ ...w, maxWaitMs: 60_000 }).then((v) => (got = v));
		w.advance(60_000);
		await flush();
		expect(got).toBe("");
		expect(w.listenerCount()).toBe(0);
	});

	test("does not wait when the winner already has content", async () => {
		const w = fakeWinner("x");
		await expect(awaitWinnerContent({ ...w, maxWaitMs: 60_000 })).resolves.toBe("x");
		expect(w.listenerCount()).toBe(0);
	});
});

function settleDeps(
	w: ReturnType<typeof fakeWinner>,
	local: { text: string },
	preserved: string[],
	isAlive: () => boolean = () => true,
) {
	return {
		...w,
		maxWaitMs: 15 * 60_000,
		readLocal: async () => local.text,
		diverged: hasUnsyncedEdit,
		preserveAndAdopt: async (text: string) => {
			preserved.push(text);
		},
		isAlive,
	};
}

describe("settleLostClaim", () => {
	test("an edit made during the wait is what gets preserved", async () => {
		const w = fakeWinner();
		const local = { text: "original" };
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, local, preserved));
		local.text = "original + edit made while waiting";
		w.land("winner's different text");
		await expect(result).resolves.toBe("preserve-and-adopt");
		expect(preserved).toEqual(["original + edit made while waiting"]);
	});

	test("a divergent winner landing long after 10 s is still reconciled", async () => {
		const w = fakeWinner();
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, { text: "ours" }, preserved));
		w.advance(5 * 60_000);
		w.land("theirs");
		await expect(result).resolves.toBe("preserve-and-adopt");
		expect(preserved).toEqual(["ours"]);
	});

	test("a winner identical to the local file leaves no copy", async () => {
		const w = fakeWinner();
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, { text: "# doc 234\nbody" }, preserved));
		w.land("# doc 234\nbody");
		await expect(result).resolves.toBe("keep");
		expect(preserved).toEqual([]);
	});

	test("a winner that never uploads leaves the file alone, no copy", async () => {
		const w = fakeWinner();
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, { text: "ours" }, preserved));
		w.advance(15 * 60_000);
		await expect(result).resolves.toBe("await-winner");
		expect(preserved).toEqual([]);
	});

	test("nothing is written once the share is torn down", async () => {
		const w = fakeWinner();
		let alive = true;
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, { text: "ours" }, preserved, () => alive));
		alive = false;
		w.land("theirs");
		await expect(result).resolves.toBe("gone");
		expect(preserved).toEqual([]);
	});
});

describe("LostClaimSettler", () => {
	test("the next file is not held while a winner's text is pending", async () => {
		const settler = new LostClaimSettler(() => {});
		const winners = [fakeWinner(), fakeWinner()];
		const resolved: string[] = [];
		// adoptLocalFiles: one file after another, each awaited.
		for (const [i, w] of winners.entries()) {
			await Promise.resolve(
				settler.start(`f${i}.md`, () => settleLostClaim(settleDeps(w, { text: "ours" }, []))),
			);
			resolved.push(`f${i}.md`);
		}
		expect(resolved).toEqual(["f0.md", "f1.md"]);
		expect(settler.isPending("f0.md")).toBe(true);
		expect(settler.isPending("f1.md")).toBe(true);
		winners[1].land("theirs");
		await flush();
		expect(settler.isPending("f1.md")).toBe(false);
		expect(settler.isPending("f0.md")).toBe(true);
	});

	test("runs at most one settle per file", () => {
		const settler = new LostClaimSettler(() => {});
		const never = () => new Promise<void>(() => {});
		expect(settler.start("a.md", never)).toBe(true);
		expect(settler.start("a.md", never)).toBe(false);
	});

	test("a failing settle is reported and frees the file", async () => {
		const errors: string[] = [];
		const settler = new LostClaimSettler((key) => errors.push(key));
		settler.start("a.md", async () => {
			throw new Error("boom");
		});
		await flush();
		expect(errors).toEqual(["a.md"]);
		expect(settler.isPending("a.md")).toBe(false);
	});
});
