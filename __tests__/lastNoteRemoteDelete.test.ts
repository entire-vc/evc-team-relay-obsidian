/**
 * Deleting the last note(s) of a share on one client must remove the file on
 * the other client too. pruneUntrackedFiles used to bail out on
 * any empty remote, which also protects a brand-new share's first snapshot,
 * so the confirmed last delete was never applied.
 *
 * Two peers share one server doc; each peer mounts the share under its own
 * local folder name and runs the real pruneUntrackedFiles against it.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { FolderIndex } from "../src/FolderIndex";
import { makeDocumentRecord, makeFolderRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";

type DeleteOp = { filePath: string; completion: Promise<unknown> };

class Peer {
	doc = new Y.Doc();
	index: FolderIndex;
	files: (TFile | TFolder)[] = [];
	trashed: string[] = [];
	share: VaultShare;

	constructor(public folder: string) {
		this.index = new FolderIndex(this.doc, folder, new Map(), {
			subscribe: () => () => {},
			isFileTypeAllowed: () => true,
		} as unknown as AttachmentSyncSettings);
		this.share = Object.create(VaultShare.prototype) as VaultShare;
		Object.assign(this.share, {
			path: folder,
			folderIndex: this.index,
			uploadClaims: new Map(),
			trackedEntries: new Map(),
			attachmentSettings: { isFileTypeAllowed: () => true },
			_liveProvider: { synced: true },
			_localDb: { synced: true },
			vaultFilesInScope: () => this.files.filter((f) => this.share.isSyncableVaultFile(f)),
			vaultApi: {
				adapter: {
					trashLocal: async (path: string) => {
						this.trashed.push(path);
						this.files = this.files.filter((f) => f.path !== path);
					},
				},
			},
			log: jest.fn(),
			warn: jest.fn(),
		});
	}

	/** A note (or folder, no extension) that exists on disk and in the shared index. */
	addSynced(vpath: string): void {
		this.addLocal(vpath);
		this.index.put(
			vpath,
			vpath.endsWith(".md") ? makeDocumentRecord(`guid-${vpath}`) : makeFolderRecord(`guid-${vpath}`),
		);
	}

	/** A note that exists only on disk. */
	addLocal(vpath: string): void {
		const path = `${this.folder}/${vpath}`;
		const node: TFile | TFolder = Object.create(
			(vpath.endsWith(".md") ? TFile : TFolder).prototype,
		);
		node.path = path;
		this.files.push(node);
	}

	/** A note present on disk because another peer synced it here. */
	materialize(vpath: string): void {
		this.addLocal(vpath);
	}

	deleteEverywhere(vpath: string): void {
		this.index.delete(vpath);
		this.files = this.files.filter((f) => f.path !== `${this.folder}/${vpath}`);
	}

	paths(): string[] {
		return this.files.map((f) => f.path.slice(this.folder.length + 1)).sort();
	}

	async prune(): Promise<string[]> {
		const prune = (this.share as unknown as {
			pruneUntrackedFiles(remotePaths: string[], diffLog: string[]): DeleteOp[];
		}).pruneUntrackedFiles.bind(this.share);
		const ops = prune([], []);
		await Promise.all(ops.map((op) => op.completion));
		return ops.map((op) => op.filePath).sort();
	}
}

function sync(...peers: Peer[]): void {
	for (const from of peers) {
		for (const to of peers) {
			if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc));
		}
	}
}

function pair(): [Peer, Peer] {
	return [new Peer("Team"), new Peer("Shared Notes")];
}

describe("remote delete of the last notes in a share", () => {
	test.each([
		["A to B", 0, 1],
		["B to A", 1, 0],
	])("last-file delete propagates %s", async (_label, deleter, receiver) => {
		const peers = pair();
		peers[0].addSynced("only.md");
		sync(...peers);
		peers[1].materialize("only.md");

		peers[deleter].deleteEverywhere("only.md");
		sync(...peers);

		expect(await peers[receiver].prune()).toEqual(["only.md"]);
		expect(peers[receiver].paths()).toEqual([]);
	});

	test.each([
		["A to B", 0, 1],
		["B to A", 1, 0],
	])("batch delete of every note and folder propagates %s", async (_label, deleter, receiver) => {
		const peers = pair();
		const entries = ["one.md", "two.md", "sub", "sub/three.md"];
		for (const vpath of entries) peers[0].addSynced(vpath);
		sync(...peers);
		for (const vpath of entries) peers[1].materialize(vpath);

		peers[deleter].doc.transact(() => {
			for (const vpath of entries) peers[deleter].deleteEverywhere(vpath);
		});
		sync(...peers);

		expect(await peers[receiver].prune()).toEqual([...entries].sort());
		expect(peers[receiver].paths()).toEqual([]);
	});

	test("a brand-new empty share keeps existing local notes", async () => {
		const [owner, member] = pair();
		owner.addLocal("draft.md");
		owner.addLocal("ideas");
		owner.addLocal("ideas/later.md");
		member.addLocal("own.md");
		sync(owner, member);

		expect(await owner.prune()).toEqual([]);
		expect(await member.prune()).toEqual([]);
		expect(owner.paths()).toEqual(["draft.md", "ideas", "ideas/later.md"]);
		expect(member.paths()).toEqual(["own.md"]);
	});

	test("an empty remote only deletes the notes it confirms were removed", async () => {
		const [a, b] = pair();
		a.addSynced("shared.md");
		sync(a, b);
		b.materialize("shared.md");
		b.addLocal("never-synced.md");

		a.deleteEverywhere("shared.md");
		sync(a, b);

		expect(await b.prune()).toEqual(["shared.md"]);
		expect(b.paths()).toEqual(["never-synced.md"]);
	});

	test("offline receiver applies the delete on reconnect and nothing returns after restart", async () => {
		const [a, b] = pair();
		a.addSynced("only.md");
		sync(a, b);
		b.materialize("only.md");

		// B is offline while A deletes: B still sees the note as shared.
		a.deleteEverywhere("only.md");
		expect(await b.prune()).toEqual([]);
		expect(b.paths()).toEqual(["only.md"]);

		// Reconnect.
		sync(a, b);
		expect(await b.prune()).toEqual(["only.md"]);
		expect(b.paths()).toEqual([]);

		// Restart: the persisted doc is replayed into a fresh client.
		const restarted = new Peer(b.folder);
		Y.applyUpdate(restarted.doc, Y.encodeStateAsUpdate(b.doc));
		sync(a, restarted);
		expect(await restarted.prune()).toEqual([]);
		expect(restarted.paths()).toEqual([]);
		expect([...restarted.doc.getMap("filemeta_v0").keys()]).toEqual([]);
		expect([...a.doc.getMap("filemeta_v0").keys()]).toEqual([]);
		expect(restarted.trashed.filter((p) => p.includes("conflict"))).toEqual([]);
	});

	test("a note re-created after the delete is not removed by the old tombstone", async () => {
		const [a, b] = pair();
		a.addSynced("only.md");
		sync(a, b);
		b.materialize("only.md");
		a.deleteEverywhere("only.md");
		sync(a, b);
		await b.prune();

		a.addSynced("only.md");
		sync(a, b);
		b.materialize("only.md");
		expect(b.index.wasRemoved("only.md")).toBe(false);
		expect(await b.prune()).toEqual([]);
		expect(b.paths()).toEqual(["only.md"]);
	});
});
