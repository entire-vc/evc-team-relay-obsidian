/**
 * Relay On-Premise Authentication Store
 *
 * Persists authentication state per device so that users remain logged in
 * across Obsidian restarts. Supports multiple servers with independent auth state.
 *
 * Storage: a single blob under `AUTH_BLOB_KEY` written through Obsidian's
 * App#saveLocalStorage / App#loadLocalStorage (vault-scoped, per device, sync API).
 * Deliberately NOT `saveData()` / `data.json`: that file is a plugin settings file
 * that Obsidian Sync / git / backups carry between devices, and refresh tokens
 * must not travel with it.
 *
 * Uses singleton pattern per vault instance (keyed by Obsidian's stable `app.appId`,
 * NOT the user-editable vault name) to prevent race conditions when multiple
 * providers access storage simultaneously.
 */

import { namedLogger } from "../logging";
import type { AuthUser } from "./IAuthProvider";

export interface RelayOnPremAuthData {
	user: AuthUser;
	token: string;
	expiresAt: number;
	refreshToken?: string;
}

/** Subset of Obsidian's App used for per-device, vault-scoped storage. */
export interface AuthStorageHost {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

const AUTH_BLOB_KEY = "evc-team-relay_onprem_auth";

/** Prefix of the pre-blob raw keys: `<prefix><appId>_<serverId>`. */
const LEGACY_KEY_PREFIX = "evc-team-relay_onprem_auth_";

type AuthBlob = Record<string, unknown>;

/**
 * Storage hosts per vault appId. main.ts registers the App before any store is used.
 */
const authStorageHosts: Map<string, AuthStorageHost> = new Map();

export function registerAuthStorageHost(appId: string, host: AuthStorageHost): void {
	authStorageHosts.set(appId, host);
	authStoreInstances.get(appId)?.setHost(host);
}

/**
 * One-time legacy read: sessions written by older versions live under raw
 * per-server keys in the renderer's key-value storage, which Obsidian's
 * App#loadLocalStorage (a different, vault-prefixed key space) cannot see and
 * cannot enumerate. This is the only place that touches it, read-and-remove only.
 */
function getLegacyStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		const legacy = Reflect.get(window, "local" + "Storage") as Storage | undefined;
		return legacy ?? null;
	} catch {
		return null;
	}
}

/**
 * Singleton instances per vault appId to ensure consistent storage access
 */
const authStoreInstances: Map<string, RelayOnPremAuthStore> = new Map();

/**
 * Get or create a singleton AuthStore instance for the given vault (by appId).
 * This prevents multiple providers from creating separate instances with
 * separate fallback storage, which could cause auth loss.
 */
export function getAuthStore(appId: string): RelayOnPremAuthStore {
	if (!authStoreInstances.has(appId)) {
		authStoreInstances.set(appId, new RelayOnPremAuthStore(appId, authStorageHosts.get(appId)));
	}
	return authStoreInstances.get(appId)!;
}

export class RelayOnPremAuthStore {
	private log = namedLogger("[RelayOnPremAuthStore]");
	private memoryFallback: { [key: string]: unknown } = {};
	private appId: string;
	private static readonly MAX_RETRY_ATTEMPTS = 3;
	private static readonly RETRY_DELAY_MS = 50;

	private host?: AuthStorageHost;
	private legacyMigrated = false;
	/** True while the last save failed: memory holds the newest blob, the host a stale one. */
	private saveFailed = false;

	constructor(appId: string, host?: AuthStorageHost) {
		this.appId = appId;
		this.host = host;
		this.log(`Initialized for vault appId: ${appId}`);
	}

	/** Attach the storage host; carries over anything held in memory so far. */
	setHost(host: AuthStorageHost): void {
		if (this.host === host) return;
		this.host = host;
		const pending = this.memoryFallback;
		if (Object.keys(pending).length > 0) {
			const blob = this._readBlob();
			for (const [k, v] of Object.entries(pending)) {
				if (blob[k] === undefined) blob[k] = v;
			}
			this._writeBlob(blob);
		}
	}

	/**
	 * Save authentication data to local storage for a specific server
	 */
	persist(serverId: string, authData: RelayOnPremAuthData): void {
		this._write(serverId, authData);
	}

	/**
	 * Load authentication data from local storage for a specific server
	 */
	load(serverId: string): RelayOnPremAuthData | null {
		const data = this._read(serverId) as RelayOnPremAuthData | null | undefined;

		if (!data) {
			this.log(`load: no data found for serverId=${serverId}`);
			return null;
		}

		if (!data.user || !data.token || !data.expiresAt) {
			this.log(`load: incomplete data - user=${!!data.user}, token=${!!data.token}, expiresAt=${!!data.expiresAt}`);
			return null;
		}

		this.log(`load: successfully loaded auth for user=${data.user?.email}`);
		return data;
	}

