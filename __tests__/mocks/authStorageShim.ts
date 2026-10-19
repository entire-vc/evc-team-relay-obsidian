/**
 * Test shim for the auth store's persistence host.
 *
 * Registers an in-memory App#saveLocalStorage/loadLocalStorage host for `appId`
 * and exposes a Map-like view keyed by the old per-server key format
 * (`evc-team-relay_onprem_auth_<appId>_<serverId>` -> JSON string), so tests can
 * seed a session and inspect what the store persisted.
 */
import { registerAuthStorageHost } from "../../src/auth/RelayOnPremAuthStore";

const BLOB_KEY = "evc-team-relay_onprem_auth";

export function createAuthStorageShim(appId: string) {
	const data = new Map<string, unknown>();
	registerAuthStorageHost(appId, {
		loadLocalStorage: (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
		saveLocalStorage: (k, v) => {
			if (v === null) data.delete(k);
			else data.set(k, JSON.parse(JSON.stringify(v)));
		},
	});
	const prefix = `${BLOB_KEY}_${appId}_`;
	const blob = () => ((data.get(BLOB_KEY) as Record<string, unknown> | undefined) ?? {});
	return {
		set(key: string, value: string) {
			const serverId = key.slice(prefix.length);
			let parsed: unknown = value;
			try {
				parsed = JSON.parse(value);
			} catch {
				// keep raw string
			}
			data.set(BLOB_KEY, { ...blob(), [serverId]: parsed });
		},
		get(key: string): string | undefined {
			const v = blob()[key.slice(prefix.length)];
			return v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v);
		},
		clear() {
			data.clear();
		},
	};
}
