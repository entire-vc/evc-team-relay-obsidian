/**
 * M3 scenario driver: two completed syncs, a peer edit delivered to the file,
 * a local edit preserved as a conflict copy, on a disposable relay.
 *
 * Real: Document, ProviderBacked, YSweetProvider (real sockets),
 * LocalDocumentStore (fake-indexeddb), the sync base, TransferQueue.
 * pullIfUnchanged and preserveBeforeTrash (hasHistoryGap, noteCompletedSync).
 * Stand-ins, all external boundaries: the relay (DisposableRelay), the token
 * request, and the vault (plain files under the disposable root).
 *
 * The note starts in the field shape: a peer's complete text plus a writer's
 * later presence pushes whose seed reached nobody (a hole the relay lacks).
 */

import "fake-indexeddb/auto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { SystemClock } from "../../src/Clock";
import { Document } from "../../src/Document";
import { hasHistoryGap } from "../../src/preserveBeforeTrash";
import { YSweetProvider } from "../../src/client/provider";
import type { DocumentGrant } from "../../src/relay/TokenShapes";
import { TransferQueue } from "../../src/TransferQueue";
import { DisposableRelay } from "./DisposableRelay";
import {
	assertDisposableEndpoint,
	assertDisposablePath,
	createDisposableRoot,
	installNetworkGuard,
	removeDisposableRoot,
} from "./isolation";

export interface M3Fixture {
	/** Vault-relative note path. */
	entryPath: string;
	/** The last text this client and the relay agreed on. */
	agreedText: string;
	/** Appended by the peer after that. */
	peerAppend: string;
	/** An edit on disk the client never uploaded; omit for none. */
	localEdit?: string;
}

/** Synthetic, anonymised fixture: develops and proves the tool without any private text. */
export const SYNTHETIC_FIXTURE: M3Fixture = {
	entryPath: "synthetic/m3-note.md",
	agreedText: "M3 synthetic note\nagreed line one\n",
	peerAppend: "peer line added after the last agreed sync\n",
	localEdit: "local line that never reached the relay\n",
};

/** What leaves the run: no note text, only sizes and short digests. */
const fingerprint = (text: string) => ({
	chars: text.length,
	sha256_8: createHash("sha256").update(text).digest("hex").slice(0, 8),
});

export interface M3Result {
	pullOutcomes: string[];
	completedSyncs: number;
	relayUpgrades: number;
	vaultBefore: ReturnType<typeof fingerprint>;
	vaultAfter: ReturnType<typeof fingerprint>;
	expectedAfter: ReturnType<typeof fingerprint>;
	vaultAfterEqualsPeerText: boolean;
	conflictCopies: Array<ReturnType<typeof fingerprint>>;
	conflictCopyKeepsLocalEdit: boolean;
	/** The relay's text, for the in-process assertions only; never goes into a receipt. */
	_relayText: string;
}

function seedIdentity(doc: Y.Doc): Y.Array<number> {
	const user = new Y.Map<unknown>();
	user.set("ids", new Y.Array<number>());
	user.set("ds", new Y.Array<Uint8Array>());
	doc.getMap("users").set("ghost-account", user);
	const ids = user.get("ids") as Y.Array<number>;
	ids.push([doc.clientID]);
	return ids;
}

/** A doc holding the agreed text and the ghost's later pushes, the seed lost everywhere. */
function lostSeedHistory(agreedText: string): Y.Doc {
	const peer = new Y.Doc();
	peer.getText("contents").insert(0, agreedText);
	const ghost = new Y.Doc();
	const ids = seedIdentity(ghost);
	const held = new Y.Doc();
	Y.applyUpdate(held, Y.encodeStateAsUpdate(peer));
	for (let i = 1; i <= 3; i++) {
		const before = Y.encodeStateVector(ghost);
		ids.push([ghost.clientID + i]);
		Y.applyUpdate(held, Y.encodeStateAsUpdate(ghost, before));
	}
	return held;
}

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

