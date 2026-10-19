/**
 * Unit tests: uploadClaim
 *
 * The bug this closes: VaultShare.claimPaths() mints a brand-new file's
 * `guid` as a random uuidv4() into `uploadClaims`, a per-DEVICE
 * `VaultScopedMap` — never a Y.Map, never replicated to peers. Two clients
 * racing on the SAME new vpath (e.g. both connecting to a brand-new shared
 * folder that already has matching local files) each mint a DIFFERENT guid
 * before either publishes to the shared `meta` map — two entirely separate
 * relay documents, not a CRDT-mergeable divergence like 's duplicated
 * text. Whichever guid wins the eventual last-writer-wins publish to `meta`
 * becomes canonical; the other client's guid'd Document/CanvasDocument — and
 * whatever content it inserted — becomes an orphan nothing else ever syncs
 * to.
 *
 * These tests use real Y.Doc/Y.Map instances (yjs is the library under
 * test) and simulate two concurrently-connecting clients by exchanging
 * updates via Y.applyUpdate, the same mechanism a real relay WebSocket sync
 * uses — same methodology as initContentClaim.test.ts, generalized to
 * per-vpath keys instead of one fixed key.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	claimVpathIfUnclaimed,
	wonVpathClaim,
	awaitVpathClaimSettled,
} from "../src/uploadClaim";

function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** Exchange full state both ways, simulating both sides having fully synced
 * over the relay (i.e. the settle window elapsing after a concurrent claim). */
function syncBothWays(a: Y.Doc, b: Y.Doc): void {
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

describe("claimVpathIfUnclaimed + wonVpathClaim — single client (no race)", () => {
	test("the only client to claim a vpath wins it", () => {
		const doc = new Y.Doc();

		claimVpathIfUnclaimed(doc, "notes/todo.md");

		expect(wonVpathClaim(doc, "notes/todo.md")).toBe(true);
	});

	test("claiming one vpath doesn't affect another", () => {
		const doc = new Y.Doc();

		claimVpathIfUnclaimed(doc, "a.md");

		expect(wonVpathClaim(doc, "a.md")).toBe(true);
		expect(wonVpathClaim(doc, "b.md")).toBe(false);
	});
});

describe("claimVpathIfUnclaimed + wonVpathClaim — two concurrently-connecting clients", () => {
	test("exactly one of two racing claims on the SAME vpath wins, and both replicas agree on which", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const vpath = "notes/onboarding.md";

		// Both see the vpath as unknown and both claim before either has heard
		// from the other — the exact race from the bug report.
		claimVpathIfUnclaimed(docA, vpath);
		claimVpathIfUnclaimed(docB, vpath);

		syncBothWays(docA, docB);

		const aWon = wonVpathClaim(docA, vpath);
		const bWon = wonVpathClaim(docB, vpath);

		// Never both, never neither.
		expect(aWon).toBe(!bWon);
	});

	test("racing claims on DIFFERENT vpaths at once each converge independently — no cross-vpath interference", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		claimVpathIfUnclaimed(docA, "a.md");
		claimVpathIfUnclaimed(docB, "a.md");
		claimVpathIfUnclaimed(docA, "b.md");
		claimVpathIfUnclaimed(docB, "b.md");

		syncBothWays(docA, docB);

		// Each vpath independently has exactly one winner, and it need not be
		// the same client for both.
		expect(wonVpathClaim(docA, "a.md")).toBe(!wonVpathClaim(docB, "a.md"));
		expect(wonVpathClaim(docA, "b.md")).toBe(!wonVpathClaim(docB, "b.md"));
	});

	test("only the winner proceeds — the loser's own guid is never minted/published for this vpath (simulated via a plain marker)", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const vpath = "notes/race.md";

		claimVpathIfUnclaimed(docA, vpath);
		claimVpathIfUnclaimed(docB, vpath);
		syncBothWays(docA, docB);

		const published: string[] = [];
		for (const [label, doc] of [
			["A", docA],
			["B", docB],
		] as const) {
			if (wonVpathClaim(doc, vpath)) {
				published.push(label);
			}
		}

		expect(published).toHaveLength(1);
	});
});

