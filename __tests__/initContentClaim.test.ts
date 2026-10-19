/**
 * Unit tests: initContentClaim
 *
 * The bug: uploadDocumentViaSocket inserted the local file's content into a
 * brand-new (empty) Y.Text unconditionally whenever the relay had nothing
 * yet. Two clients opening the same newly-shared folder for the first time
 * both observe an empty Y.Text and both insert — Yjs merges the two inserts
 * as contiguous blocks (duplicated text), since neither has a causal link to
 * the other.
 *
 * These tests use real Y.Doc/Y.Map instances (yjs is the library under test,
 * mocking it would test nothing) and simulate two concurrently-connecting
 * clients by exchanging updates via Y.applyUpdate, the same mechanism a real
 * relay WebSocket sync uses.
 *
 * Two more scenarios:
 * TTL/awareness-based reclaim of a claim whose winner died before finishing
 * (previously pinned the doc unseeded forever), and awaitClaimSettled's
 * quiet-period real signal replacing the old fixed 1000ms delay.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	claimInitIfUnclaimed,
	wonInitClaim,
	markInitDone,
	awaitClaimSettled,
} from "../src/initContentClaim";

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

describe("claimInitIfUnclaimed + wonInitClaim — single client (no race)", () => {
	test("the only client to claim wins and may insert", () => {
		const doc = new Y.Doc();
		const text = doc.getText("contents");

		claimInitIfUnclaimed(doc);

		expect(wonInitClaim(doc, text)).toBe(true);
	});

	test("after inserting and marking done, wonInitClaim is false (no double-insert on retry)", () => {
		const doc = new Y.Doc();
		const text = doc.getText("contents");

		claimInitIfUnclaimed(doc);
		expect(wonInitClaim(doc, text)).toBe(true);
		text.insert(0, "hello world");
		markInitDone(doc);

		// A later re-entry (e.g. a retried sync pass) must not re-claim/re-insert.
		claimInitIfUnclaimed(doc);
		expect(wonInitClaim(doc, text)).toBe(false);
		expect(text.toJSON()).toBe("hello world");
	});
});

describe("claimInitIfUnclaimed + wonInitClaim — two concurrently-connecting clients", () => {
	test("exactly one of two racing claims wins, and both replicas agree on which", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// Both see an empty doc and both claim before either has heard from the
		// other — the exact race from the bug report.
		claimInitIfUnclaimed(docA);
		claimInitIfUnclaimed(docB);

		// Settle window elapses; the relay has now propagated both claims to
		// both sides.
		syncBothWays(docA, docB);

		const aWon = wonInitClaim(docA, docA.getText("contents"));
		const bWon = wonInitClaim(docB, docB.getText("contents"));

		// Never both, never neither.
		expect(aWon).toBe(!bWon);
	});

	test("only the winner's insert survives — no duplicated text", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const localFileContents = "shared onboarding note";

		claimInitIfUnclaimed(docA);
		claimInitIfUnclaimed(docB);
		syncBothWays(docA, docB);

		// Each client independently follows the real call sequence: check
		// wonInitClaim, insert only if true, mark done only if it inserted.
		for (const doc of [docA, docB]) {
			const text = doc.getText("contents");
			if (wonInitClaim(doc, text)) {
				text.insert(0, localFileContents);
				markInitDone(doc);
			}
		}

		// Propagate the winner's insert (and initDone flag) to the loser.
		syncBothWays(docA, docB);

		expect(docA.getText("contents").toJSON()).toBe(localFileContents);
		expect(docB.getText("contents").toJSON()).toBe(localFileContents);
	});

	test("a client that arrives after init is done never re-inserts", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const localFileContents = "already there";

		claimInitIfUnclaimed(docA);
		const textA = docA.getText("contents");
		expect(wonInitClaim(docA, textA)).toBe(true);
		textA.insert(0, localFileContents);
		markInitDone(docA);

		// B connects LATER, after A has already finished and propagated.
		syncBothWays(docA, docB);

		claimInitIfUnclaimed(docB);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(false);
		expect(docB.getText("contents").toJSON()).toBe(localFileContents);
	});
});

describe("claimInitIfUnclaimed — reclaiming a dead claimant's stale claim", () => {
	test("without awareness or a stale TTL, an existing claim survives a genuinely competing client (original bug precondition)", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();

		claimInitIfUnclaimed(docA, undefined, clock.now);
		syncBothWays(docA, docB);
		const firstClaimant = docA.getMap("meta").get("initClaim");

		// B is a genuinely different clientID, calling immediately (no clock
		// advance) with no awareness — the original, pre-TTL/reclaim
		// behavior this case guards: fresh/unexpired claims are never
		// touched by a second caller, timestamped shape or not.
		claimInitIfUnclaimed(docB, undefined, clock.now);
		expect(docB.getMap("meta").get("initClaim")).toEqual(firstClaimant);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(false);
	});

	test("a claim is reclaimed immediately once awareness shows the claimant disconnected (dead claimant must not pin the doc forever)", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();

		// A claims, then crashes/disconnects before insert+markInitDone — the
		// pre-fix behavior pinned CLAIM_KEY to A's clientID forever, and no
		// future client (including a fresh session) could ever win the claim
		// again, so the document silently never got seeded.
		claimInitIfUnclaimed(docA, undefined, clock.now);
		syncBothWays(docA, docB);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(false);

		// A's awareness state is gone (dead session) — B's own awareness view
		// no longer lists A's clientID as connected.
		const awarenessWithoutA = {
			getStates: () => new Map<number, unknown>(),
		};

		// Without the fix this would still return false forever (existing
		// claim treated as final); with reclaim, B is free to steal it
		// immediately — no need to wait out the TTL — because awareness
		// proves the claimant is gone.
		claimInitIfUnclaimed(docB, awarenessWithoutA, clock.now);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(true);

		const text = docB.getText("contents");
		text.insert(0, "seeded after reclaim");
		markInitDone(docB);
		syncBothWays(docA, docB);
		expect(docA.getText("contents").toJSON()).toBe("seeded after reclaim");
	});

	test("without awareness data, a claim is reclaimed once it's older than the 30s TTL, not before", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();

		claimInitIfUnclaimed(docA, undefined, clock.now);
		syncBothWays(docA, docB);

		// Just under the TTL: still A's claim, B may not steal it.
		clock.advance(29_000);
		claimInitIfUnclaimed(docB, undefined, clock.now);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(false);

		// Past the TTL: now stale, B reclaims.
		clock.advance(2_000);
		claimInitIfUnclaimed(docB, undefined, clock.now);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(true);
	});

	test("a live claimant (present in awareness, within TTL) is never reclaimed out from under it", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const clock = fakeClock();

		claimInitIfUnclaimed(docA, undefined, clock.now);
		syncBothWays(docA, docB);

		const claim = docA.getMap("meta").get("initClaim") as {
			clientID: number;
		};
		const awarenessWithA = {
			getStates: () => new Map<number, unknown>([[claim.clientID, {}]]),
		};

		// Even well past what would otherwise be a TTL window, a claimant
		// awareness still reports as connected is never stolen — the whole
		// point of preferring the liveness signal over a blind timer.
		clock.advance(60_000);
		claimInitIfUnclaimed(docB, awarenessWithA, clock.now);
		expect(wonInitClaim(docB, docB.getText("contents"))).toBe(false);
		expect(wonInitClaim(docA, docA.getText("contents"))).toBe(true);
	});
});

describe("awaitClaimSettled — real quiet-period signal instead of a fixed delay", () => {
	test("no competing claim ever arrives — resolves after one quiet period, not a blanket 1000ms", async () => {
		const doc = new Y.Doc();
		claimInitIfUnclaimed(doc);
		const clock = fakeClock();
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
		});

		await awaitClaimSettled(doc, { sleep, now: clock.now, quietMs: 300 });

		expect(clock.now()).toBe(300);
	});

	test("a competing claim arriving mid-wait re-arms the quiet period instead of resolving early", async () => {
		const doc = new Y.Doc();
		const otherDoc = new Y.Doc();
		claimInitIfUnclaimed(doc);
		const clock = fakeClock();

		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			// After the first quiet-period sleep elapses (t=300), a sibling's
			// competing claim lands — this must re-arm the quiet period
			// (push settlement out to t=600), not let it resolve on schedule
			// at t=300 as if nothing had happened.
			if (ticks === 1) {
				claimInitIfUnclaimed(otherDoc);
				Y.applyUpdate(
					doc,
					Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(doc)),
				);
			}
		});

		await awaitClaimSettled(doc, { sleep, now: clock.now, quietMs: 300 });

		// One full quiet period (300ms) elapses uneventfully, THEN the
		// competing claim lands, forcing a second full quiet period —
		// t=600, not the t=300 a naive "resolve on first elapsed wait" bug
		// would produce.
		expect(clock.now()).toBe(600);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	test("a flapping doc (claim keeps changing) is still bounded by maxWaitMs — never hangs forever", async () => {
		const doc = new Y.Doc();
		let clientID = 1;
		claimInitIfUnclaimed(doc);
		const clock = fakeClock();

		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			// Simulate perpetual flapping: something keeps rewriting the claim
			// key, so a pure quiet-period wait alone would never settle.
			doc.getMap("meta").set("initClaim", {
				clientID: ++clientID,
				claimedAt: clock.now(),
			});
		});

		await awaitClaimSettled(doc, {
			sleep,
			now: clock.now,
			quietMs: 300,
			maxWaitMs: 1000,
		});

		expect(clock.now()).toBeGreaterThanOrEqual(1000);
	});

	test("waits for the local claim write to flush before watching for a sibling's, per waitForBufferFlush", async () => {
		const doc = new Y.Doc();
		claimInitIfUnclaimed(doc);
		const clock = fakeClock();
		const socket = { bufferedAmount: 200 };
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			socket.bufferedAmount = Math.max(0, socket.bufferedAmount - 100);
		});

		await awaitClaimSettled(doc, {
			socket,
			sleep,
			now: clock.now,
			quietMs: 50,
		});

		expect(socket.bufferedAmount).toBe(0);
	});

	test("a stalled socket AND a flapping claim together are still bounded by ONE maxWaitMs, not the flush phase and the quiet phase each getting their own full budget", async () => {
		const doc = new Y.Doc();
		claimInitIfUnclaimed(doc);
		const clock = fakeClock();
		// Never drains — simulates a socket that's stuck, so the flush phase
		// alone would consume the entire maxWaitMs if it had its own budget.
		const socket = { bufferedAmount: 999 };
		let clientID = 1;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			// Also keep the claim flapping so the quiet-period phase, if it
			// got a SECOND full budget, would burn all of it too.
			doc.getMap("meta").set("initClaim", {
				clientID: ++clientID,
				claimedAt: clock.now(),
			});
		});

		await awaitClaimSettled(doc, {
			socket,
			sleep,
			now: clock.now,
			quietMs: 100,
			maxWaitMs: 1000,
		});

		// A pre-fix version (flush getting its own 1000ms, then the quiet
		// loop getting a FRESH 1000ms computed after) would land at ~2000ms.
		// The whole call must respect ONE 1000ms ceiling.
		expect(clock.now()).toBeLessThanOrEqual(1000);
	});
});