export async function runM3Scenario(
	fixture: M3Fixture,
	opts: { grantUrlOverride?: string; vaultPathOverride?: string; maxPulls?: number } = {},
): Promise<M3Result> {
	const root = createDisposableRoot();
	const relay = new DisposableRelay(randomBytes(12).toString("hex"));
	let restoreNetwork: (() => void) | undefined;
	let peerProvider: YSweetProvider | undefined;
	let doc: Document | undefined;
	try {
		await relay.start();
		restoreNetwork = installNetworkGuard(relay.origin);

		// A new id per run: the local store (fake-indexeddb) outlives a run inside one process.
		const guid = randomUUID();
		// The sync code swallows a failed token request as a failed connect; a
		// refused endpoint must still stop the run, so it is kept and rethrown.
		let violation: unknown;
		const grant = (): DocumentGrant => {
			// Checked before the provider ever sees the url: a bad endpoint never connects.
			const url = opts.grantUrlOverride ?? relay.origin;
			try {
				assertDisposableEndpoint(url, relay.origin);
			} catch (e) {
				violation = e;
				throw e;
			}
			return { token: relay.token, url, docId: guid, expiryTime: Date.now() + 3_600_000 } as DocumentGrant;
		};

		// The relay holds the field shape; the client holds it without the peer's edit.
		// One history, applied to both: separate builds would be two writers' inserts of the same text.
		const history = Y.encodeStateAsUpdate(lostSeedHistory(fixture.agreedText));
		Y.applyUpdate(relay.room(guid), history);
		const peerDoc = new Y.Doc();
		peerProvider = new YSweetProvider(relay.origin, guid, peerDoc, { connect: false, params: { token: relay.token }, disableBc: true });
		peerProvider.connect();
		await until("the peer's first sync", () => peerProvider!.synced);
		const peerText = peerDoc.getText("contents");
		peerText.insert(peerText.length, fixture.peerAppend);
		await until("the peer edit at the relay", () => relay.room(guid).getText("contents").toString() === fixture.agreedText + fixture.peerAppend);
		peerProvider.destroy();
		peerProvider = undefined;
		// The peer's own connection is setup, not part of what is counted.
		const peerSyncs = relay.completedSyncs.get(guid) ?? 0;
		const peerUpgrades = relay.upgrades;
		const expectedAfter = fixture.agreedText + fixture.peerAppend;

		const vaultFile = (rel: string) => assertDisposablePath(root, path.join(opts.vaultPathOverride ?? "vault", rel));
		const writeVault = (rel: string, content: string) => {
			const target = vaultFile(rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		};
		const initial = fixture.agreedText + (fixture.localEdit ?? "");
		writeVault(fixture.entryPath, initial);
		const conflictCopies: string[] = [];

		const queue = new TransferQueue({} as never, new SystemClock(), {} as never);
		queue.enqueueUpload = async () => undefined; // a pull never pushes; the upload lane is outside this scenario
		const trackedEntries = new Map<string, Document>();
		const credentialCache = { peekToken: () => undefined, dropFromQueue: () => {}, getToken: async () => grant() };
		const share = {
			workspaceId: "relay-m3",
			entityGuid: "11111111-1111-4111-8111-111111111111",
			isOnline: true,
			path: "notes",
			hostAppId: "m3",
			config: { onpremServerId: undefined },
			vaultApi: {},
			unsavedStore: {},
			wantsConnection: true,
			resourceAddress: {},
			bringOnline: async () => true,
			trackedEntries,
			transfers: queue,
			folderIndex: { tracks: () => true },
			awaitSynced: async () => {},
			subscribe: () => () => {},
			noteUploaded: async () => {},
			isDeletePending: () => false,
			toVaultFile: () => null,
			hasFile: async () => true,
			docActivity: { subscribeRemote: () => () => {} },
			credentialCache,
			readContents: async () => fs.readFileSync(vaultFile(fixture.entryPath), "utf8"),
			writeContents: async (_d: unknown, content: string) => writeVault(fixture.entryPath, content),
			writeConflictCopy: async (_d: unknown, content: string) => {
				const copy = fixture.entryPath.replace(/\.md$/, ` (relay conflict ${conflictCopies.length + 1}).md`);
				writeVault(copy, content);
				conflictCopies.push(content);
				return copy;
			},
		};
		doc = new Document(
			fixture.entryPath,
			guid,
			{ getCurrentUserForServer: () => undefined, on: () => () => {} } as never,
			share as never,
		);
		await doc.awaitFirstSync();
		Y.applyUpdate(doc.crdtDoc, history);
		await doc.setSyncBase(fixture.agreedText);
		if (!hasHistoryGap(doc.crdtDoc)) throw new Error("fixture did not produce a seed hole");
		trackedEntries.set(guid, doc);

		// Pull until the text lands, never more than a few connections: the hole is
		// accepted as lost only after completed syncs on two distinct connections.
		const outcomes: string[] = [];
		for (let attempt = 0; attempt < (opts.maxPulls ?? 4); attempt++) {
			outcomes.push((await queue.pullIfUnchanged(doc)).outcome);
			if (violation !== undefined) throw violation;
			if (fs.readFileSync(vaultFile(fixture.entryPath), "utf8") !== initial) break;
		}
		const after = fs.readFileSync(vaultFile(fixture.entryPath), "utf8");
		return {
			pullOutcomes: outcomes,
			completedSyncs: (relay.completedSyncs.get(guid) ?? 0) - peerSyncs,
			relayUpgrades: relay.upgrades - peerUpgrades,
			vaultBefore: fingerprint(initial),
			vaultAfter: fingerprint(after),
			expectedAfter: fingerprint(expectedAfter),
			vaultAfterEqualsPeerText: after === expectedAfter,
			conflictCopies: conflictCopies.map(fingerprint),
			conflictCopyKeepsLocalEdit: fixture.localEdit === undefined ? conflictCopies.length === 0 : conflictCopies.includes(initial),
			_relayText: relay.room(guid).getText("contents").toString(),
		};
	} finally {
		// Each step on its own: a failed teardown must not leave the guard installed.
		try {
			peerProvider?.destroy();
			doc?.dismantle();
		} finally {
			restoreNetwork?.();
			await relay.stop();
			removeDisposableRoot(root);
		}
	}
}
