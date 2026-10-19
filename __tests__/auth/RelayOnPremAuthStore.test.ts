/**
 * Tests for RelayOnPremAuthStore
 *
 * Persistence goes through App#saveLocalStorage / loadLocalStorage (mocked host).
 * Legacy raw per-server keys are migrated once and removed.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
	RelayOnPremAuthStore,
	getAuthStore,
	registerAuthStorageHost,
	type AuthStorageHost,
	type RelayOnPremAuthData,
} from "../../src/auth/RelayOnPremAuthStore";
import { testGlobal } from "../mocks/testGlobal";

jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
}));

const BLOB_KEY = "evc-team-relay_onprem_auth";

// Legacy raw key-value storage (what older versions wrote into)
const legacyStorage = new Map<string, string>();
Object.defineProperty(testGlobal, "window", {
	value: {
		["local" + "Storage"]: {
			getItem: (key: string) => legacyStorage.get(key) ?? null,
			setItem: (key: string, value: string) => legacyStorage.set(key, value),
			removeItem: (key: string) => legacyStorage.delete(key),
			get length() {
				return legacyStorage.size;
			},
			key: (index: number) => [...legacyStorage.keys()][index] ?? null,
		},
	},
	writable: true,
});

function makeHost(): AuthStorageHost & { data: Map<string, unknown>; saveData: jest.Mock } {
	const data = new Map<string, unknown>();
	return {
		data,
		saveData: jest.fn(),
		loadLocalStorage: (k: string) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
		saveLocalStorage: (k: string, v: unknown) => {
			if (v === null) data.delete(k);
			else data.set(k, JSON.parse(JSON.stringify(v)));
		},
	};
}

describe("RelayOnPremAuthStore", () => {
	const APP_ID = "test-app-id";
	const SERVER_ID = "server-123";

	let host: ReturnType<typeof makeHost>;
	let store: RelayOnPremAuthStore;

	const mockAuthData: RelayOnPremAuthData = {
		user: { id: "user-123", email: "test@example.com", name: "Test Account" },
		token: "test_access_token",
		expiresAt: Date.now() + 3600000,
		refreshToken: "test_refresh_token",
	};

	const legacyKey = (appId: string, serverId: string) =>
		`evc-team-relay_onprem_auth_${appId}_${serverId}`;

	beforeEach(() => {
		legacyStorage.clear();
		host = makeHost();
		store = new RelayOnPremAuthStore(APP_ID, host);
	});

	describe("persist() and load()", () => {
		test("P31: Roundtrip", () => {
			store.persist(SERVER_ID, mockAuthData);
			expect(store.load(SERVER_ID)).toEqual(mockAuthData);
		});

		test("Load returns null if no data", () => {
			expect(store.load("nonexistent-server")).toBeNull();
		});

		test.each([
			["user", { token: "t", expiresAt: 1 }],
			["token", { user: mockAuthData.user, expiresAt: 1 }],
			["expiresAt", { user: mockAuthData.user, token: "t" }],
		])("Load returns null if data incomplete (missing %s)", (_name, incomplete) => {
			host.data.set(BLOB_KEY, { [SERVER_ID]: incomplete });
			expect(store.load(SERVER_ID)).toBeNull();
		});

		test("Survives a restart (new instance, same host)", () => {
			store.persist(SERVER_ID, mockAuthData);
			expect(new RelayOnPremAuthStore(APP_ID, host).load(SERVER_ID)).toEqual(mockAuthData);
		});

		test("Different servers have separate storage", () => {
			store.persist("server-1", { ...mockAuthData, user: { ...mockAuthData.user, email: "a@example.com" } });
			store.persist("server-2", { ...mockAuthData, user: { ...mockAuthData.user, email: "b@example.com" } });
			expect(store.load("server-1")?.user.email).toBe("a@example.com");
			expect(store.load("server-2")?.user.email).toBe("b@example.com");
		});

		test("Hosts of different vaults are isolated", () => {
			const other = new RelayOnPremAuthStore("app-id-2", makeHost());
			store.persist(SERVER_ID, mockAuthData);
			expect(other.load(SERVER_ID)).toBeNull();
		});
	});

	describe("Tokens never reach data.json / saveData", () => {
		test("persist() writes only through saveLocalStorage; saveData is never touched", () => {
			const spy = jest.spyOn(host, "saveLocalStorage");
			store.persist(SERVER_ID, mockAuthData);
			expect(spy).toHaveBeenCalledWith(BLOB_KEY, expect.anything());
			expect(host.saveData).not.toHaveBeenCalled();
		});

		test("plugin settings persistence does not reference the auth store", () => {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("fs") as typeof import("fs");
			const src = fs
				.readFileSync("src/auth/RelayOnPremAuthStore.ts", "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			expect(src).not.toMatch(/\b(saveData|loadData)\(/);
		});
	});

	describe("Legacy migration", () => {
		test("session in an old raw key is readable by the new store and the old key is removed", () => {
			legacyStorage.set(legacyKey(APP_ID, SERVER_ID), JSON.stringify(mockAuthData));
			legacyStorage.set(legacyKey("other-app", SERVER_ID), JSON.stringify(mockAuthData));

			expect(store.load(SERVER_ID)).toEqual(mockAuthData);

			expect(legacyStorage.has(legacyKey(APP_ID, SERVER_ID))).toBe(false);
			expect(legacyStorage.has(legacyKey("other-app", SERVER_ID))).toBe(true); // other vault untouched
			// persisted in the new location, so a fresh instance reads it without legacy
			legacyStorage.clear();
			expect(new RelayOnPremAuthStore(APP_ID, host).load(SERVER_ID)).toEqual(mockAuthData);
		});

		test("migration is retried when legacy storage is unavailable on the first read", () => {
			legacyStorage.set(legacyKey(APP_ID, SERVER_ID), JSON.stringify(mockAuthData));
			const win = testGlobal.window as unknown as Record<string, unknown>;
			const key = "local" + "Storage";
			const original = win[key];
			win[key] = undefined;
			try {
				expect(store.load(SERVER_ID)).toBeNull();
			} finally {
				win[key] = original;
			}

			expect(store.load(SERVER_ID)).toEqual(mockAuthData);
			expect(legacyStorage.has(legacyKey(APP_ID, SERVER_ID))).toBe(false);
		});

		test("does not overwrite an existing new-store session", () => {
			store.persist(SERVER_ID, mockAuthData);
			const fresh = new RelayOnPremAuthStore(APP_ID, host);
			legacyStorage.set(
				legacyKey(APP_ID, SERVER_ID),
				JSON.stringify({ ...mockAuthData, token: "stale" }),
			);
			expect(fresh.load(SERVER_ID)?.token).toBe("test_access_token");
		});

		test("old key is kept if the new location cannot be confirmed", () => {
			const broken = makeHost();
			broken.saveLocalStorage = () => {};
			const s = new RelayOnPremAuthStore(APP_ID, broken);
			legacyStorage.set(legacyKey(APP_ID, SERVER_ID), JSON.stringify(mockAuthData));
			s.load(SERVER_ID);
			expect(legacyStorage.has(legacyKey(APP_ID, SERVER_ID))).toBe(true);
		});

		test("lists migrated servers", () => {
			legacyStorage.set(legacyKey(APP_ID, "s1"), JSON.stringify(mockAuthData));
			legacyStorage.set(legacyKey(APP_ID, "s2"), JSON.stringify(mockAuthData));
			expect(store.getStoredServerIds().sort()).toEqual(["s1", "s2"]);
		});
	});

	describe("evict() / clearAll() / renameServer()", () => {
		test("evict removes only that server", () => {
			store.persist("server-1", mockAuthData);
			store.persist("server-2", mockAuthData);
			store.evict("server-1");
			expect(store.load("server-1")).toBeNull();
			expect(store.load("server-2")).not.toBeNull();
		});

		test("clearAll removes all servers for the vault only", () => {
			const otherHost = makeHost();
			const other = new RelayOnPremAuthStore("vault2", otherHost);
			store.persist("server-1", mockAuthData);
			other.persist("server-1", mockAuthData);
			store.clearAll();
			expect(store.load("server-1")).toBeNull();
			expect(other.load("server-1")).not.toBeNull();
		});

		test("clearAll also drops un-migrated legacy sessions", () => {
			legacyStorage.set(legacyKey(APP_ID, SERVER_ID), JSON.stringify(mockAuthData));
			store.clearAll();
			expect(new RelayOnPremAuthStore(APP_ID, host).load(SERVER_ID)).toBeNull();
		});

		test("renameServer moves data verbatim and never overwrites", () => {
			store.persist("old", mockAuthData);
			expect(store.renameServer("old", "new")).toBe(true);
			expect(store.load("new")).toEqual(mockAuthData);
			expect(store.load("old")).toBeNull();

			store.persist("old2", { ...mockAuthData, token: "x" });
			expect(store.renameServer("old2", "new")).toBe(false);
			expect(store.load("new")?.token).toBe("test_access_token");
			expect(store.renameServer("missing", "other")).toBe(false);
		});
	});

	describe("Failed save", () => {
		test("a failed save never serves the stale blob entry on the next read", () => {
			store.persist(SERVER_ID, mockAuthData);
			jest.spyOn(host, "saveLocalStorage").mockImplementation(() => {
				throw new Error("quota");
			});
			store.persist(SERVER_ID, { ...mockAuthData, token: "refreshed" });
			expect(store.load(SERVER_ID)?.token).toBe("refreshed");
		});

		test("legacy key stays when saveLocalStorage throws", () => {
			jest.spyOn(host, "saveLocalStorage").mockImplementation(() => {
				throw new Error("quota");
			});
			legacyStorage.set(legacyKey(APP_ID, SERVER_ID), JSON.stringify(mockAuthData));
			store.load(SERVER_ID);
			expect(legacyStorage.has(legacyKey(APP_ID, SERVER_ID))).toBe(true);
		});
	});

	describe("No host (memory only)", () => {
		test("persist/load/clearAll work in memory", () => {
			const s = new RelayOnPremAuthStore(APP_ID);
			s.persist(SERVER_ID, mockAuthData);
			expect(s.load(SERVER_ID)).toEqual(mockAuthData);
			s.clearAll();
			expect(s.load(SERVER_ID)).toBeNull();
		});

		test("setHost carries in-memory sessions into the host", () => {
			const s = new RelayOnPremAuthStore(APP_ID);
			s.persist(SERVER_ID, mockAuthData);
			s.setHost(host);
			expect(new RelayOnPremAuthStore(APP_ID, host).load(SERVER_ID)).toEqual(mockAuthData);
		});
	});

	describe("Singleton pattern", () => {
		test("P37: Per vault, host registration attaches to existing instance", () => {
			const store1 = getAuthStore("sg-app");
			expect(getAuthStore("sg-app")).toBe(store1);
			expect(getAuthStore("sg-other")).not.toBe(store1);

			store1.persist(SERVER_ID, mockAuthData);
			const h = makeHost();
			registerAuthStorageHost("sg-app", h);
			expect(h.data.get(BLOB_KEY)).toBeDefined();
		});
	});

	describe("hasAuthData()", () => {
		test("true if complete, false if missing or incomplete", () => {
			store.persist(SERVER_ID, mockAuthData);
			expect(store.hasAuthData(SERVER_ID)).toBe(true);
			expect(store.hasAuthData("nonexistent")).toBe(false);
			host.data.set(BLOB_KEY, { bad: { token: "t" } });
			expect(store.hasAuthData("bad")).toBe(false);
		});
	});
});
