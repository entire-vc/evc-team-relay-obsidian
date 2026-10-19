export interface ObjectStoreReport {
	storeKey: string;
	docPath: string;
	relayLabel: string;
	installId: string;
	itemCount: number;
	approxSizeMB: number;
	legacyNaming: boolean;
}

export interface StorageUsageSummary {
	relayDatabaseCount: number;
	documentUpdateCount: number;
	totalSizeMegabytes: number;
	browserDatabaseCount: number;
	oversizedStores: ObjectStoreReport[];
}

const LARGE_STORE_BYTES = 1024 * 1024;
const UPDATES_STORE = "updates";
const CUSTOM_STORE = "custom";

function toMB(bytes: number): number {
	return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error ?? new Error("Failed to open database"));
		request.onsuccess = () => resolve(request.result);
	});
}

function promisifyRequest<T>(request: IDBRequest<T>, errorMessage: string): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(errorMessage));
	});
}

function readCustomValue(store: IDBObjectStore, key: string): Promise<string> {
	return new Promise((resolve) => {
		const request = store.get(key);
		request.onsuccess = () => resolve((request.result as string | undefined) || "");
	});
}

function measureStoreBytes(store: IDBObjectStore): Promise<number> {
	return new Promise((resolve, reject) => {
		let bytes = 0;
		const cursorRequest = store.openCursor();
		cursorRequest.onsuccess = (event) => {
			const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
			if (!cursor) {
				resolve(bytes);
				return;
			}
			bytes +=
				cursor.value instanceof Uint8Array
					? cursor.value.byteLength
					: JSON.stringify(cursor.value).length;
			cursor.continue();
		};
		cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Failed to iterate cursor"));
	});
}

interface LocalDatabaseInfo {
	itemCount: number;
	byteSize: number;
	appId: string;
	path: string;
	relay: string;
}

/**
 * Opens `dbName` and, if it has the {@link UPDATES_STORE}/{@link CUSTOM_STORE}
 * shape a relay-backed doc store uses, reads its size/appId/path/relay info.
 * Returns `null` for any database that isn't shaped like ours — callers treat
 * that the same as "skip", matching the original scan's behavior of not
 * counting or progress-reporting on non-relay databases.
 */
async function inspectRelayDatabase(dbName: string): Promise<LocalDatabaseInfo | null> {
	const db = await openDatabase(dbName);
	try {
		const storeNames = Array.from(db.objectStoreNames);
		if (!storeNames.includes(UPDATES_STORE) || !storeNames.includes(CUSTOM_STORE)) {
			return null;
		}

		const tx = db.transaction([UPDATES_STORE, CUSTOM_STORE], "readonly");
		const updatesStore = tx.objectStore(UPDATES_STORE);
		const customStore = tx.objectStore(CUSTOM_STORE);

		const appId = await readCustomValue(customStore, "appId");
		const itemCount = await promisifyRequest(updatesStore.count(), "Failed to count records");

		let byteSize = 0;
		let path = "";
		let relay = "";
		if (itemCount > 0) {
			byteSize = await measureStoreBytes(updatesStore);
			path = await readCustomValue(customStore, "path");
			relay = await readCustomValue(customStore, "relay");
		}

		return { itemCount, byteSize, appId, path, relay };
	} finally {
		db.close();
	}
}

export async function surveyLocalDatabases(options: {
	appId: string;
	filterByAppId: boolean;
	onProgress?: (progress: number) => void;
}): Promise<StorageUsageSummary> {
	const { appId, filterByAppId, onProgress } = options;
	const databases = await window.indexedDB.databases();
	const largeStores: ObjectStoreReport[] = [];

	let totalStores = 0;
	let totalItems = 0;
	let totalSize = 0;
	let processed = 0;

	for (const dbInfo of databases) {
		if (!dbInfo.name) continue;

		try {
			const info = await inspectRelayDatabase(dbInfo.name);
			if (!info) {
				// Not a relay-shaped database — the original scan neither counts
				// nor progress-reports these, so match that here.
				continue;
			}

			totalStores++;
			totalItems += info.itemCount;
			totalSize += info.byteSize;

			const isLargeEnough = info.byteSize > LARGE_STORE_BYTES;
			const matchesFilter = !filterByAppId || info.appId === appId;
			if (isLargeEnough && matchesFilter) {
				largeStores.push({
					storeKey: `${dbInfo.name}/${UPDATES_STORE}`,
					docPath: info.path,
					relayLabel: info.relay,
					installId: info.appId || "unknown",
					itemCount: info.itemCount,
					approxSizeMB: toMB(info.byteSize),
					legacyNaming: !dbInfo.name.startsWith(`${appId}-relay`),
				});
			}
		} catch (error: unknown) {
			console.error(`Error processing database ${dbInfo.name}:`, error);
			continue;
		}

		processed++;
		onProgress?.((processed / databases.length) * 100);
	}

	return {
		relayDatabaseCount: totalStores,
		documentUpdateCount: totalItems,
		totalSizeMegabytes: toMB(totalSize),
		browserDatabaseCount: databases.length,
		oversizedStores: largeStores.sort((a, b) => b.approxSizeMB - a.approxSizeMB),
	};
}

export async function deleteObjectStore(slug: string): Promise<void> {
	const [dbName, storeName] = slug.split("/");
	const db = await openDatabase(dbName);
	try {
		const store = db.transaction(storeName, "readwrite").objectStore(storeName);
		await promisifyRequest(store.clear(), "Failed to clear store");
	} catch (error: unknown) {
		console.error(`Error deleting store: ${slug}`, error);
	} finally {
		db.close();
	}
}
