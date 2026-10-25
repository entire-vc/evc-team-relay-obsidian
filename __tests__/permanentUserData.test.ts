import "fake-indexeddb/auto";
import * as Y from "yjs";
import { createPermanentUserData } from "../src/permanentUserData";
import { LocalDocumentStore } from "../src/storage/local-document-store";

//: after an Obsidian restart the second participant's share was
// "online" but its local store never reached `synced`, so files that had
// already arrived over the websocket were never written to disk.
//
// Cause: Y.PermanentUserData's `users` observer calls
// `initUser(users.get(key), key)` for every changed key. A `users` entry that
// arrives already deleted (a tombstone in a replayed update) is in
// `keysChanged` but `get()` returns undefined -> "Cannot read properties of
// undefined (reading 'get')". Yjs rethrows observer errors out of
// `applyUpdate`/`transact`, which rejected `replayStoredUpdates()` inside
// LocalDocumentStore's open promise, so `synced` never became true.

function userEntry(): Y.Map<unknown> {
	const m = new Y.Map<unknown>();
	m.set("ids", new Y.Array());
	m.set("ds", new Y.Array());
	return m;
}

/** An update in which `users[key]` exists only as a tombstone. */
function tombstonedUsersUpdate(key: string): Uint8Array {
	const src = new Y.Doc();
	const users = src.getMap("users");
	users.set(key, userEntry());
	users.delete(key);
	return Y.encodeStateAsUpdate(src);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			window.setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms),
		),
	]);
}

describe("createPermanentUserData", () => {
	test("a users entry that arrives already deleted does not throw", () => {
		const doc = new Y.Doc();
		createPermanentUserData(doc);

		expect(() => Y.applyUpdate(doc, tombstonedUsersUpdate("acct-gone"))).not.toThrow();
		expect([...doc.getMap("users").keys()]).toEqual([]);
	});

	test("setUserMapping records the local client, and a tombstone arriving later does not throw from its timer", async () => {
		const doc = new Y.Doc();
		const pud = createPermanentUserData(doc);
		pud.setUserMapping(doc, doc.clientID, "acct-B");
		expect(pud.getUserByClientId(doc.clientID)).toBe("acct-B");

		const uncaught: unknown[] = [];
		const onUncaught = (e: unknown) => uncaught.push(e);
		process.on("uncaughtException", onUncaught);
		try {
			Y.applyUpdate(doc, tombstonedUsersUpdate("acct-gone"));
			// setUserMapping re-reads the key from a setTimeout(0).
			await new Promise((r) => window.setTimeout(r, 20));
		} finally {
			process.off("uncaughtException", onUncaught);
		}
		expect(uncaught).toEqual([]);
	});

	test("still tracks a live user entry from another client (the guard does not swallow real events)", () => {
		const remote = new Y.Doc();
		const remotePud = createPermanentUserData(remote);
		remotePud.setUserMapping(remote, remote.clientID, "acct-A");

		const local = new Y.Doc();
		const localPud = createPermanentUserData(local);
		Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

		expect(localPud.getUserByClientId(remote.clientID)).toBe("acct-A");
	});

	test("a batch mixing a live and a deleted key still initialises the live one", () => {
		const src = new Y.Doc();
		const users = src.getMap("users");
		users.set("acct-gone", userEntry());
		users.delete("acct-gone");
		const live = userEntry();
		users.set("acct-live", live);
		(live.get("ids") as Y.Array<number>).push([4242]);

		const doc = new Y.Doc();
		const pud = createPermanentUserData(doc);
		expect(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(src))).not.toThrow();
		expect(pud.getUserByClientId(4242)).toBe("acct-live");
	});
});

describe("LocalDocumentStore replay with identity seeded first", () => {
	async function persistTombstone(name: string): Promise<void> {
		const first = new Y.Doc();
		const store = new LocalDocumentStore(name, first);
		await withTimeout(store.whenSynced, 2000, "first open");
		Y.applyUpdate(first, tombstonedUsersUpdate("acct-gone"));
		// The doc's own "update" handler persists to IDB asynchronously.
		await new Promise((r) => window.setTimeout(r, 50));
		await store.close();
	}

	test("reopen reaches synced when the stored history holds a tombstoned users entry", async () => {
		const name = `pud-guarded-${Math.random()}`;
		await persistTombstone(name);

		// ProviderBacked seeds the identity BEFORE the store replays history.
		const second = new Y.Doc();
		createPermanentUserData(second).setUserMapping(second, second.clientID, "acct-B");
		const store = new LocalDocumentStore(name, second);

		await withTimeout(store.whenSynced, 2000, "reopen");
		expect(store.synced).toBe(true);
	});

	// Pins the Yjs defect this guard works around. If this starts failing
	// because the store DOES sync with the raw class, Yjs fixed it and the guard
	// (src/permanentUserData.ts) can go.
	test("control: the unguarded Y.PermanentUserData wedges the same reopen", async () => {
		const name = `pud-raw-${Math.random()}`;
		await persistTombstone(name);

		const second = new Y.Doc();
		new Y.PermanentUserData(second).setUserMapping(second, second.clientID, "acct-B");
		const store = new LocalDocumentStore(name, second);
		// The open promise ends in the observer's TypeError -- that rejection IS
		// the wedge. Capture it instead of letting it fail the test unhandled.
		const openError = store._dbref.then(
			() => undefined,
			(e: unknown) => e,
		);
		void store.whenSynced.catch(() => undefined);

		await new Promise((r) => window.setTimeout(r, 300));
		expect(store.synced).toBe(false);
		expect(String(await openError)).toMatch(/Cannot read properties of undefined/);
	});
});
