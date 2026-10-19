/**
 * Regression test: — Obsidian restart doubles file content.
 *
 * Exercises the REAL `TransferQueue.uploadDocumentViaSocket` (not a
 * reimplementation) against a minimal duck-typed `Document` (real
 * `Document.prototype` in its chain via `Object.create`, so `isDocument()`'s
 * `instanceof` check passes, without needing the full VaultShare/vault
 * machinery a real `new Document(...)` would require).
 *
 * Asserts the ordering fix directly: `doc.awaitFirstSync()` — which resolves
 * once this document's own IndexedDB-persisted history has actually loaded
 * — must be called BEFORE `doc.content` is ever read. Before the fix, the
 * content was read first with no wait at all, which is exactly how an
 * already-populated document could read as empty mid-restart (fetchUpdates
 * still in flight) and get blindly re-seeded from the vault file, doubling
 * it once its real history landed a moment later. See
 * backgroundSyncSeedRace.test.ts for the CRDT-level mechanism proof.
 */

import { describe, test, expect } from "@jest/globals";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { SystemClock } from "../src/Clock";

describe("uploadDocumentViaSocket — must await awaitFirstSync() before reading .content", () => {
	test("doc.awaitFirstSync() is called before doc.content is ever accessed", async () => {
		const order: string[] = [];

		const fakeDoc = Object.create(Document.prototype) as Document;
		Object.defineProperty(fakeDoc, "awaitFirstSync", {
			value: () => {
				order.push("awaitFirstSync");
				return Promise.resolve();
			},
		});
		Object.defineProperty(fakeDoc, "content", {
			get() {
				order.push("content");
				return "abc";
			},
		});
		Object.defineProperty(fakeDoc, "vaultShare", {
			value: { read: async () => "" },
		});
		Object.defineProperty(fakeDoc, "onceEverSynced", {
			value: async () => {},
		});
		Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "connected" });
		Object.defineProperty(fakeDoc, "bringOnline", {
			// Returning false makes uploadDocumentViaSocket log a warning and
			// return right after this — plenty far past the ordering point
			// under test, without needing to fake the rest of the relay
			// reconcile machinery.
			value: async () => false,
		});

		const backgroundSync = new TransferQueue(
			{} as never,
			new SystemClock(),
			{} as never,
		);

		await backgroundSync.uploadDocumentViaSocket(fakeDoc);

		expect(order).toContain("awaitFirstSync");
		expect(order).toContain("content");
		expect(order.indexOf("awaitFirstSync")).toBeLessThan(order.indexOf("content"));
	});
});