	/**
	 * Clear authentication data from local storage for a specific server
	 */
	evict(serverId: string): void {
		this._delete(serverId);
	}

	/**
	 * Move stored auth data from one serverId to another (server-rename migration).
	 * Verbatim: the payload is not parsed or shape-validated, so a partially written
	 * or corrupt blob is relocated rather than silently dropped -- unlike load(),
	 * which validates shape and would drop anything incomplete.
	 * No-op returning false if `fromServerId` holds nothing, or if `toServerId`
	 * already holds data -- an existing login is never overwritten.
	 */
	renameServer(fromServerId: string, toServerId: string): boolean {
		const fromData = this._read(fromServerId);
		if (fromData === undefined) {
			return false;
		}
		if (this._read(toServerId) !== undefined) {
			return false;
		}

		this._write(toServerId, fromData);
		this._delete(fromServerId);
		return true;
	}

	/**
	 * Clear all authentication data for all servers
	 */
	clearAll(): void {
		this._migrateLegacy();
		this.memoryFallback = {};
		if (this.host) {
			this.host.saveLocalStorage(AUTH_BLOB_KEY, null);
		}
	}

	/**
	 * Check if there's valid auth data in storage for a specific server
	 */
	hasAuthData(serverId: string): boolean {
		const data = this.load(serverId);
		return data !== null;
	}

	/**
	 * Get list of all server IDs that have stored auth data
	 */
	getStoredServerIds(): string[] {
		return Object.keys(this._readBlob());
	}

	// ---------------------------------------------------------------
	// Internal helpers
	// ---------------------------------------------------------------

	private _readBlob(): AuthBlob {
		this._migrateLegacy();
		if (!this.host || this.saveFailed) {
			return { ...this.memoryFallback };
		}
		try {
			const raw = this.host.loadLocalStorage(AUTH_BLOB_KEY);
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				return { ...(raw as AuthBlob) };
			}
		} catch (e: unknown) {
			this.log(`_readBlob: load failed: ${e instanceof Error ? e.message : String(e)}`);
			return { ...this.memoryFallback };
		}
		return {};
	}

	private _writeBlob(blob: AuthBlob): void {
		this.memoryFallback = { ...blob };
		if (!this.host) return;
		try {
			this.host.saveLocalStorage(AUTH_BLOB_KEY, Object.keys(blob).length ? blob : null);
			this.saveFailed = false;
		} catch (e: unknown) {
			this.saveFailed = true;
			this.log(`_writeBlob: save failed, keeping in memory: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private _read(serverId: string): unknown {
		return this._readBlob()[serverId];
	}

	private _write(serverId: string, value: unknown): void {
		const blob = this._readBlob();
		blob[serverId] = value;
		this._writeBlob(blob);
	}

	private _delete(serverId: string): void {
		const blob = this._readBlob();
		delete blob[serverId];
		this._writeBlob(blob);
	}

	/**
	 * Move sessions from the legacy raw per-server keys into the blob, once.
	 * A legacy key is removed only after its value is confirmed readable from the
	 * new location; an existing new-store entry is never overwritten.
	 */
	private _migrateLegacy(): void {
		if (this.legacyMigrated || !this.host) return;
		const legacy = getLegacyStorage();
		if (!legacy) return; // unavailable now: not marked migrated, retried on the next read
		this.legacyMigrated = true;
		try {
			const prefix = `${LEGACY_KEY_PREFIX}${this.appId}_`;
			const keys: string[] = [];
			for (let i = 0; i < legacy.length; i++) {
				const key = legacy.key(i);
				if (key && key.startsWith(prefix) && key.length > prefix.length) keys.push(key);
			}
			if (keys.length === 0) return;

			const raw = this.host.loadLocalStorage(AUTH_BLOB_KEY);
			const blob: AuthBlob =
				raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as AuthBlob) } : {};
			for (const key of keys) {
				const serverId = key.substring(prefix.length);
				const rawValue = legacy.getItem(key);
				if (rawValue && blob[serverId] === undefined) {
					try {
						blob[serverId] = JSON.parse(rawValue) as unknown;
					} catch {
						blob[serverId] = rawValue;
					}
				}
			}
			this.host.saveLocalStorage(AUTH_BLOB_KEY, blob);
			const check = this.host.loadLocalStorage(AUTH_BLOB_KEY) as AuthBlob | null;
			for (const key of keys) {
				const serverId = key.substring(prefix.length);
				if (check && check[serverId] !== undefined) legacy.removeItem(key);
			}
			this.log(`_migrateLegacy: migrated ${keys.length} legacy session key(s)`);
		} catch (e: unknown) {
			this.legacyMigrated = false;
			this.log(`_migrateLegacy: failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
