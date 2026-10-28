/**
 * A user-mapping seed that never reaches local storage strands the rest of
 * that client's changes on every peer.
 *
 * The provider seeds the `users` entry (clocks 0-3) before the document opens
 * its store. Before the store kept that seed, a later session replayed the
 * client's stored clocks 4+ without 0-3, held them pending, and sent them to
 * the relay in sync step 2 (`encodeStateAsUpdate` includes pending structs).
 * Every peer then reported `pendingStructs.missing` for that client at clock 3.
 */
import "fake-indexeddb/auto";
import { describe, test, expect } from "@jest/globals";
import * as Y from "yjs";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { createPermanentUserData } from "../src/permanentUserData";

const ACCOUNT = "account-b";
const tick = (ms = 50) => new Promise((r) => window.setTimeout(r, ms));

/** One app session: identity seeded before the store opens, never connected. */
async function offlineSession(name: string, clientID: number, text = ""): Promise<Y.Doc> {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	createPermanentUserData(doc).setUserMapping(doc, doc.clientID, ACCOUNT);
	const store = new LocalDocumentStore(name, doc);
	await store.whenSynced;
	if (text) doc.getText("contents").insert(0, text);
	await tick();
	await store.destroy();
	return doc;
}

describe("users seed of an offline session", () => {
	test("a later session uploads no users change whose seed nobody holds", async () => {
		const name = `users-seed-${Math.random()}`;
		// Earliest session: its users entry wins the key against later seeds.
		await offlineSession(name, 2_000_000_000, "note\n");
		// Session that loses the key: Yjs ports its ids/ds into the stored
		// entry (clocks 4+) after its own seed (clocks 0-3).
		const lost = await offlineSession(name, 1_000);

		// Next start: whatever is stored goes to the relay in sync step 2.
		const next = new Y.Doc();
		createPermanentUserData(next).setUserMapping(next, next.clientID, ACCOUNT);
		const store = new LocalDocumentStore(name, next);
		await store.whenSynced;
		const relay = new Y.Doc();
		Y.applyUpdate(relay, Y.encodeStateAsUpdate(next, Y.encodeStateVector(relay)));
		await store.destroy();

		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(relay));
		expect(next.store.pendingStructs?.missing ?? new Map()).toEqual(new Map());
		expect(peer.store.pendingStructs?.missing ?? new Map()).toEqual(new Map());
		expect(next.getText("contents").toString()).toBe("note\n");
		// The losing session did write its port (clocks 4+), and the seed with it.
		const clockOf = (doc: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(1_000);
		expect(clockOf(peer)).toBe(clockOf(lost));
		expect(clockOf(peer)).toBeGreaterThan(4);
	});
});
