/**
 * Unit test: ShareRegistry._dedupeByPath() prefers a candidate with a valid
 * guid over one without, when the same path appears more than once in
 * persisted settings.
 *
 * The bug: the old path-only dedupe kept the FIRST record it saw at a given
 * path (only overriding it when a later record had `relay` set and the
 * kept one didn't). It never looked at guid validity at all. A `data.json`
 * already triplicated by the class -- one corrupt entry with no
 * guid, one phantom entry with the literal string guid "undefined", one
 * genuinely valid entry -- has `relay` set on all three, so the old dedupe
 * always kept the FIRST (invalid) one. The restore guard then
 * correctly refused that single candidate, and the folder never came back
 * at all: not "reduced to 2 stale records" (what that MR's own commit
 * message documented for a freshly-triplicating single corrupt input), but
 * a full, silent loss of the share, because the one valid record two slots
 * later was never even offered to the guard.
 *
 * This test exercises the real ShareRegistry.restore() (dedupe + guard +
 * factory call) with a minimal fake Vault/shareFactory/persistedShares --
 * not a reimplementation of the dedupe logic, so it actually proves the
 * integration.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { ShareRegistry, type VaultShareSettings } from "../src/VaultShare";
import { TFolder } from "./mocks/obsidian";

// _restoreFrom() resolves each entry's folder via resolveShareFolder(), which
// calls vault.getAbstractFileByPath() (or getRoot() for a root share's `""`
// path) -- not getFolderByPath() directly, and does a real `instanceof
// TFolder` check, so the fixtures need actual TFolder instances, not
// duck-typed plain objects. None of these fixtures use a root path, so
// getRoot() is never exercised here (see vaultRootPath.test.ts for that);
// it's still provided so a real Vault-shaped object is passed.
function makeVault(existingPaths: string[]) {
	return {
		getAbstractFileByPath: (path: string) =>
			existingPaths.includes(path) ? new TFolder(path) : null,
		getRoot: () => new TFolder("/"),
	};
}

const VALID_GUID = "0eab9783-d0b2-431e-abd1-f59ceeef5419";

describe("ShareRegistry.restore() -- dedupe prefers a valid guid", () => {
	test("an already-triplicated data.json (broken, phantom-undefined, valid -- in that order) restores from the valid record, not zero times", () => {
		const shareFactory = jest.fn(
			(
				path: string,
				guid: string,
				workspaceId?: string,
				hasPendingUpdates?: boolean,
				isRestore?: boolean,
				freshlyCreated?: boolean,
			) =>
				({ path, entityGuid: guid }) as never,
		);
		// The exact live-repro shape, in the order it's
		// actually written to disk: corrupt entry first, phantom
		// "undefined"-string second, the real valid entry last. All three
		// carry `relay`, so the OLD dedupe (relay-presence only) always kept
		// entry 1 regardless of what came after it.
		const persistedShares = {
			readValue: (): VaultShareSettings[] => [
				{
					path: "already-triplicated-folder",
					relay: "fmt-test",
					guidBROKEN: "should-never-be-read",
				} as unknown as VaultShareSettings,
				{ path: "already-triplicated-folder", guid: "undefined", relay: "fmt-test" },
				{ path: "already-triplicated-folder", guid: VALID_GUID, relay: "relay-onprem" },
			],
		};

		const registry = new ShareRegistry(
			{} as never,
			makeVault(["already-triplicated-folder"]) as never,
			shareFactory,
			persistedShares as never,
		);
		registry.restore();

		expect(shareFactory).toHaveBeenCalledTimes(1);
		expect(shareFactory).toHaveBeenCalledWith(
			"already-triplicated-folder",
			VALID_GUID,
			"relay-onprem",
			undefined,
			true,
			undefined,
		);
	});

	test("among two candidates with EQUALLY valid guids, relay-presence still breaks the tie (pre-existing behavior preserved)", () => {
		const shareFactory = jest.fn(
			(
				path: string,
				guid: string,
				workspaceId?: string,
				hasPendingUpdates?: boolean,
				isRestore?: boolean,
				freshlyCreated?: boolean,
			) =>
				({ path, entityGuid: guid }) as never,
		);
		const otherValidGuid = "22222222-2222-4222-8222-222222222222";
		const persistedShares = {
			readValue: (): VaultShareSettings[] => [
				{ path: "folder", guid: otherValidGuid }, // no relay -- comes first
				{ path: "folder", guid: VALID_GUID, relay: "fmt-test" }, // relay set -- should win
			],
		};

		const registry = new ShareRegistry(
			{} as never,
			makeVault(["folder"]) as never,
			shareFactory,
			persistedShares as never,
		);
		registry.restore();

		expect(shareFactory).toHaveBeenCalledTimes(1);
		expect(shareFactory).toHaveBeenCalledWith("folder", VALID_GUID, "fmt-test", undefined, true, undefined);
	});

	test("among two candidates with EQUALLY invalid guids, dedupe still resolves to exactly one (refused by the guard, not a crash)", () => {
		const shareFactory = jest.fn(
			(
				path: string,
				guid: string,
				workspaceId?: string,
				hasPendingUpdates?: boolean,
				isRestore?: boolean,
				freshlyCreated?: boolean,
			) =>
				({ path, entityGuid: guid }) as never,
		);
		const persistedShares = {
			readValue: (): VaultShareSettings[] => [
				{ path: "folder", guid: "undefined", relay: "a" },
				{ path: "folder", guid: "" as unknown as string, relay: "b" },
			],
		};

		const registry = new ShareRegistry(
			{} as never,
			makeVault(["folder"]) as never,
			shareFactory,
			persistedShares as never,
		);
		registry.restore();

		expect(shareFactory).not.toHaveBeenCalled();
	});
});
