/**
 * Unit tests: VaultShare._onReady's sync-timeout gate
 *
 * Before this fix: a 30s `onceFreshlySynced()` timeout was caught, logged,
 * and swallowed -- `adoptLocalFiles()` ran exactly as if sync had succeeded,
 * minting fresh guids for any local file it didn't already know about. That
 * is indistinguishable, at that moment, from "another client already
 * published a guid for this path and I just haven't received it yet"
 *. After this fix: a timeout still lets `_onReady` proceed
 * (so an already-known folder doesn't get stuck forever), but it tells
 * `adoptLocalFiles()` not to mint -- via the `allowMint` argument, which this
 * test asserts on directly rather than driving the full file-processing
 * pipeline (that's `mintGate.test.ts`'s job; this test is only about
 * whether `_onReady()` correctly computes and passes the flag).
 *
 * Duck-typed via `Object.create(VaultShare.prototype)` -- `_onReady()` is a
 * real prototype method (unlike `adoptLocalFiles`, an arrow-function instance
 * property, which is why it's stubbed directly here rather than exercised),
 * matching the existing convention in documentCanvasLiveOnpremServerId.test.ts:
 * a full construction needs the entire vault/IndexedDB/relay machinery this
 * test has no interest in.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { VaultShare } from "../src/VaultShare";

function makeFakeVaultShare(overrides: Record<string, unknown> = {}) {
	const fake = Object.create(VaultShare.prototype);
	Object.assign(fake, {
		isTornDown: false,
		path: "test-folder",
		isAuthority: false,
		freshlyCreated: false,
		_wantsConnection: true,
		awaitSynced: jest.fn(async () => {}),
		adoptLocalFiles: jest.fn(async () => {}),
		scanFileTree: jest.fn(async () => {}),
		folderIndex: {},
		awaitFolderTreeReady: jest.fn(async () => true),
		...overrides,
	});
	return fake as unknown as {
		adoptLocalFiles: jest.Mock;
		onceFreshlySynced: jest.Mock;
	};
}

describe("VaultShare._onReady() sync-timeout gate", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("sync confirmed before the timeout -- adoptLocalFiles() is called with allowMint=true", async () => {
		const fake = makeFakeVaultShare({
			onceFreshlySynced: jest.fn(async () => {}), // resolves immediately
		});

		await (fake as unknown as { _onReady(): Promise<void> })._onReady();

		expect(fake.adoptLocalFiles).toHaveBeenCalledTimes(1);
		expect(fake.adoptLocalFiles).toHaveBeenCalledWith(true);
	});

	test("RED shape -- sync never confirms: adoptLocalFiles() MUST be called with allowMint=false, not with mint left implicitly allowed", async () => {
		const fake = makeFakeVaultShare({
			onceFreshlySynced: jest.fn(() => new Promise<void>(() => {})), // never resolves
		});

		const readyPromise = (fake as unknown as { _onReady(): Promise<void> })._onReady();
		await jest.advanceTimersByTimeAsync(30000);
		await readyPromise;

		expect(fake.adoptLocalFiles).toHaveBeenCalledTimes(1);
		// The pre-fix behavior this test would catch a regression into: the
		// timeout was caught and swallowed, and adoptLocalFiles() ran with no
		// argument at all (defaulting to allowMint=true) -- i.e. exactly as
		// if sync had succeeded. Asserting the explicit `false` here fails
		// on that shape.
		expect(fake.adoptLocalFiles).toHaveBeenCalledWith(false);
	});

	test("wantsConnection=false skips the sync wait entirely and still allows minting (unaffected by this fix)", async () => {
		const fake = makeFakeVaultShare({
			_wantsConnection: false,
			onceFreshlySynced: jest.fn(() => {
				throw new Error("must not be called when _wantsConnection is false");
			}),
		});

		await (fake as unknown as { _onReady(): Promise<void> })._onReady();

		expect(fake.adoptLocalFiles).toHaveBeenCalledWith(true);
	});

	test("freshlyCreated=true + sync never confirms: adoptLocalFiles() is STILL called with allowMint=true", async () => {
		// freshlyCreated is true ONLY at the call sites that construct a
		// VaultShare moments after this client's own createShare() call
		// minted the guid -- nobody else could yet know the share exists, so
		// there is no disjoint-guid collision to protect
		// against. Before this fix, a freshly created folder share's own
		// files were deferred forever whenever the first onceFreshlySynced()
		// happened to miss the 30s window, exactly the reported symptom of a
		// new share whose content never leaves the vault.
		const fake = makeFakeVaultShare({
			freshlyCreated: true,
			onceFreshlySynced: jest.fn(() => new Promise<void>(() => {})), // never resolves
		});

		const readyPromise = (fake as unknown as { _onReady(): Promise<void> })._onReady();
		await jest.advanceTimersByTimeAsync(30000);
		await readyPromise;

		expect(fake.adoptLocalFiles).toHaveBeenCalledTimes(1);
		expect(fake.adoptLocalFiles).toHaveBeenCalledWith(true);
	});

	test(" regression -- isAuthority=true but freshlyCreated=false (the loadRelayOnPremShares() migrate-path shape) MUST NOT bypass the gate", async () => {
		// loadRelayOnPremShares()'s "migrate" recreate path (guid mismatch or
		// missing workspaceId on an existing local record) also constructs a
		// VaultShare with isAuthority=true, for its own unrelated
		// hasPendingUpdates()/awaitReady() reasons -- but that share may have
		// been published elsewhere by ANOTHER client under a guid this
		// device hasn't learned yet. An earlier version of this fix bypassed
		// the mint gate on bare `isAuthority`, which reopened exactly the
		// disjoint-guid race this gate exists to prevent for that
		// path (caught in review, not shipped). freshlyCreated staying false
		// here is what keeps that path protected.
		const fake = makeFakeVaultShare({
			isAuthority: true,
			freshlyCreated: false,
			onceFreshlySynced: jest.fn(() => new Promise<void>(() => {})), // never resolves
		});

		const readyPromise = (fake as unknown as { _onReady(): Promise<void> })._onReady();
		await jest.advanceTimersByTimeAsync(30000);
		await readyPromise;

		expect(fake.adoptLocalFiles).toHaveBeenCalledTimes(1);
		expect(fake.adoptLocalFiles).toHaveBeenCalledWith(false);
	});
});
