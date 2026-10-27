/**
 * A client restarted offline after a peer deleted a note must delete its copy
 * on reconnect, not publish "(relay deleted …)" copies of it.
 *
 * The provider seeds the user mapping into a document before the document
 * opens its local store, so those first changes were never stored. After a
 * restart the stored history starts past them, Yjs keeps every later change
 * of that client pending, and the note reads as empty. The delete cleanup
 * took that for an unsynced edit and wrote recovery copies, and the
 * vault-create handler then shared the copies with every peer.
 */
import "fake-indexeddb/auto";
import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";
import { FolderIndex } from "../src/FolderIndex";
import { makeDocumentRecord } from "../src/ItemKinds";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { createPermanentUserData } from "../src/permanentUserData";
import { hasHistoryGap } from "../src/preserveBeforeTrash";
import * as toggleState from "../src/featureToggleState";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";

type DeleteOp = { filePath: string; completion: Promise<unknown> };

const TEXT = "offline-restart\n";

/** A note document as a running client builds it: identity first, then the store, then content. */
async function writeNote(name: string): Promise<void> {
	const doc = new Y.Doc();
	createPermanentUserData(doc).setUserMapping(doc, doc.clientID, "account-b");
	const store = new LocalDocumentStore(name, doc);
	await store.whenSynced;
	doc.getMap("meta").set("initClaim", { clientID: doc.clientID });
	doc.getText("contents").insert(0, TEXT);
	await new Promise((r) => window.setTimeout(r, 50));
	await store.destroy();
}

/** What the next start of the app sees for that note, before any server contact. */
async function reopenNote(name: string): Promise<Y.Doc> {
	const doc = new Y.Doc();
	createPermanentUserData(doc).setUserMapping(doc, doc.clientID, "account-b");
	const store = new LocalDocumentStore(name, doc);
	await store.whenSynced;
	return doc;
}

/** A doc whose own early changes never reached local storage. */
function docWithGap(): Y.Doc {
	const author = new Y.Doc();
	createPermanentUserData(author).setUserMapping(author, author.clientID, "account-b");
	const before = Y.encodeStateVector(author);
	author.getText("contents").insert(0, TEXT);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(author, before));
	return doc;
}

class Client {
	doc = new Y.Doc();
	index: FolderIndex;
	files: TFile[] = [];
	trashed: string[] = [];
	copies: string[] = [];
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
			vaultFilesInScope: () => this.files,
			readContents: async () => TEXT,
			vaultApi: {
				adapter: {
					write: async (path: string) => {
						this.copies.push(path);
					},
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

	/** A synced note, tracked by a document rebuilt from `crdtDoc`, whose stored sync base is `base`. */
	addNote(vpath: string, crdtDoc: Y.Doc, base: string | undefined): void {
		const file: TFile = Object.create(TFile.prototype);
		file.path = `${this.folder}/${vpath}`;
		this.files.push(file);
		this.index.put(vpath, makeDocumentRecord(`guid-${vpath}`));
		const note = Object.create(Document.prototype) as Document;
		Object.assign(note, {
			entryPath: vpath,
			entityGuid: `guid-${vpath}`,
			crdtDoc,
			getSyncBase: async () => base,
		});
		(this.share as unknown as { trackedEntries: Map<string, Document> }).trackedEntries.set(
			note.entityGuid,
			note,
		);
	}

	prune(): DeleteOp[] {
		const prune = (this.share as unknown as {
			pruneUntrackedFiles(remotePaths: string[], diffLog: string[]): DeleteOp[];
		}).pruneUntrackedFiles.bind(this.share);
		return prune([], []);
	}
}

/** The peer's delete reaches this client: the note's record is gone from the shared index. */
function deleteRemotely(client: Client, vpath: string): void {
	const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(client.doc));
	peer.getMap("filemeta_v0").delete(vpath);
	peer.getMap("docs").delete(vpath);
	Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(peer));
}

