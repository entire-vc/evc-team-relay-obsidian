/**
 * Regression test: — Obsidian restart doubles file content.
 *
 * Root cause: `TransferQueue.uploadDocumentViaSocket` read `doc.text`
 * (`ytext.toJSON()`) to decide whether a document was "empty, therefore
 * brand new, therefore safe to seed from the vault file" WITHOUT first
 * confirming the document's own local persistence (IndexedDB, via
 * `doc.whenSynced()`) had actually finished loading. On a cold Obsidian
 * restart reconnecting many shared folders at once, IndexedDB's fetchUpdates
 * for a given document can still be in flight when this check runs — so an
 * already-populated document can legitimately read as empty for a moment.
 *
 * `initContentClaim.ts` correctly stops a SECOND CLIENT
 * from also inserting into a genuinely-empty doc during that window — but it
 * does nothing to stop THIS client's own not-yet-applied persisted history
 * from landing a moment later and merging with a seed insert that was made
 * under a false "it's empty" premise. Two independent sets of CRDT ops
 * (the real persisted content, and the freshly-seeded copy of the same
 * content) land in the same Y.Doc and Yjs concatenates them — the file ends
 * up with its own content duplicated back-to-back, exactly the reported
 * symptom (first half of the corrupted file byte-identical to the second).
 *
 * These tests use real Y.Doc instances and the REAL, unmodified
 * initContentClaim.ts exports — proving the claim mechanism's insufficiency
 * against production code, not a reimplementation of it — plus the actual
 * fix shape (apply persisted history before ever reading the doc as "empty",
 * mirroring `await doc.whenSynced()`).
 */

import { describe, test, expect } from "@jest/globals";
import * as Y from "yjs";
import {
	claimInitIfUnclaimed,
	wonInitClaim,
	markInitDone,
} from "../src/initContentClaim";

/**
 * The exact production sequence from TransferQueue.ts's relay-empty branch
 * (claim -> settle -> check emptiness -> insert), run against whatever
 * `doc`'s Y.Text currently looks like right now — i.e. as if called before
 * or after some other event, controlled by the caller.
 */
function seedIfWon(doc: Y.Doc, diskContent: string): void {
	claimInitIfUnclaimed(doc);
	const text = doc.getText("contents");
	if (wonInitClaim(doc, text)) {
		text.insert(0, diskContent);
		markInitDone(doc);
	}
}

describe("startup content-seed race — own not-yet-loaded persistence (P0)", () => {
	test("BUG: seeding before the doc's persisted history applies doubles the content", () => {
		const diskContent = "REQUIREMENTS.md content, unchanged since last session";

		// This device already has real persisted CRDT history for this exact
		// document from a PRIOR session (captured as a Yjs update, the same
		// shape IndexedDB's fetchUpdates() replays). The vault file on disk
		// matches it exactly — the common, no-real-conflict case.
		const priorSession = new Y.Doc();
		priorSession.getText("contents").insert(0, diskContent);
		const persistedUpdate = Y.encodeStateAsUpdate(priorSession);

		// A fresh in-memory Y.Doc for this new Obsidian session, BEFORE its
		// IndexedDB history has loaded — this is what `doc.text` reads as at
		// the moment TransferQueue.uploadDocumentViaSocket used to check it.
		const doc = new Y.Doc();
		expect(doc.getText("contents").toJSON()).toBe(""); // looks empty, but ISN'T

		// The claim mechanism correctly lets a solo client through — it only
		// guards against a SECOND client racing the same insert, not against
		// this client's own pending history.
		seedIfWon(doc, diskContent);
		expect(doc.getText("contents").toJSON()).toBe(diskContent);

		// A moment later, IndexedDB's fetchUpdates() resolves and the real
		// persisted history is applied, as it legitimately must be.
		Y.applyUpdate(doc, persistedUpdate);

		// BUG: content is now duplicated back-to-back — the exact reported
		// symptom (first half byte-identical to the second half).
		const result = doc.getText("contents").toJSON();
		const half = result.length / 2;
		expect(result.slice(0, half)).toBe(diskContent);
		expect(result.slice(half)).toBe(diskContent);
		expect(result).not.toBe(diskContent);
	});

	test("FIX: applying persisted history before ever reading the doc as empty prevents the double", () => {
		const diskContent = "REQUIREMENTS.md content, unchanged since last session";

		const priorSession = new Y.Doc();
		priorSession.getText("contents").insert(0, diskContent);
		const persistedUpdate = Y.encodeStateAsUpdate(priorSession);

		const doc = new Y.Doc();

		// FIX SHAPE: mirrors `await doc.whenSynced()` being awaited FIRST in
		// TransferQueue.uploadDocumentViaSocket, before any read of doc.text —
		// the persisted history is applied before we ever decide "is this
		// empty".
		Y.applyUpdate(doc, persistedUpdate);

		// Now the doc correctly reads as already-populated, so the seed
		// branch's own emptiness check (`text.length === 0` inside
		// wonInitClaim) correctly declines to insert — no double.
		seedIfWon(doc, diskContent);

		expect(doc.getText("contents").toJSON()).toBe(diskContent);
	});

	test("FIX: a genuinely brand-new document (persisted history is empty) is still seeded correctly", () => {
		const diskContent = "brand new file, never synced before";

		const doc = new Y.Doc();

		// A genuinely-new document's IndexedDB persistence resolves with
		// nothing to apply — whenSynced() still resolves (fetchUpdates
		// completes even with zero stored updates), so this is a no-op here,
		// and the doc correctly still reads as empty afterward.
		expect(doc.getText("contents").toJSON()).toBe("");

		seedIfWon(doc, diskContent);

		expect(doc.getText("contents").toJSON()).toBe(diskContent);
	});
});
