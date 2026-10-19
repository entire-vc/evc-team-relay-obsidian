/**
 * Unit tests: reconcileClaim
 *
 * The bug: TransferQueue.reconcileRelayContent()'s "safe, no-conflict-copy"
 * fast path applies a raw CRDT bulk insert whenever `base === syncedText`
 * ("the relay hasn't moved since I last agreed with it, so this divergence
 * must be my own unsynced edit"'s fix for a different, single-
 * client race). Two clients editing the same file at genuinely the same
 * moment can BOTH observe that condition against the same stale shared
 * history, because neither has yet received the other's concurrent write —
 * both then insert their own full edit at the same anchor, and Yjs
 * concatenates the two with no conflict-copy on either side (reproduced live
 * 2/2 via two_client_restart_doubling_probe.py before this fix).
 *
 * Same real-Y.Doc test style as initContentClaim.test.ts: yjs is the library
 * under test, mocking it would test nothing.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { claimReconcile, wonReconcileClaim, awaitReconcileSettled } from "../src/reconcileClaim";
import { claimInitIfUnclaimed, awaitClaimSettled } from "../src/initContentClaim";

function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

function syncBothWays(a: Y.Doc, b: Y.Doc): void {
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

describe("claimReconcile + wonReconcileClaim — single client (no race)", () => {
	test("the only client to claim wins", () => {
		const doc = new Y.Doc();
		claimReconcile(doc);
		expect(wonReconcileClaim(doc)).toBe(true);
	});

	test("unlike initContentClaim, a SECOND reconcile attempt by the same lone client claims fresh and still wins — no permanent done-flag blocks a later, legitimate reconcile", () => {
		const doc = new Y.Doc();
		claimReconcile(doc);
		expect(wonReconcileClaim(doc)).toBe(true);

		claimReconcile(doc);
		expect(wonReconcileClaim(doc)).toBe(true);
	});
});

describe("claimReconcile + wonReconcileClaim — two genuinely concurrent clients (the race)", () => {
	test("exactly one of two racing claims wins, and both replicas agree on which", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// Both observe base === syncedText against the same stale shared
		// history and both claim before either has heard from the other —
		// the exact race from the live repro.
		claimReconcile(docA);
		claimReconcile(docB);

		// Settle window elapses; the relay has now propagated both claims.
		syncBothWays(docA, docB);

		const aWon = wonReconcileClaim(docA);
		const bWon = wonReconcileClaim(docB);

		// Never both, never neither — this is the property that prevents
		// concatenation: only one client may proceed to the raw bulk insert.
		expect(aWon).toBe(!bWon);
	});

	test("only the winner's fast-path insert lands — the loser does NOT insert its own text (unlike the pre-fix bug, which let both through)", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const textA = docA.getText("contents");
		const textB = docB.getText("contents");
		const sharedBase = "# Note\n\n";
		textA.insert(0, sharedBase);
		syncBothWays(docA, docB);

		claimReconcile(docA);
		claimReconcile(docB);
		syncBothWays(docA, docB);

		const aWon = wonReconcileClaim(docA);
		const bWon = wonReconcileClaim(docB);

		// Simulate the real caller: only the winner applies its own edit via
		// the fast path. The loser must NOT call the equivalent of
		// applyDiffToYText here — that's exactly the "fall through to
		// conflict-copy" branch the real TransferQueue code takes instead.
		if (aWon) {
			textA.insert(sharedBase.length, "A-EDIT");
		}
		if (bWon) {
			textB.insert(sharedBase.length, "B-EDIT");
		}
		syncBothWays(docA, docB);

		const finalText = docA.getText("contents").toJSON();
		expect(finalText).toBe(docB.getText("contents").toJSON());
		// Exactly one edit landed via the fast path — no concatenation of both.
		const hasA = finalText.includes("A-EDIT");
		const hasB = finalText.includes("B-EDIT");
		expect(hasA).toBe(!hasB);
	});

	test("a claim taken for THIS reconcile round does not carry over — a later, non-concurrent reconcile is unaffected by a stale winner/loser result", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		claimReconcile(docA);
		claimReconcile(docB);
		syncBothWays(docA, docB);
		const firstRoundBWon = wonReconcileClaim(docB);

		// A later, unrelated reconcile attempt on B alone (A not racing this
		// time) must be decided fresh, not by memory of the first round.
		claimReconcile(docB);
		expect(wonReconcileClaim(docB)).toBe(true);
		// Sanity: the first round's outcome for B was whatever it was: this
		// assertion only documents that the SECOND claim doesn't depend on it.
		expect(typeof firstRoundBWon).toBe("boolean");
	});
});

describe("awaitReconcileSettled — independent of initContentClaim's unrelated claim key", () => {
	test("traffic on the init-claim key does NOT satisfy a reconcile-claim settle-wait (the two coordination rounds must not cross-satisfy each other)", async () => {
		const doc = new Y.Doc();
		const otherDoc = new Y.Doc();
		claimReconcile(doc);
		const clock = fakeClock();

		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			if (ticks === 1) {
				// A DIFFERENT client claims the UNRELATED init-claim key mid-wait.
				// If awaitReconcileSettled were watching the wrong key (or a
				// shared/ambiguous one), this would incorrectly re-arm the
				// reconcile settle-wait.
				claimInitIfUnclaimed(otherDoc);
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(doc)));
			}
		});

		await awaitReconcileSettled(doc, { sleep, now: clock.now, quietMs: 300 });

		// Resolves after exactly ONE quiet period (t=300) — the init-claim
		// traffic must not have re-armed it to t=600.
		expect(clock.now()).toBe(300);
	});

	test("conversely, a competing RECONCILE claim mid-wait correctly re-arms the quiet period", async () => {
		const doc = new Y.Doc();
		const otherDoc = new Y.Doc();
		claimReconcile(doc);
		const clock = fakeClock();

		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			if (ticks === 1) {
				claimReconcile(otherDoc);
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(otherDoc, Y.encodeStateVector(doc)));
			}
		});

		await awaitReconcileSettled(doc, { sleep, now: clock.now, quietMs: 300 });

		expect(clock.now()).toBe(600);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	test("bounded by maxWaitMs like awaitClaimSettled, never hangs forever on a flapping claim", async () => {
		const doc = new Y.Doc();
		let clientID = 1;
		claimReconcile(doc);
		const clock = fakeClock();

		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			doc.getMap("meta").set("reconcileClaim", {
				clientID: ++clientID,
				claimedAt: clock.now(),
			});
		});

		await awaitReconcileSettled(doc, { sleep, now: clock.now, quietMs: 300, maxWaitMs: 1000 });

		expect(clock.now()).toBeGreaterThanOrEqual(1000);
	});
});

describe("awaitClaimSettled — explicit claimKey parameter (the generalization reconcileClaim.ts relies on)", () => {
	test("passing an explicit claimKey watches that key instead of the default initClaim", async () => {
		const doc = new Y.Doc();
		doc.getMap("meta").set("someOtherClaim", { clientID: 1, claimedAt: 0 });
		const clock = fakeClock();
		let ticks = 0;
		const sleep = jest.fn(async (ms: number) => {
			clock.advance(ms);
			ticks += 1;
			if (ticks === 1) {
				// Changing the DEFAULT initClaim key must NOT re-arm a
				// settle-wait explicitly watching "someOtherClaim".
				doc.getMap("meta").set("initClaim", { clientID: 2, claimedAt: clock.now() });
			}
		});

		await awaitClaimSettled(doc, {
			sleep,
			now: clock.now,
			quietMs: 300,
			claimKey: "someOtherClaim",
		});

		expect(clock.now()).toBe(300);
	});
});