describe("claimVpathIfUnclaimed — reclaiming a dead claimant's stale claim", () => {
	test("without awareness or a stale TTL, an existing claim survives a genuinely competing client", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();
		const vpath = "notes/x.md";

		claimVpathIfUnclaimed(docA, vpath, undefined, clock.now);
		syncBothWays(docA, docB);

		claimVpathIfUnclaimed(docB, vpath, undefined, clock.now);
		expect(wonVpathClaim(docB, vpath)).toBe(false);
	});

	test("a claim is reclaimed immediately once awareness shows the claimant disconnected", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();
		const vpath = "notes/x.md";

		// A claims, then crashes before ever publishing meta for this vpath.
		claimVpathIfUnclaimed(docA, vpath, undefined, clock.now);
		syncBothWays(docA, docB);
		expect(wonVpathClaim(docB, vpath)).toBe(false);

		const awarenessWithoutA = { getStates: () => new Map<number, unknown>() };

		claimVpathIfUnclaimed(docB, vpath, awarenessWithoutA, clock.now);
		expect(wonVpathClaim(docB, vpath)).toBe(true);
	});

	test("without awareness data, a claim is reclaimed once it's older than the 30s TTL, not before", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();
		const vpath = "notes/x.md";

		claimVpathIfUnclaimed(docA, vpath, undefined, clock.now);
		syncBothWays(docA, docB);

		clock.advance(29_000);
		claimVpathIfUnclaimed(docB, vpath, undefined, clock.now);
		expect(wonVpathClaim(docB, vpath)).toBe(false);

		clock.advance(2_000);
		claimVpathIfUnclaimed(docB, vpath, undefined, clock.now);
		expect(wonVpathClaim(docB, vpath)).toBe(true);
	});

	test("a live claimant (present in awareness, within TTL) is never reclaimed out from under it", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();
		const vpath = "notes/x.md";

		claimVpathIfUnclaimed(docA, vpath, undefined, clock.now);
		syncBothWays(docA, docB);

		const claim = (docA.getMap("uploadClaims").get(vpath) as { clientID: number });
		const awarenessWithA = {
			getStates: () => new Map<number, unknown>([[claim.clientID, {}]]),
		};

		clock.advance(60_000);
		claimVpathIfUnclaimed(docB, vpath, awarenessWithA, clock.now);
		expect(wonVpathClaim(docB, vpath)).toBe(false);
		expect(wonVpathClaim(docA, vpath)).toBe(true);
	});
});

describe("awaitVpathClaimSettled — real quiet-period signal instead of a fixed delay", () => {
	test("no competing claim ever arrives — resolves after one quiet period", async () => {
		const doc = new Y.Doc();
		claimVpathIfUnclaimed(doc, "a.md");
		const clock = fakeClock();
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
		});

		await awaitVpathClaimSettled(doc, "a.md", { sleep, now: clock.now, quietMs: 300 });

		expect(clock.now()).toBe(300);
	});

	test("a competing claim on the SAME vpath mid-wait re-arms the quiet period", async () => {
		const doc = new Y.Doc();
		const otherDoc = new Y.Doc();
		claimVpathIfUnclaimed(doc, "a.md");
		const clock = fakeClock();

		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			if (ticks === 1) {
				claimVpathIfUnclaimed(otherDoc, "a.md");
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(doc)));
			}
		});

		await awaitVpathClaimSettled(doc, "a.md", { sleep, now: clock.now, quietMs: 300 });

		expect(clock.now()).toBe(600);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	test("a competing claim on a DIFFERENT vpath does NOT re-arm this vpath's quiet period", async () => {
		const doc = new Y.Doc();
		const otherDoc = new Y.Doc();
		claimVpathIfUnclaimed(doc, "a.md");
		const clock = fakeClock();

		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			if (ticks === 1) {
				// Unrelated vpath — must not reset a.md's quiet period.
				claimVpathIfUnclaimed(otherDoc, "b.md");
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(doc)));
			}
		});

		await awaitVpathClaimSettled(doc, "a.md", { sleep, now: clock.now, quietMs: 300 });

		expect(clock.now()).toBe(300);
	});

	test("a flapping claim is still bounded by maxWaitMs — never hangs forever", async () => {
		const doc = new Y.Doc();
		let clientID = 1;
		claimVpathIfUnclaimed(doc, "a.md");
		const clock = fakeClock();

		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			doc.getMap("uploadClaims").set("a.md", {
				clientID: ++clientID,
				claimedAt: clock.now(),
			});
		});

		await awaitVpathClaimSettled(doc, "a.md", {
			sleep,
			now: clock.now,
			quietMs: 300,
			maxWaitMs: 1000,
		});

		expect(clock.now()).toBeGreaterThanOrEqual(1000);
	});

	test("waits for the local claim write to flush before watching for a sibling's", async () => {
		const doc = new Y.Doc();
		claimVpathIfUnclaimed(doc, "a.md");
		const clock = fakeClock();
		const socket = { bufferedAmount: 200 };
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			socket.bufferedAmount = Math.max(0, socket.bufferedAmount - 100);
		});

		await awaitVpathClaimSettled(doc, "a.md", { socket, sleep, now: clock.now, quietMs: 50 });

		expect(socket.bufferedAmount).toBe(0);
	});
});
