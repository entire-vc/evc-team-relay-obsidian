/**
 * Regression test for: `onpremServerId` was lost when a caller
 * wrote it right after creating the VaultShare that owns it.
 *
 * Root cause (found by live two-stand reproduction, see the task thread):
 * `Settings<T>.mutate()` computed the new value synchronously but only
 * assigned it to `this.currentValue` AFTER an `await this.backend.loadData()`
 * round-trip. `_instantiateVaultShare` (main.ts) creates a shared folder's
 * settings node via an unawaited `void folderSettings.mutateValue(...)`, then
 * returns the folder synchronously; callers (QuickShareModal etc.) then
 * wrote `onpremServerId` via a second, separately-awaited settings write
 * issued right after. Because the first write's `this.currentValue` assignment
 * was deferred behind a real `await`, the second write's `SettingsScope`
 * read the settings root *before* the first write's node existed in
 * memory — and because `Settings.mutate()` unconditionally overwrites
 * `this.currentValue` with its own (now-stale) computed snapshot when it
 * finally resolves, whichever of the two writes' internal disk round-trip
 * resolved last clobbered the other, dropping either the folder's own fields
 * (path/guid/relay) or the just-written `onpremServerId`.
 *
 * The fix moves the `this.currentValue = updated` assignment in
 * `Settings.mutate()` to before its internal disk round-trip, so two
 * `mutate()`/`update()` calls issued back-to-back (the second right after the
 * first, without awaiting it) compose in call order instead of racing — see
 * the comment on `Settings.mutate()` in `src/SettingsPersistence.ts`.
 *
 * This test reproduces the exact call shape (fire-and-forget node-creation
 * write immediately followed by a second, awaited write to a field on that
 * same node) against the real `Settings`/`SettingsScope` classes, not
 * mocks — a mocked settings layer can't reproduce a race that lives inside
 * the real implementation's own await ordering.
 */

import { describe, test, expect } from "@jest/globals";
import { SettingsScope, Settings } from "../src/SettingsPersistence";

/**
 * Serializes through JSON on every round-trip, like Obsidian's real
 * plugin-data adapter. A naive in-memory adapter that stores the object
 * *reference* would alias any in-memory mutation into what "disk" returns,
 * hiding exactly the class of bug this suite
 * exists to catch — see the CONTROL2 case below, which fails first against
 * a reference-aliasing adapter and only holds once this adapter is used.
 */
class SerializingStorageAdapter<T> {
	private json: string | null = null;

	async loadData(): Promise<T | null> {
		return this.json === null ? null : (JSON.parse(this.json) as T);
	}

	async saveData(data: T): Promise<void> {
		this.json = JSON.stringify(data);
	}
}

interface FolderNode {
	guid: string;
	path: string;
	relay?: string;
	onpremServerId?: string;
}

interface Root {
	sharedFolders?: FolderNode[];
}

describe("SettingsScope.mutateValue() write ordering", () => {
	test("BUG (would fail pre-fix): a fire-and-forget node-creation write followed immediately by a second write to a field on that node loses neither", async () => {
		const storage = new SerializingStorageAdapter<Root>();
		const settings = new Settings<Root>(storage, {});
		await settings.hydrate();

		const guid = "folder-guid-1";

		// Simulates main.ts's _instantiateVaultShare: creates the array item,
		// does NOT await the write, and returns synchronously — exactly what
		// ShareRegistry.new() does today.
		const creationWrite = settings.mutate((current) => ({
			...current,
			sharedFolders: [
				...(current.sharedFolders ?? []),
				{ guid, path: "Notes/Shared", relay: "relay-onprem" },
			],
		}));

		// Simulates the caller's very next line: VaultShare.setOnpremServerId(),
		// issued synchronously right after sharedFolders.new() returns — no
		// await sits between the two in the real call sites this test mirrors
		// (QuickShareModal.createShare, main.ts's loadRelayOnPremShares, etc.).
		const folderSettings = new SettingsScope<FolderNode>(
			settings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		const serverIdWrite = folderSettings.mutateValue((current) => ({
			...current,
			onpremServerId: "server-b",
		}));

		await Promise.all([creationWrite, serverIdWrite]);

		const items = settings.snapshot().sharedFolders ?? [];
		expect(items).toHaveLength(1);
		// Both writes' effects must survive: the fields the creation write set
		// AND the field the second write set. Pre-fix, one of these two groups
		// is silently dropped depending on which write's internal disk
		// round-trip happens to resolve last.
		expect(items[0]).toMatchObject({
			guid,
			path: "Notes/Shared",
			relay: "relay-onprem",
			onpremServerId: "server-b",
		});
	});

	test("CONTROL: the same two writes, sequenced (second awaits the first), always compose correctly", async () => {
		// Proves the assertion above is a genuine race signal, not an
		// assertion the storage layer can never satisfy — with proper
		// sequencing (no unawaited write in flight when the second starts)
		// the same operations succeed both before and after the fix.
		const storage = new SerializingStorageAdapter<Root>();
		const settings = new Settings<Root>(storage, {});
		await settings.hydrate();

		const guid = "folder-guid-2";

		await settings.mutate((current) => ({
			...current,
			sharedFolders: [
				...(current.sharedFolders ?? []),
				{ guid, path: "Notes/Shared2", relay: "relay-onprem" },
			],
		}));

		const folderSettings = new SettingsScope<FolderNode>(
			settings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		await folderSettings.mutateValue((current) => ({
			...current,
			onpremServerId: "server-b",
		}));

		const items = settings.snapshot().sharedFolders ?? [];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			guid,
			path: "Notes/Shared2",
			relay: "relay-onprem",
			onpremServerId: "server-b",
		});
	});
});

describe("SettingsScope.mutateValue() persists across a reload (restart), not just in-memory", () => {
	test("a value written via mutateValue() is present in a freshly-loaded Settings instance backed by the same storage", async () => {
		const storage = new SerializingStorageAdapter<Root>();

		const beforeRestart = new Settings<Root>(storage, {});
		await beforeRestart.hydrate();

		const guid = "folder-guid-restart";
		const folderSettings = new SettingsScope<FolderNode>(
			beforeRestart as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		await folderSettings.mutateValue((current) => ({
			...current,
			guid,
			path: "Notes/Persisted",
			onpremServerId: "server-b",
		}));

		// Simulate an Obsidian restart: a brand-new Settings instance reading
		// from the same underlying storage, with no in-memory state carried
		// over from `beforeRestart` at all.
		const afterRestart = new Settings<Root>(storage, {});
		await afterRestart.hydrate();

		const items = afterRestart.snapshot().sharedFolders ?? [];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			guid,
			path: "Notes/Persisted",
			onpremServerId: "server-b",
		});
	});
});
