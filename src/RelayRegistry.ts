"use strict";

// RelayRegistry used to be built entirely around a PocketBase-backed DAO/Store
// layer (the hosted cloud backend) -- DAO interfaces mirroring PocketBase collections,
// a generic LiveCollection/Store graph, and one wrapper class per record type
// (RelayAuto, UserRecord, etc.), all populated via realtime subscriptions
// fired from a live `pb: PocketBase` client. That entire layer was removed as
// dead code: the plugin only ever ships relay-onprem mode
// (relayOnPrem.enabled defaults to true, with no UI path to turn it off), and
// AuthSession never constructs a PocketBase client in that mode -- `pb` was
// always `null` here, so `buildGraph()` always returned before building
// anything and `this.policyManager`/`this.store` were never assigned.
//
// What's kept: every externally-called method, each reproducing EXACTLY the
// behavior its PocketBase-gated body already had when `pb` was null -- a
// graceful no-op where the original short-circuited on `this.pb?.`, or the
// original thrown error message where it asserted `required(this.pb,
// "message")`. This is a pure dead-code removal: no external caller's
// observed behavior changes.
//
// The nine NotifierMap fields this comment used to describe as "kept
// shapes" (relays/users/providers/remoteFolders/relayInvitations/
// relayRoles/folderRoles/subscriptions/storageQuotas) were themselves
// removed as a second dead-code pass: nothing anywhere in the
// tree ever called `.set()`/`.delete()` on any of them, so they stayed
// permanently empty in the shipped build forever. Their readers cascaded:
// PolicyManager.ts's entire dependency-driven authorization engine was
// never constructed by anything and was removed in that same pass;
// `getCollectionMapByName()` existed only to feed it and is gone with it;
// the live UI/sync readers (SettingsPanel.svelte, VaultShare.ts,
// ViewBindings.ts) were each updated in place to reproduce the same
// always-empty behavior they already observed, without the pretense of a
// live collection behind it. (MemberInviteModalContent.svelte and
// PublishFolderModalContent.svelte, both named here originally, were
// themselves removed later as unreachable modules;
// OnPremSetupModalContent.svelte was itself removed later, along with
// `createSelfHostedRelay` -- the command it backed could
// never succeed against this dead layer.) `PolicyManager.ts` itself kept
// existing after that pass -- it still held `ObservablePermission`, the
// return type of this class's own `can()`/`userCan()` -- until those two
// methods were removed as dead code, at which point
// `PolicyManager.ts` had zero live importers left and was deleted whole
//.
// `roleCatalog` is the one map that is actually filled (two seeded rows,
// constructor below) and stays untouched.
import type { AuthSession } from "./AuthSession";
import {
	type FolderMembership,
	type WorkspaceUser,
	type RemoteFolderRecord,
	type RemoteFolderRecord as RemoteFolder,
	type AccessLevel,
} from "./RelayModel";
import { Loggable, instanceLabels } from "./logging";
import { NotifierMap } from "./notifiers/NotifierMap";
import type { Unsubscriber } from "./notifiers/Notifier";

/** Resolves a possibly-missing lookup, or throws `message` -- kept for the
 *  handful of methods below that reproduce their old `required(this.pb, ...)`
 *  throw verbatim (pb is always null, so these always threw this exact
 *  message; nothing downstream of them ever ran). */
function required<T>(value: T | null | undefined, message: string): T {
	if (value === undefined || value === null) {
		throw new Error(message);
	}
	return value;
}

/**
 * RelayRegistry -- the plugin-facing facade: owns every NotifierMap the
 * legacy "Relay" (as opposed to relay-onprem VaultShare) UI reads from.
 * All of them stay permanently empty in the shipped build, exactly as they
 * already did before this cleanup.
 */
export class RelayRegistry extends Loggable {
	_unsubscribeAuthChange: Unsubscriber;
	sessionUser?: unknown;
	disposed = false;
	roleCatalog: NotifierMap<string, { id: string; name: string }>;
	currentUser?: WorkspaceUser;

	constructor(private loginManager: AuthSession) {
		super();

		this.roleCatalog = new NotifierMap<string, { id: string; name: string }>("roles");
		const seedRoles = [
			{ id: "2arnubkcv7jpce8", name: "Owner" },
			{ id: "x6lllh2qsf9lxk6", name: "Member" },
		];
		seedRoles.forEach((role) => this.roleCatalog.put(role.id, role));

		// Subscribe to logout/login. Neither branch does anything observable
		// today (no PocketBase client to populate `this.currentUser` from), kept
		// only so a future non-PocketBase population path has somewhere to
		// hook in without re-wiring this subscription.
		this._unsubscribeAuthChange = this.loginManager.on(() => {
			if (!this.loginManager.isAuthenticated) {
				this.currentUser = undefined;
			}
		});

		instanceLabels.set(this, "Relay Manager");
	}

	/** No-op (see module doc comment) -- kept because main.ts calls this from
	 *  its own _onLogin() handler on every real login. */
	signIn(): void {}

	/** No-op (see module doc comment) -- kept because main.ts calls this from
	 *  its own _onLogout() handler on every real logout. */
	signOut(): void {
		this.currentUser = undefined;
	}

	/** No-op: the realtime-subscription layer this fed was never reachable
	 *  (see module doc comment) -- matches the original's behavior exactly,
	 *  it just no longer pretends to need a PocketBase session to check for. */
	watchRealtime(): void {
		this.warn("watchRealtime skipped -- relay-onprem mode has no legacy realtime layer");
	}

	/** No-op for the same reason as watchRealtime() -- kept because main.ts and
	 *  SettingsTab.ts call this on load/open. */
	async refresh(): Promise<void> {
		return Promise.resolve();
	}

	/** Reproduces the original verbatim: `this.pb?.collection(...).delete(...)`
	 *  short-circuited on the always-null `pb`, so this always returned
	 *  `true` without deleting anything server-side. */
	async discardRemoteFolder(_remoteFolder: RemoteFolderRecord): Promise<boolean> {
		return true;
	}

	async grantFolderRole(
		_folder: RemoteFolder,
		_userId: string,
		_roleName: AccessLevel,
	): Promise<FolderMembership> {
		return required<FolderMembership>(null, "Failed to add folder role");
	}

	async revokeFolderRole(_folderRole: FolderMembership): Promise<void> {
		required<void>(null, "Failed to remove folder role");
	}

	async changeFolderRole(
		_folderRole: FolderMembership,
		_roleName: AccessLevel,
	): Promise<FolderMembership> {
		return required<FolderMembership>(null, "Failed to update folder role");
	}

	async setFolderPrivacy(
		_folder: RemoteFolder,
		_isPrivate: boolean,
	): Promise<RemoteFolder> {
		return required<RemoteFolder>(null, "Failed to update folder privacy");
	}

	async patchRemoteFolder(
		_folder: RemoteFolderRecord,
		_updates: Partial<{ name: string; private: boolean }>,
	): Promise<RemoteFolderRecord> {
		return required<RemoteFolderRecord>(null, "Failed to update folder");
	}

	teardown(): void {
		this.disposed = true;
		this._unsubscribeAuthChange?.();
		this._unsubscribeAuthChange = null as unknown as Unsubscriber;
		this.loginManager = null as unknown as AuthSession;
		this.sessionUser = null;
	}
}