describe("offline restart after a remote delete", () => {
	test("a note's local history survives a restart without the server", async () => {
		const name = `note-${Math.random()}`;
		await writeNote(name);

		const restarted = await reopenNote(name);

		expect(hasHistoryGap(restarted)).toBe(false);
		expect(restarted.getText("contents").toString()).toBe(TEXT);
	});

	test("a store that only ever saw the identity seed stays as small as before", async () => {
		const name = `seed-only-${Math.random()}`;
		const doc = new Y.Doc();
		createPermanentUserData(doc).setUserMapping(doc, doc.clientID, "account-b");
		const store = new LocalDocumentStore(name, doc);
		await store.whenSynced;
		await store.destroy();

		const again = new LocalDocumentStore(name, new Y.Doc());
		await again.whenSynced;
		expect(again._dbsize).toBe(0);
		expect(again.holdsContent()).toBe(false);
	});

	test("a note rebuilt from a history with a gap is deleted, not copied", async () => {
		const client = new Client("TRDEL");
		client.addNote("rst.md", docWithGap(), TEXT);
		deleteRemotely(client, "rst.md");

		const ops = client.prune();
		await Promise.all(ops.map((op) => op.completion));

		expect(ops.map((op) => op.filePath)).toEqual(["rst.md"]);
		expect(client.trashed).toEqual(["TRDEL/rst.md"]);
		expect(client.copies).toEqual([]);
	});

	test("with a gap and no stored sync base the note is kept as a local copy", async () => {
		const client = new Client("TRDEL");
		client.addNote("rst.md", docWithGap(), undefined);
		deleteRemotely(client, "rst.md");

		await Promise.all(client.prune().map((op) => op.completion));

		expect(client.copies).toHaveLength(1);
		expect(client.trashed).toEqual(["TRDEL/rst.md"]);
	});

	test("an edit made after the last sync is still kept as a copy", async () => {
		const client = new Client("TRDEL");
		client.addNote("rst.md", docWithGap(), "older synced text\n");
		deleteRemotely(client, "rst.md");

		await Promise.all(client.prune().map((op) => op.completion));

		expect(client.copies).toHaveLength(1);
		expect(client.copies[0]).toMatch(/^TRDEL\/rst \(relay deleted .*\)\.md$/);
		expect(client.trashed).toEqual(["TRDEL/rst.md"]);
	});

	test("a canvas rebuilt from a history with a gap is kept as a local copy", async () => {
		const toggles = toggleState.currentToggles();
		jest.spyOn(toggleState, "currentToggles").mockReturnValue({ ...toggles, enableCanvasSync: true });
		const client = new Client("TRDEL");
		const file: TFile = Object.create(TFile.prototype);
		file.path = "TRDEL/board.canvas";
		client.files.push(file);
		client.index.put("board.canvas", makeDocumentRecord("guid-board"));
		const canvas = Object.create(CanvasDocument.prototype) as CanvasDocument;
		Object.assign(canvas, { entryPath: "board.canvas", entityGuid: "guid-board", crdtDoc: docWithGap() });
		(client.share as unknown as { trackedEntries: Map<string, CanvasDocument> }).trackedEntries.set(
			"guid-board",
			canvas,
		);
		Object.assign(client.share, {
			readContents: async () => JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "x" }], edges: [] }),
		});
		deleteRemotely(client, "board.canvas");

		await Promise.all(client.prune().map((op) => op.completion));

		expect(client.copies).toHaveLength(1);
		expect(client.trashed).toEqual(["TRDEL/board.canvas"]);
		jest.restoreAllMocks();
	});

	test("overlapping tree scans write one copy, not one per scan", async () => {
		const client = new Client("TRDEL");
		const doc = new Y.Doc();
		doc.getText("contents").insert(0, "older synced text\n");
		client.addNote("rst.md", doc, undefined);
		deleteRemotely(client, "rst.md");

		const first = client.prune();
		const second = client.prune();
		await Promise.all([...first, ...second].map((op) => op.completion));

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
		expect(client.copies).toHaveLength(1);
	});

	test("a recovery copy written into the share is never published", async () => {
		const client = new Client("TRDEL");
		const claimPaths = jest.fn(() => ["rst (relay deleted 2026-10-26T23-11-08-645Z).md"]);
		const publishFile = jest.fn();
		Object.assign(client.share, { claimPaths, publishFile });
		const copy: TFile = Object.create(TFile.prototype);
		copy.path = "TRDEL/rst (relay deleted 2026-10-26T23-11-08-645Z).md";

		await client.share.claimAndUploadFile(copy);

		expect(claimPaths).not.toHaveBeenCalled();
		expect(publishFile).not.toHaveBeenCalled();
		expect([...client.doc.getMap("filemeta_v0").keys()]).toEqual([]);
	});

	describe("restart with the server reachable", () => {
		/** B synced `gone.md`, was closed, a peer deleted it, B starts again online. */
		function restartedAfterDelete(): { client: Client; file: TFile; claimPaths: jest.Mock } {
			const client = new Client("TRDEL");
			client.addNote("gone.md", new Y.Doc(), TEXT);
			Object.assign(client.share, { knownBeforeSync: new Set(["gone.md"]) });
			(client.share as unknown as { trackedEntries: Map<string, Document> }).trackedEntries.clear();
			deleteRemotely(client, "gone.md");
			const claimPaths = jest.fn(() => [] as string[]);
			Object.assign(client.share, { claimPaths, publishFile: jest.fn() });
			return { client, file: client.files[0], claimPaths };
		}

		test("the old copy of a note deleted meanwhile is not uploaded again", async () => {
			const { client, file, claimPaths } = restartedAfterDelete();

			await client.share.claimAndUploadFile(file);
			await Promise.all(client.prune().map((op) => op.completion));

			expect(claimPaths).not.toHaveBeenCalled();
			expect(client.trashed).toEqual(["TRDEL/gone.md"]);
			expect(client.copies).toEqual([]);
		});

		test("a note created again at that path afterwards is uploaded", async () => {
			const { client, file, claimPaths } = restartedAfterDelete();
			await Promise.all(client.prune().map((op) => op.completion));
			Object.assign(client.share, { awaitReady: async () => client.share, entryFor: jest.fn() });

			await client.share.claimAndUploadFile(file);

			expect(claimPaths).toHaveBeenCalledWith([file]);
		});

		test("a startup create event waits for the stored records before uploading", async () => {
			const client = new Client("TRDEL");
			const file: TFile = Object.create(TFile.prototype);
			file.path = "TRDEL/gone.md";
			client.files.push(file);
			let loaded = (): void => {};
			const publishFile = jest.fn();
			Object.assign(client.share, {
				_localDb: { synced: false, once: (_event: string, cb: () => void) => (loaded = cb) },
				claimPaths: jest.fn(() => (client.index.wasRemoved("gone.md") ? [] : [file])),
				claimUploadPaths: async () => ({ lost: [] }),
				publishFile,
				awaitReady: async () => client.share,
				entryFor: jest.fn(),
			});

			const upload = client.share.claimAndUploadFile(file);
			// The local store loads the synced record, then the peer's delete lands.
			client.index.put("gone.md", makeDocumentRecord("guid-gone.md"));
			loaded();
			await Promise.resolve();
			deleteRemotely(client, "gone.md");
			await upload;

			expect(publishFile).not.toHaveBeenCalled();
		});

		test("a new local note at a path deleted before this client ever saw it is uploaded", async () => {
			const { client, file, claimPaths } = restartedAfterDelete();
			Object.assign(client.share, {
				knownBeforeSync: new Set(),
				awaitReady: async () => client.share,
				entryFor: jest.fn(),
			});

			await client.share.claimAndUploadFile(file);

			expect(claimPaths).toHaveBeenCalledWith([file]);
		});
	});
});
