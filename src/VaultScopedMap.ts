import type { App } from "obsidian";

/**
 * Vault-scoped local storage Map backed by App#saveLocalStorage / App#loadLocalStorage.
 *
 * All entries are stored as a single JSON blob under `blobKey`, which Obsidian
 * automatically scopes to the current vault. This avoids direct access to the
 * restricted `local storage` global and ensures data is vault-unique.
 */
export class VaultScopedMap<T> implements Map<string, T> {
	private blobKey: string;
	private app: App;
	private cache: Map<string, T>;

	constructor(blobKey: string, app: App) {
		this.blobKey = blobKey;
		this.app = app;
		this.cache = this._load();
	}

	private _load(): Map<string, T> {
		const raw = this.app.loadLocalStorage(this.blobKey) as Record<string, T> | null;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return new Map(Object.entries(raw));
		}
		return new Map();
	}

	private _persist(): void {
		const obj: Record<string, T> = {};
		this.cache.forEach((value, key) => {
			obj[key] = value;
		});
		this.app.saveLocalStorage(this.blobKey, obj);
	}

	public get size(): number {
		return this.cache.size;
	}

	public clear(): void {
		this.cache.clear();
		this.app.saveLocalStorage(this.blobKey, null);
	}

	public delete(key: string): boolean {
		const existed = this.cache.delete(key);
		if (existed) {
			this._persist();
		}
		return existed;
	}

	public forEach(
		callbackfn: (value: T, key: string, map: Map<string, T>) => void,
		thisArg?: unknown,
	): void {
		this.cache.forEach((value, key) => {
			callbackfn.call(thisArg, value, key, this);
		});
	}

	public get(key: string): T | undefined {
		return this.cache.get(key);
	}

	public has(key: string): boolean {
		return this.cache.has(key);
	}

	public set(key: string, value: T): this {
		this.cache.set(key, value);
		this._persist();
		return this;
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	public values(): MapIterator<T> {
		return this.cache.values();
	}

	public entries(): MapIterator<[string, T]> {
		return this.cache.entries();
	}

	[Symbol.iterator](): MapIterator<[string, T]> {
		return this.cache.entries();
	}

	get [Symbol.toStringTag](): string {
		return "VaultScopedMap";
	}
}
