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

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	LostClaimSettler,
	awaitWinnerContent,
	lostClaimAction,
	preserveThenAdopt,
	settleLostClaim,
} from "../src/lostClaimWinner";
import { hasUnsyncedEdit } from "../src/preserveBeforeTrash";

const textEmpty = (text: string) => text === "";

/** The loser's live copy of the winner's doc; its text lands on `land()`. */
function winnerDoc() {
	const doc = new Y.Doc();
	const text = doc.getText("contents");
	let listeners = 0;
	return {
		doc,
		read: () => text.toString(),
		isEmpty: textEmpty,
		// Same wiring as VaultShare._reconcileLostUploadClaim.
		subscribe: (onChange: () => void, onGone: () => void) => {
			doc.on("update", onChange);
			doc.on("destroy", onGone);
			listeners++;
			return () => {
				doc.off("update", onChange);
				doc.off("destroy", onGone);
				listeners--;
			};
		},
		/** Remote update: the winner's upload reached the relay. */
		land(next: string) {
			text.insert(0, next);
		},
		listenerCount: () => listeners,
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
		const w = winnerDoc();
		let got: string | undefined;
		void awaitWinnerContent({ ...w, signal: new AbortController().signal }).then(
			(v) => (got = v),
		);
		w.doc.getMap("meta").set("touched", true);
		await flush();
		expect(got).toBeUndefined();
		w.land("# doc 234\nbody");
		await flush();
		expect(got).toBe("# doc 234\nbody");
		expect(w.listenerCount()).toBe(0);
	});

	test("does not wait when the winner already has content", async () => {
		const w = winnerDoc();
		w.land("x");
		await expect(
			awaitWinnerContent({ ...w, signal: new AbortController().signal }),
		).resolves.toBe("x");
		expect(w.listenerCount()).toBe(0);
	});

	test("ends with nothing when the share is torn down", async () => {
		const w = winnerDoc();
		const controller = new AbortController();
		const result = awaitWinnerContent({ ...w, signal: controller.signal });
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		expect(w.listenerCount()).toBe(0);
	});

	test("ends with nothing when the doc is destroyed", async () => {
		const w = winnerDoc();
		const result = awaitWinnerContent({ ...w, signal: new AbortController().signal });
		w.doc.destroy();
		await expect(result).resolves.toBeUndefined();
		expect(w.listenerCount()).toBe(0);
	});
});

function settleDeps(
	w: ReturnType<typeof winnerDoc>,
	local: { text: string },
	preserved: string[],
	signal = new AbortController().signal,
	isAlive: () => boolean = () => true,
) {
	return {
		...w,
		signal,
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
		const w = winnerDoc();
		const local = { text: "original" };
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, local, preserved));
		local.text = "original + edit made while waiting";
		w.land("winner's different text");
		await expect(result).resolves.toBe("preserve-and-adopt");
		expect(preserved).toEqual(["original + edit made while waiting"]);
	});

	test("a divergent winner landing late is still reconciled: no deadline", async () => {
		jest.useFakeTimers();
		try {
			const w = winnerDoc();
			const preserved: string[] = [];
			let settled = false;
			const result = settleLostClaim(settleDeps(w, { text: "ours" }, preserved)).then((a) => {
				settled = true;
				return a;
			});
			// Well past the old 10 s and any upload backlog: still waiting.
			jest.advanceTimersByTime(24 * 60 * 60_000);
			await Promise.resolve();
			expect(settled).toBe(false);
			w.land("theirs");
			await expect(result).resolves.toBe("preserve-and-adopt");
			expect(preserved).toEqual(["ours"]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a winner identical to the local file leaves no copy", async () => {
		const w = winnerDoc();
		const preserved: string[] = [];
		const result = settleLostClaim(settleDeps(w, { text: "# doc 234\nbody" }, preserved));
		w.land("# doc 234\nbody");
		await expect(result).resolves.toBe("keep");
		expect(preserved).toEqual([]);
	});

	test("nothing is written once the share is torn down", async () => {
		const w = winnerDoc();
		const controller = new AbortController();
		const preserved: string[] = [];
		const result = settleLostClaim(
			settleDeps(w, { text: "ours" }, preserved, controller.signal),
		);
		controller.abort();
		w.land("theirs");
		await expect(result).resolves.toBe("gone");
		expect(preserved).toEqual([]);
	});

	test("nothing is written when the entry dies as the text lands", async () => {
		const w = winnerDoc();
		let alive = true;
		const preserved: string[] = [];
		const result = settleLostClaim(
			settleDeps(w, { text: "ours" }, preserved, undefined, () => alive),
		);
		alive = false;
		w.land("theirs");
		await expect(result).resolves.toBe("gone");
		expect(preserved).toEqual([]);
	});
});

describe("preserveThenAdopt", () => {
	test("writes the copy, then the original", async () => {
		const writes: string[] = [];
		const path = await preserveThenAdopt({
			writeCopy: async () => {
				writes.push("copy");
				return "a (upload race).md";
			},
			writeOriginal: async () => {
				writes.push("original");
			},
			isAlive: () => true,
		});
		expect(path).toBe("a (upload race).md");
		expect(writes).toEqual(["copy", "original"]);
	});

	test("torn down while the copy is written: the original is not touched", async () => {
		let alive = true;
		const writes: string[] = [];
		const path = await preserveThenAdopt({
			writeCopy: async () => {
				writes.push("copy");
				alive = false;
				return "a (upload race).md";
			},
			writeOriginal: async () => {
				writes.push("original");
			},
			isAlive: () => alive,
		});
		expect(path).toBeUndefined();
		expect(writes).toEqual(["copy"]);
	});
});

describe("LostClaimSettler", () => {
	function startAll(settler: LostClaimSettler, winners: ReturnType<typeof winnerDoc>[]) {
		const results: Promise<unknown>[] = [];
		for (const [i, w] of winners.entries()) {
			settler.start(`f${i}.md`, (signal) => {
				const r = settleLostClaim(settleDeps(w, { text: "ours" }, [], signal));
				results.push(r);
				return r;
			});
		}
		return results;
	}

	test("the next file is not held while a winner's text is pending", async () => {
		const settler = new LostClaimSettler(() => {});
		const winners = [winnerDoc(), winnerDoc()];
		const resolved: string[] = [];
		// adoptLocalFiles: one file after another, each awaited.
		for (const [i, w] of winners.entries()) {
			await Promise.resolve(
				settler.start(`f${i}.md`, (signal) =>
					settleLostClaim(settleDeps(w, { text: "ours" }, [], signal)),
				),
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

	test("cancelAll ends every waiting settle and drops its listeners", async () => {
		const settler = new LostClaimSettler(() => {});
		const winners = [winnerDoc(), winnerDoc()];
		const results = startAll(settler, winners);
		settler.cancelAll();
		await expect(Promise.all(results)).resolves.toEqual(["gone", "gone"]);
		expect(winners.map((w) => w.listenerCount())).toEqual([0, 0]);
		expect(settler.isPending("f0.md")).toBe(false);
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
