import { UnsavedFileStore } from "src/UnsavedFile";
import { testGlobal } from "./mocks/testGlobal";

/**
 * Minimal in-memory IndexedDB fake, scoped to exactly the operations
 * UnsavedFileStore uses (open/onupgradeneeded/transaction/objectStore/
 * put/get/delete on a single object store with an out-of-line `keyPath`).
 *
 * The point of the fake is the keyPath-based key extraction in `put()`: a
 * real IndexedDB store derives a record's key by reading `value[keyPath]`
 * from the object handed to `put()`, not from whatever local variable name
 * produced that object. That's exactly the hazard this guards against --
 * `persistUnsaved(guid, contents)` builds its record with the object
 * shorthand `{ guid, contents }`, so the STORED FIELD is named after the
 * PARAMETER, not after `SyncableEntry.entityGuid` or any other interface
 * member. Renaming that parameter (independent of any interface rename)
 * silently changes the field name, the keyPath stops matching, and every
 * previously-saved buffer becomes unreadable -- with no type error, because
 * IndexedDB records here are untyped `unknown` blobs. A round-trip through
 * a fake with real keyPath semantics is enough to catch that: if the field
 * isn't named `guid`, `put()` cannot find a key and `get(theGuid)` returns
 * nothing back.
 */
function installFakeIndexedDB(): void {
	const stores = new Map<string, { keyPath: string; rows: Map<string, unknown> }>();

	function makeRequest<T>(run: () => T): { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T } {
		const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as T };
		queueMicrotask(() => {
			try {
				req.result = run();
				req.onsuccess?.();
			} catch {
				req.onerror?.();
			}
		});
		return req;
	}

	function objectStore(name: string) {
		const store = stores.get(name);
		if (!store) throw new Error(`no such store: ${name}`);
		return {
			put: (value: Record<string, unknown>) =>
				makeRequest(() => {
					const key = value[store.keyPath];
					if (key === undefined) {
						throw new Error(`put() value has no '${store.keyPath}' field -- cannot derive a key`);
					}
					store.rows.set(String(key), value);
					return key;
				}),
			get: (key: string) => makeRequest(() => store.rows.get(String(key))),
			delete: (key: string) => makeRequest(() => void store.rows.delete(String(key))),
		};
	}

	const db = {
		createObjectStore: (name: string, options: { keyPath: string }) => {
			stores.set(name, { keyPath: options.keyPath, rows: new Map() });
		},
		transaction: (_name: string, _mode: string) => ({
			objectStore,
		}),
	};

	(testGlobal as unknown as { indexedDB: unknown }).indexedDB = {
		open: (_name: string, _version: number) => {
			const req = {
				onupgradeneeded: null as (() => void) | null,
				onsuccess: null as (() => void) | null,
				onerror: null as (() => void) | null,
				result: db,
			};
			queueMicrotask(() => {
				req.onupgradeneeded?.({ target: { result: db } } as unknown as IDBVersionChangeEvent);
				req.onsuccess?.();
			});
			return req;
		},
	};
}

describe("UnsavedFileStore (: guid wire-format guard)", () => {
	beforeEach(() => {
		installFakeIndexedDB();
	});

	it("round-trips a saved buffer by guid", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-1", "unsaved contents");

		const readBack = await store.readUnsaved("doc-guid-1");

		expect(readBack).toBe("unsaved contents");
	});

	it("stores the record under a field literally named 'guid', matching the on-disk keyPath", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-2", "other contents");

		// The only way readUnsaved() can find this record at all is if the
		// object persistUnsaved() wrote had a `guid` field equal to the key --
		// exactly the shorthand-object-literal behavior in persistUnsaved()
		// (`store.put({ guid, contents })`) that a renamed parameter would break.
		const readBack = await store.readUnsaved("doc-guid-2");
		expect(readBack).not.toBeNull();

		const missing = await store.readUnsaved("some-other-guid");
		expect(missing).toBeNull();
	});

	it("discardUnsaved removes the buffer so a later read returns null", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-3", "to be discarded");

		await store.discardUnsaved("doc-guid-3");

		expect(await store.readUnsaved("doc-guid-3")).toBeNull();
	});
});
