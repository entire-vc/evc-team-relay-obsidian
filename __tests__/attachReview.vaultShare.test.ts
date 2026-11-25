/**
 * GH #114: attaching a local folder to a shared folder that
 * already exists on the server. Before the fix, the first sync let every
 * differing local note replace the shared note for everyone (local wins,
 * the server text survived only as a "(relay conflict ...)" copy).
 *
 * These tests drive the real `VaultShare.prototype` methods against an
 * in-memory vault and real Y.Docs standing in for the relay's text:
 *
 *   - `_reconcileNewDoc()` / `claimAndUploadFile()`: the ordinary attach
 *     path. While the folder is held, neither may upload or fetch. On 0.1.37
 *     (d4739c3) `_reconcileNewDoc()` enqueues an upload for every unsynced
 *     note, so the gate test fails there on behaviour, not on a missing
 *     module (the new hook is looked up tolerantly).
 *   - `runAttachReview()`: the check itself, with a scripted dialog.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as Y from "yjs";
import { TFile, TFolder } from "./mocks/obsidian";
import * as VaultShareModule from "../src/VaultShare";
import { VaultShare } from "../src/VaultShare";
import { Document } from "../src/Document";
import { TransferQueue } from "../src/TransferQueue";
import { ItemKind } from "../src/ItemKinds";
import { FolderIndex } from "../src/FolderIndex";
import { isConflictCopyPath } from "../src/conflictCopyPath";

type Choice = "keep-both" | "keep-server" | "keep-local" | "cancel";

interface Model {
	folderName: string;
	count: number;
	paths: string[];
	more: number;
	canKeepLocal: boolean;
	backupFolder: string;
}

interface FakeUi {
	progress: jest.Mock;
	offline: jest.Mock;
	decide: jest.Mock<(share: unknown, model: Model, entry: string) => Promise<Choice>>;
	finished: jest.Mock<(share: unknown, summary: string | null) => void>;
	cancelled: jest.Mock<(share: unknown, entry: string) => void>;
}

const setUi = (ui: FakeUi | null) =>
	(VaultShareModule as unknown as { setAttachReviewUi?: (ui: unknown) => void }).setAttachReviewUi?.(ui);

/** One note as the test sets it up: on disk and/or on the server. */
interface NoteSpec {
	path: string;
	local?: string;
	server?: string;
}

const FOLDER = "Projects";

/** The spec's AC1 input: 3 differing, 1 equal, 1 equal up to CRLF, 1 local-only, 1 server-only. */
const AC1_NOTES: NoteSpec[] = [
	{ path: "a.md", local: "local a\n", server: "server a\n" },
	{ path: "notes/b.md", local: "local b\n", server: "server b\n" },
	{ path: "c.md", local: "local c\n", server: "server c\n" },
	{ path: "same.md", local: "same text\n", server: "same text\n" },
	{ path: "crlf.md", local: "line one\r\nline two\r\n", server: "line one\nline two\n" },
	{ path: "local-only.md", local: "only here\n" },
	{ path: "server-only.md", server: "only on the server\n" },
];

function makeVault(
	failWrite: (path: string) => boolean = () => false,
	failRead: (path: string) => boolean = () => false,
) {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const writes: string[] = [];
	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		read: async (p: string) => {
			if (failRead(p)) throw new Error(`EBUSY ${p}`);
			const text = files.get(p);
			if (text === undefined) throw new Error(`ENOENT ${p}`);
			return text;
		},
		write: async (p: string, text: string) => {
			if (failWrite(p)) throw new Error(`EACCES ${p}`);
			writes.push(p);
			files.set(p, text);
		},
		mkdir: async (p: string) => {
			folders.add(p);
		},
	};
	return { files, folders, writes, adapter };
}

function makeDoc(guid: string, vpath: string, serverText: string, acked = false) {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, serverText);
	let updates = 0;
	ydoc.on("update", () => updates++);
	let base: string | undefined;
	let serverAcked = acked;
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "entityGuid", { value: guid });
	Object.defineProperty(doc, "entryPath", { value: vpath });
	Object.defineProperty(doc, "path", { value: vpath });
	Object.defineProperty(doc, "crdtDoc", { value: ydoc });
	Object.defineProperty(doc, "content", { get: () => ydoc.getText("contents").toJSON() });
	Object.defineProperty(doc, "editLock", { value: false });
	Object.defineProperty(doc, "_liveProvider", { value: { ws: null } });
	Object.defineProperty(doc, "obsidianFile", { value: null, writable: true });
	Object.defineProperty(doc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(doc, "getServerAcked", { value: async () => serverAcked });
	Object.defineProperty(doc, "markServerAcked", {
		value: async () => {
			serverAcked = true;
		},
	});
	Object.defineProperty(doc, "getSyncBase", { value: async () => base });
	Object.defineProperty(doc, "setSyncBase", {
		value: async (text: string) => {
			base = text;
		},
	});
	Object.defineProperty(doc, "dismantle", { value: () => {} });
	return { doc, ydoc, updates: () => updates, base: () => base };
}

interface HeldShareOptions {
	notes: NoteSpec[];
	entry?: "manual" | "auto" | null;
	authorization?: "full" | "read-only";
	failWrite?: (path: string) => boolean;
	failRead?: (path: string) => boolean;
	root?: boolean;
}

function makeHeldShare(opts: HeldShareOptions) {
	const sharePath = opts.root ? "" : FOLDER;
	const vault = makeVault(opts.failWrite, opts.failRead);
	const abs = (vpath: string) => (sharePath ? `${sharePath}/${vpath}` : vpath);
	const docs = new Map<string, ReturnType<typeof makeDoc>>();
	const guids = new Map<string, string>();
	const tfiles: TFile[] = [];
	opts.notes.forEach((note, i) => {
		if (note.local !== undefined) {
			vault.files.set(abs(note.path), note.local);
			const tfile = new TFile(abs(note.path));
			tfile.stat.size = note.local.length;
			tfiles.push(tfile);
		}
		if (note.server !== undefined) {
			const guid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
			guids.set(note.path, guid);
			docs.set(note.path, makeDoc(guid, note.path, note.server));
		}
	});
	// The note's file on disk, as Document.obsidianFile resolves it.
	for (const tfile of tfiles) {
		const vpath = sharePath ? tfile.path.slice(sharePath.length + 1) : tfile.path;
		const d = docs.get(vpath);
		if (d) (d.doc as unknown as { obsidianFile: TFile }).obsidianFile = tfile;
	}
	vault.writes.length = 0;

	const uploads: string[] = [];
	const fetches: string[] = [];
	const queue = Object.create(TransferQueue.prototype) as TransferQueue;
	Object.defineProperty(queue, "withRelayConnection", {
		value: async (_doc: unknown, fn: () => Promise<unknown>) => fn(),
	});
	Object.defineProperty(queue, "log", { value: () => {} });
	Object.defineProperty(queue, "warn", { value: () => {} });
	Object.defineProperty(queue, "readRelayText", {
		value: async (doc: Document) => doc.content,
	});
	Object.defineProperty(queue, "enqueueUpload", {
		value: async (doc: Document) => {
			uploads.push(doc.entryPath);
		},
	});
	Object.defineProperty(queue, "enqueueFetch", {
		value: async (doc: Document) => {
			fetches.push(doc.entryPath);
		},
	});

	let config: Record<string, unknown> = { guid: "f", path: sharePath, attachReview: "pending" };
	const share = Object.create(VaultShare.prototype) as VaultShare;
	const define = (key: string, value: unknown) =>
		Object.defineProperty(share, key, { value, writable: true, configurable: true });
	define("path", sharePath);
	define("workspaceId", "relay-onprem");
	define("isTornDown", false);
	define("attachEntry", opts.entry === undefined ? "manual" : opts.entry);
	define("vaultApi", { adapter: vault.adapter, getName: () => "Vault" });
	define("transfers", queue);
	define("trackedEntries", new Map());
	define("uploadClaims", new Map());
	define("deletedEntries", new Set());
	define("isDeletePending", () => false);
	define("requirePath", () => {});
	define("pathSet", { include: () => {}, update: () => {} });
	define("credentialCache", {
		peekToken: () => ({ authorization: opts.authorization ?? "full" }),
	});
	define("resourceAddress", { namespace: "tr", relayGuid: "relay-onprem" });
	define("log", () => {});
	define("warn", () => {});
	define("debug", () => {});
	define("error", () => {});
	define("awaitFolderTreeReady", async () => true);
	define("onceFreshlySynced", async () => {});
	define("recordsBeforeSync", async () => new Map());
	define("adoptableFiles", () => tfiles);
	define("folderIndex", {
		guidFor: (vpath: string) => guids.get(vpath),
		recordFor: (vpath: string) => (guids.has(vpath) ? { type: ItemKind.Document } : undefined),
		isSyncable: () => true,
		eachRecord: (cb: (meta: { id: string; type: string }, path: string) => void) =>
			guids.forEach((id, path) => cb({ id, type: ItemKind.Document }, path)),
	});
	define("ensureDoc", (_guid: string, vpath: string) => docs.get(vpath)!.doc);
	define("_config", {
		readValue: () => config,
		mutateValue: async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
			config = fn(config);
		},
	});

	const ydocUpdates = () => [...docs.values()].reduce((n, d) => n + d.updates(), 0);
	return {
		share,
		vault,
		docs,
		abs,
		uploads,
		fetches,
		ydocUpdates,
		config: () => config,
	};
}

type Internals = {
	runAttachReview?(freshlySynced: boolean): Promise<boolean>;
	_reconcileNewDoc(doc: Document): Promise<void>;
	claimAndUploadFile(tfile: TFile): unknown;
	isSyncableVaultFile?(tfile: TFile): boolean;
	attachHeld?: boolean;
};

function makeUi(choices: Choice[] = []): FakeUi {
	const queue = [...choices];
	return {
		progress: jest.fn(),
		offline: jest.fn(),
		decide: jest.fn<(share: unknown, model: Model, entry: string) => Promise<Choice>>(() => {
			const next = queue.shift();
			// No scripted answer: the user has not decided yet.
			return next === undefined ? new Promise<Choice>(() => {}) : Promise.resolve(next);
		}),
		finished: jest.fn<(share: unknown, summary: string | null) => void>(),
		cancelled: jest.fn<(share: unknown, entry: string) => void>(),
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Starts the check; resolves once it has finished or is waiting on the dialog. */
async function startCheck(share: VaultShare): Promise<{ result: boolean | undefined }> {
	const internals = share as unknown as Internals;
	const state: { result: boolean | undefined } = { result: undefined };
	expect(typeof internals.runAttachReview).toBe("function");
	void internals.runAttachReview!(true).then((r) => {
		state.result = r;
	});
	await settle();
	return state;
}

const DIFFERING = ["a.md", "c.md", "notes/b.md"];

beforeEach(() => setUi(null));

describe("attach check: the gate (AC1)", () => {
	test("3 differ, 1 equal, 1 equal up to CRLF, 1 local-only, 1 server-only: held, nothing written, dialog gets N=3", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = makeHeldShare({ notes: AC1_NOTES });
		const internals = h.share as unknown as Internals;

		// The ordinary attach path while the folder is held: no upload, no fetch.
		for (const { doc } of h.docs.values()) await internals._reconcileNewDoc(doc);
		await settle();
		expect(h.uploads).toEqual([]);
		expect(h.fetches).toEqual([]);

		const state = await startCheck(h.share);

		expect(state.result).toBeUndefined(); // waiting for the decision
		expect(h.vault.writes).toEqual([]);
		expect(h.ydocUpdates()).toBe(0);
		expect(h.uploads).toEqual([]);
		expect(h.fetches).toEqual([]);
		expect(ui.decide).toHaveBeenCalledTimes(1);
		const model = ui.decide.mock.calls[0][1];
		expect(model.count).toBe(3);
		expect(model.paths).toEqual(DIFFERING);
		expect(model.more).toBe(0);
		expect(model.folderName).toBe(FOLDER);
		expect(model.backupFolder).toMatch(/^Team Relay backups\/Projects \d{4}-\d{2}-\d{2} \d{2}-\d{2}$/);
		expect(internals.attachHeld).toBe(true);
	});

	test("control: 0 differences -> no dialog, the folder connects", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = makeHeldShare({ notes: AC1_NOTES.filter((n) => !DIFFERING.includes(n.path)) });

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		expect(ui.decide).not.toHaveBeenCalled();
		expect(ui.finished).toHaveBeenCalledWith(h.share, null);
		expect((h.share as unknown as Internals).attachHeld).toBe(false);
		expect(h.config().attachReview).toBeUndefined();
		expect(h.vault.writes).toEqual([]);
		expect(h.ydocUpdates()).toBe(0);
		// Equal notes are recorded as agreed, so a later edit is not a conflict.
		expect(h.docs.get("crlf.md")!.base()).toBe("line one\nline two\n");
	});
});

function differingShare(extra: Partial<HeldShareOptions> = {}) {
	return makeHeldShare({
		notes: AC1_NOTES.filter((n) => DIFFERING.includes(n.path)),
		...extra,
	});
}

const serverOf = (p: string) => AC1_NOTES.find((n) => n.path === p)!.server!;
const localOf = (p: string) => AC1_NOTES.find((n) => n.path === p)!.local!;

describe("attach check: the three choices on 3 differing notes (AC2)", () => {
	test("keep both: shared note = server, disk = server, 3 local copies next to the notes", async () => {
		setUi(makeUi(["keep-both"]));
		const h = differingShare();

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		for (const p of DIFFERING) {
			expect(h.docs.get(p)!.doc.content).toBe(serverOf(p));
			expect(h.vault.files.get(h.abs(p))).toBe(serverOf(p));
		}
		const copies = h.vault.writes.filter((w) => !DIFFERING.map(h.abs).includes(w));
		expect(copies).toHaveLength(3);
		for (const copy of copies) {
			expect(isConflictCopyPath(copy)).toBe(true);
			expect(copy.startsWith("Team Relay backups/")).toBe(false);
		}
		expect(copies.map((c) => h.vault.files.get(c)).sort()).toEqual(DIFFERING.map(localOf).sort());
		expect(h.ydocUpdates()).toBe(0);
	});

	test("keep server: Y.Doc unchanged, disk = server, 3 local texts in backup, 0 copies next to the notes", async () => {
		setUi(makeUi(["keep-server"]));
		const h = differingShare();

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		expect(h.ydocUpdates()).toBe(0);
		for (const p of DIFFERING) expect(h.vault.files.get(h.abs(p))).toBe(serverOf(p));
		const backups = h.vault.writes.filter((w) => w.startsWith("Team Relay backups/"));
		expect(backups).toHaveLength(3);
		for (const p of DIFFERING) {
			const backup = backups.find((b) => b.endsWith(`/${p}`))!;
			expect(h.vault.files.get(backup)).toBe(localOf(p));
		}
		expect(h.vault.writes.filter((w) => isConflictCopyPath(w))).toEqual([]);
	});

	test("keep local: Y.Doc = local text, 3 server texts in backup, disk unchanged", async () => {
		setUi(makeUi(["keep-local"]));
		const h = differingShare();

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		for (const p of DIFFERING) {
			expect(h.docs.get(p)!.doc.content).toBe(localOf(p));
			expect(h.vault.files.get(h.abs(p))).toBe(localOf(p));
		}
		const backups = h.vault.writes.filter((w) => w.startsWith("Team Relay backups/"));
		expect(backups).toHaveLength(3);
		for (const p of DIFFERING) {
			const backup = backups.find((b) => b.endsWith(`/${p}`))!;
			expect(h.vault.files.get(backup)).toBe(serverOf(p));
		}
	});

	test.each(["keep-server", "keep-local"] as const)(
		"fail closed (%s): the backup write fails -> nothing overwritten on disk or in the Y.Doc, folder stays held",
		async (choice) => {
			const ui = makeUi([choice]);
			setUi(ui);
			const h = differingShare({ failWrite: (p) => p.startsWith("Team Relay backups/") });

			const state = await startCheck(h.share);

			expect(state.result).toBeUndefined();
			for (const p of DIFFERING) {
				expect(h.vault.files.get(h.abs(p))).toBe(localOf(p));
				expect(h.docs.get(p)!.doc.content).toBe(serverOf(p));
				expect(h.docs.get(p)!.base()).toBeUndefined();
			}
			expect(h.ydocUpdates()).toBe(0);
			expect((h.share as unknown as Internals).attachHeld).toBe(true);
			// The summary names the untouched notes, and the same 3 are offered again.
			const summary = ui.finished.mock.calls[0][1];
			expect(summary).toContain("not changed, the copy could not be saved");
			expect(summary).not.toContain("saved to");
			expect(ui.decide).toHaveBeenCalledTimes(2);
			expect(ui.decide.mock.calls[1][1].paths).toEqual(DIFFERING);
			expect(h.uploads).toEqual([]);
		},
	);

	test("fail closed (keep both): the local copy cannot be written -> the note is not overwritten", async () => {
		setUi(makeUi(["keep-both"]));
		const h = differingShare({ failWrite: (p) => isConflictCopyPath(p) });

		await startCheck(h.share);

		for (const p of DIFFERING) expect(h.vault.files.get(h.abs(p))).toBe(localOf(p));
		expect(h.ydocUpdates()).toBe(0);
	});
});

describe("attach check: controls (AC1, AC3)", () => {
	test("restart of an already synced folder (serverAcked = true): no hold, no dialog, no upload", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = differingShare({ entry: null });
		const internals = h.share as unknown as Internals;
		for (const d of h.docs.values()) await d.doc.markServerAcked();

		expect(internals.attachHeld).toBe(false);
		expect(await internals.runAttachReview!(true)).toBe(true);
		for (const { doc } of h.docs.values())
			await internals._reconcileNewDoc(doc);
		await settle();
		expect(internals.attachHeld).toBe(false);
		expect(ui.decide).not.toHaveBeenCalled();
		expect(ui.offline).not.toHaveBeenCalled();
		expect(h.uploads).toEqual([]);
	});

	test("attach where every note was already agreed on this device (serverAcked + sync base): no dialog", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = differingShare();
		for (const d of h.docs.values()) {
			await d.doc.markServerAcked();
			await d.doc.setSyncBase(d.doc.content);
		}

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		expect(ui.decide).not.toHaveBeenCalled();
		expect(h.vault.writes).toEqual([]);
	});

	test("a file created in the folder during the hold is not uploaded", async () => {
		setUi(makeUi());
		const h = differingShare();
		const internals = h.share as unknown as Internals;
		const recordsBeforeSync = jest.fn(async () => new Map());
		Object.defineProperty(h.share, "recordsBeforeSync", { value: recordsBeforeSync });

		await startCheck(h.share);
		const byCheck = recordsBeforeSync.mock.calls.length;
		await internals.claimAndUploadFile(new TFile(`${FOLDER}/new during hold.md`));

		// The upload path never got as far as reading the index.
		expect(recordsBeforeSync).toHaveBeenCalledTimes(byCheck);
		expect(h.uploads).toEqual([]);
		expect(internals.attachHeld).toBe(true);
	});
});

describe("attach check: a note that cannot be read from disk", () => {
	test("held, no dialog, nothing written: a read failure is not an empty note", async () => {
		const ui = makeUi(["keep-local"]);
		setUi(ui);
		const h = differingShare({ failRead: (p) => p.endsWith("/a.md") });

		const state = await startCheck(h.share);

		expect(state.result).toBeUndefined();
		expect(ui.decide).not.toHaveBeenCalled();
		expect(ui.offline).toHaveBeenCalledWith(h.share);
		expect(h.vault.writes).toEqual([]);
		expect(h.ydocUpdates()).toBe(0);
		expect((h.share as unknown as Internals).attachHeld).toBe(true);
	});
});

describe("attach check: cancel and auto-connect (AC3)", () => {
	test("Cancel: the folder is not connected, disk and Y.Doc unchanged", async () => {
		const ui = makeUi(["cancel"]);
		setUi(ui);
		const h = differingShare();

		const state = await startCheck(h.share);

		expect(state.result).toBe(false);
		expect(ui.cancelled).toHaveBeenCalledWith(h.share, "manual");
		expect(h.vault.writes).toEqual([]);
		expect(h.ydocUpdates()).toBe(0);
		expect(h.uploads).toEqual([]);
	});

	test("auto-connect with differences: held behind the Review notice, 0 uploads and 0 fetches before the decision", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = differingShare({ entry: "auto" });
		const internals = h.share as unknown as Internals;

		await startCheck(h.share);
		for (const { doc } of h.docs.values()) await internals._reconcileNewDoc(doc);
		await settle();

		expect(ui.decide).toHaveBeenCalledWith(h.share, expect.anything(), "auto");
		expect(h.uploads).toEqual([]);
		expect(h.fetches).toEqual([]);
		expect(h.vault.writes).toEqual([]);
		expect(internals.attachHeld).toBe(true);
	});
});

describe("attach check: write access (AC5)", () => {
	test("a read-only token: keep local is not offered, and is refused if chosen anyway", async () => {
		const ui = makeUi(["keep-local"]);
		setUi(ui);
		const h = differingShare({ authorization: "read-only" });

		const state = await startCheck(h.share);

		expect(ui.decide.mock.calls[0][1].canKeepLocal).toBe(false);
		expect(state.result).toBe(false);
		for (const p of DIFFERING) expect(h.docs.get(p)!.doc.content).toBe(serverOf(p));
		expect(h.vault.writes).toEqual([]);
	});

	test("a full token: keep local is offered", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = differingShare({ authorization: "full" });

		await startCheck(h.share);

		expect(ui.decide.mock.calls[0][1].canKeepLocal).toBe(true);
	});
});

describe("backup folder never syncs (AC4)", () => {
	test.each([
		["a shared folder", false],
		["the vault root", true],
	])("%s: files inside 'Team Relay backups/' are not syncable and not uploaded", async (_label, root) => {
		const h = makeHeldShare({ notes: [], entry: null, root });
		const internals = h.share as unknown as Internals;
		const recordsBeforeSync = jest.fn(async () => {});
		Object.defineProperty(h.share, "recordsBeforeSync", { value: recordsBeforeSync });
		Object.defineProperty(h.share, "attachmentSettings", { value: { isFileTypeAllowed: () => true } });
		const backup = new TFile("Team Relay backups/Projects 2026-11-25 13-00/a.md");
		const folder = new TFile("Team Relay backups");
		// Positive control: an ordinary note of the same share is syncable.
		const note = new TFile(root ? "a.md" : "Projects/a.md");

		expect(internals.isSyncableVaultFile?.(note)).toBe(true);
		expect(internals.isSyncableVaultFile?.(backup)).toBe(false);
		expect(internals.isSyncableVaultFile?.(folder)).toBe(false);
		await internals.claimAndUploadFile(backup);
		expect(recordsBeforeSync).not.toHaveBeenCalled();
		expect(h.uploads).toEqual([]);
	});
});

/** A dialog the test answers when it chooses to. */
function deferredUi() {
	let answer: (choice: Choice) => void = () => {};
	const ui = makeUi();
	ui.decide.mockImplementation(
		() =>
			new Promise<Choice>((resolve) => {
				answer = resolve;
			}),
	);
	return { ui, answer: (choice: Choice) => answer(choice) };
}

describe("attach check edge cases and fail-closed invariants", () => {
	test("an empty server note is a difference: dialog, nothing uploaded or written before the decision", async () => {
		const ui = makeUi();
		setUi(ui);
		const h = makeHeldShare({
			notes: [{ path: "cleared.md", local: "old local text", server: "" }],
		});

		const state = await startCheck(h.share);

		expect(state.result).toBeUndefined();
		expect(ui.decide).toHaveBeenCalledTimes(1);
		expect((ui.decide.mock.calls[0][1] as Model).paths).toEqual(["cleared.md"]);
		expect(h.uploads).toEqual([]);
		expect(h.vault.writes).toEqual([]);
		expect((h.share as unknown as Internals).attachHeld).toBe(true);
	});

	test("an empty server note, keep local: the local text becomes the shared note", async () => {
		setUi(makeUi(["keep-local"]));
		const h = makeHeldShare({
			notes: [{ path: "cleared.md", local: "old local text", server: "" }],
		});

		const state = await startCheck(h.share);

		expect(state.result).toBe(true);
		expect(h.docs.get("cleared.md")!.doc.content).toBe("old local text");
		expect(h.uploads).toEqual([]);
	});

	describe("a folder restored without the pending flag (any entry point)", () => {
		/** Past the pause a barrier-started check takes before comparing. */
		async function settleTrips(): Promise<void> {
			await new Promise((resolve) => setTimeout(resolve, 350));
			await settle();
		}

		function restored() {
			const { ui, answer } = deferredUi();
			setUi(ui);
			const h = differingShare({ entry: null });
			// Restored after an earlier attach finished: no pending flag in the settings.
			void (
				h.share as unknown as {
					_config: {
						mutateValue(
							fn: (c: Record<string, unknown>) => Record<string, unknown>,
						): Promise<void>;
					};
				}
			)._config.mutateValue((c) => {
				const rest = { ...c };
				delete rest.attachReview;
				return rest;
			});
			expect(h.config().attachReview).toBeUndefined();
			Object.defineProperty(h.share, "scanFileTree", {
				value: jest.fn(async () => {}),
			});
			Object.defineProperty(h.share, "_scheduleUploadRetry", {
				value: jest.fn(),
			});
			return { h, ui, answer, internals: h.share as unknown as Internals };
		}

		test("3 notes the server tracks, never acked here: held, dialog with N=3, 0 uploads", async () => {
			const { h, ui, internals } = restored();

			for (const { doc } of h.docs.values())
				await internals._reconcileNewDoc(doc);
			await settleTrips();

			expect(h.uploads).toEqual([]);
			expect(internals.attachHeld).toBe(true);
			expect(h.config().attachReview).toBe("pending");
			expect(ui.decide).toHaveBeenCalledTimes(1);
			expect((ui.decide.mock.calls[0][1] as Model).count).toBe(3);
			expect(ui.decide.mock.calls[0][2]).toBe("auto");
		});

		test("after keep server the hold is released and nothing is uploaded over the shared notes", async () => {
			const { h, answer, internals } = restored();
			for (const { doc } of h.docs.values())
				await internals._reconcileNewDoc(doc);
			await settleTrips();

			answer("keep-server");
			await settleTrips();

			expect(internals.attachHeld).toBe(false);
			expect(h.config().attachReview).toBeUndefined();
			for (const p of DIFFERING)
				expect(h.vault.files.get(`${FOLDER}/${p}`)).toBe(serverOf(p));
			expect(h.uploads).toEqual([]);
		});

		test("only the notes that tripped the hold are compared: acked notes without a sync base stay out (N=1)", async () => {
			const { h, ui, internals } = restored();
			// Synced on this device before sync bases existed: acked, no base, local edits allowed.
			await h.docs.get("c.md")!.doc.markServerAcked();
			await h.docs.get("notes/b.md")!.doc.markServerAcked();

			for (const { doc } of h.docs.values()) await internals._reconcileNewDoc(doc);
			await settleTrips();

			expect(ui.decide).toHaveBeenCalledTimes(1);
			expect((ui.decide.mock.calls[0][1] as Model).paths).toEqual(["a.md"]);
			expect(h.uploads).toEqual([]);
		});

		test("a tripped note the folder scan does not offer is still compared, and settles: no second hold", async () => {
			const { h, ui, answer, internals } = restored();
			Object.defineProperty(h.share, "adoptableFiles", { value: () => [] });

			for (const { doc } of h.docs.values()) await internals._reconcileNewDoc(doc);
			await settleTrips();
			expect((ui.decide.mock.calls[0][1] as Model).count).toBe(3);

			answer("keep-both");
			await settleTrips();

			expect(internals.attachHeld).toBe(false);
			expect(ui.decide).toHaveBeenCalledTimes(1);
			expect(h.uploads).toEqual([]);
		});

		test("positive control: a note this device minted (upload claim) is uploaded, no hold", async () => {
			const { h, ui, internals } = restored();
			const claims = (
				h.share as unknown as { uploadClaims: Map<string, string> }
			).uploadClaims;
			claims.set("a.md", "guid");

			await internals._reconcileNewDoc(h.docs.get("a.md")!.doc);
			await settleTrips();

			expect(h.uploads).toEqual(["a.md"]);
			expect(internals.attachHeld).toBe(false);
			expect(ui.decide).not.toHaveBeenCalled();
		});

		test("positive control: a folder created on this device uploads as before", async () => {
			const { h, ui, internals } = restored();
			Object.defineProperty(h.share, "freshlyCreated", { value: true });

			for (const { doc } of h.docs.values())
				await internals._reconcileNewDoc(doc);
			await settleTrips();

			expect(h.uploads.sort()).toEqual([...DIFFERING].sort());
			expect(internals.attachHeld).toBe(false);
			expect(ui.decide).not.toHaveBeenCalled();
		});
	});

	describe("server moves wait for the choice", () => {
		function withRealTreeBarrier(entry: "manual" | null = "manual") {
			const { ui, answer } = deferredUi();
			setUi(ui);
			const h = differingShare({ entry });
			const applyServerMoves = jest.fn(async () => {});
			const define = (key: string, value: unknown) =>
				Object.defineProperty(h.share, key, {
					value,
					writable: true,
					configurable: true,
				});
			define(
				"awaitFolderTreeReady",
				(VaultShare.prototype as unknown as Record<string, unknown>)
					.awaitFolderTreeReady,
			);
			define("awaitSynced", async () => {});
			define("applyServerMoves", applyServerMoves);
			define("refreshServerMoveRemnants", () => {});
			const treeReady = () =>
				(
					h.share as unknown as { awaitFolderTreeReady(): Promise<boolean> }
				).awaitFolderTreeReady();
			return { h, ui, answer, applyServerMoves, treeReady };
		}

		test("held: the startup tree barrier does not apply moves before the decision, then does", async () => {
			const { h, answer, applyServerMoves, treeReady } = withRealTreeBarrier();

			const state = await startCheck(h.share);
			let ready: boolean | undefined;
			void treeReady().then((r) => (ready = r)); // what _onSynced() starts at construction
			await settle();

			expect(state.result).toBeUndefined();
			expect(applyServerMoves).not.toHaveBeenCalled();
			expect(ready).toBeUndefined();

			answer("keep-both");
			await settle();

			expect(applyServerMoves).toHaveBeenCalledTimes(1);
			expect(ready).toBe(true);
			expect(state.result).toBe(true);
		});

		test("cancel: moves never run and the barrier reports the folder is gone", async () => {
			const { h, answer, applyServerMoves, treeReady } = withRealTreeBarrier();

			await startCheck(h.share);
			let ready: boolean | undefined;
			void treeReady().then((r) => (ready = r));
			await settle();
			answer("cancel");
			await settle();

			expect(applyServerMoves).not.toHaveBeenCalled();
			expect(ready).toBe(false);
		});

		test("positive control: not held, the barrier applies moves at once", async () => {
			const { h, applyServerMoves, treeReady } = withRealTreeBarrier(null);
			void h;

			expect(await treeReady()).toBe(true);
			expect(applyServerMoves).toHaveBeenCalledTimes(1);
		});

		test("applyServerMoves itself leaves the disk alone while held", async () => {
			const h = differingShare();
			const renames: string[] = [];
			const source = new TFile(`${FOLDER}/old.md`);
			const define = (key: string, value: unknown) =>
				Object.defineProperty(h.share, key, {
					value,
					writable: true,
					configurable: true,
				});
			define("folderIndex", {
				eachRecord: (
					cb: (meta: { id: string; type: string }, path: string) => void,
				) => cb({ id: "doc-guid", type: ItemKind.Document }, "new.md"),
			});
			define("vaultApi", {
				adapter: h.vault.adapter,
				getAbstractFileByPath: (p: string) =>
					p === source.path
						? source
						: p === FOLDER
							? new TFolder(FOLDER)
							: null,
			});
			define("vaultFilesInScope", () => []);
			define("_ensureParentDir", async () => {});
			define("fileOps", {
				renameFile: async (_f: TFile, to: string) => void renames.push(to),
			});
			const applyServerMoves = (
				persisted: Map<string, { id: string; type: string }>,
			) =>
				(
					h.share as unknown as { applyServerMoves(p: unknown): Promise<void> }
				).applyServerMoves(persisted);
			const persisted = new Map([
				["old.md", { id: "doc-guid", type: ItemKind.Document }],
			]);

			await applyServerMoves(persisted);
			expect(renames).toEqual([]);

			// Positive control: once the folder is not held, the same move is followed.
			Object.defineProperty(h.share, "attachEntry", {
				value: null,
				writable: true,
			});
			await applyServerMoves(persisted);
			expect(renames).toEqual([`${FOLDER}/new.md`]);
		});
	});
});

describe("relay reads for the check need a sync of the current connection", () => {
	function relayDoc(provider: {
		synced: boolean;
		once(event: string, fn: () => void): void;
	}) {
		const ydoc = new Y.Doc();
		ydoc.getText("contents").insert(0, "stale relay text");
		const doc = Object.create(Document.prototype) as Document;
		const define = (key: string, value: unknown) =>
			Object.defineProperty(doc, key, {
				value,
				writable: true,
				configurable: true,
			});
		define("entryPath", "note.md");
		define("crdtDoc", ydoc);
		define("editLock", false);
		// Synced on an earlier connection: the sticky flag a stale read relied on.
		define("_providerSynced", true);
		define("_liveProvider", provider);
		define("awaitFirstSync", async () => {});
		define("bringOnline", async () => true);
		define("goOffline", () => {});
		Object.defineProperty(doc, "connectionIntent", {
			get: () => "disconnected",
		});
		Object.defineProperty(doc, "content", {
			get: () => ydoc.getText("contents").toJSON(),
		});
		const queue = Object.create(TransferQueue.prototype) as TransferQueue;
		Object.defineProperty(queue, "clock", {
			value: {
				scheduleTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
			},
		});
		Object.defineProperty(queue, "log", { value: () => {} });
		Object.defineProperty(queue, "warn", { value: () => {} });
		return { doc, ydoc, queue };
	}

	test("offline reconnect: null, never the previous connection's text", async () => {
		jest.useFakeTimers();
		try {
			const { doc, queue } = relayDoc({ synced: false, once: () => {} });
			let result: string | null | undefined;
			void queue.readRelayText(doc).then((r) => (result = r));
			await jest.advanceTimersByTimeAsync(31_000);
			expect(result).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});

	test("positive control: a sync that lands now returns the current relay text", async () => {
		jest.useFakeTimers();
		try {
			const listeners: Array<() => void> = [];
			const provider = {
				synced: false,
				once: (event: string, fn: () => void) => {
					if (event === "synced") listeners.push(fn);
				},
			};
			const { doc, ydoc, queue } = relayDoc(provider);
			let result: string | null | undefined;
			void queue.readRelayText(doc).then((r) => (result = r));
			await jest.advanceTimersByTimeAsync(10);
			const text = ydoc.getText("contents");
			text.delete(0, text.length);
			text.insert(0, "current relay text");
			provider.synced = true;
			for (const fn of listeners) fn();
			await jest.advanceTimersByTimeAsync(5_000);
			expect(result).toBe("current relay text");
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("a server move that brings a note onto a tracked path", () => {
	/**
	 * The relay moved a note (or its folder) while this device was away: the
	 * persisted index knows it at `from`, the synced index at `to`, and the
	 * disk still has it at `from`. Real FolderIndex, tree barrier and move
	 * code; the file system is in memory.
	 */
	function moved(opts: {
		server: string;
		folderMove?: boolean;
		entry?: "manual" | null;
		agreed?: boolean;
		stationary?: { path: string; local: string; server: string }[];
		failWrite?: (path: string) => boolean;
	}) {
		const { ui, answer } = deferredUi();
		setUi(ui);
		const from = opts.folderMove ? "drafts/note.md" : "old.md";
		const to = opts.folderMove ? "archive/note.md" : "new.md";
		const stationary = opts.stationary ?? [];
		const h = makeHeldShare({
			entry: opts.entry,
			failWrite: opts.failWrite,
			notes: [
				...stationary,
				{ path: from, local: "local text" },
				{ path: to, server: opts.server },
			],
		});
		const share = h.share as unknown as Record<string, unknown>;
		const define = (key: string, value: unknown) =>
			Object.defineProperty(h.share, key, { value, writable: true, configurable: true });
		const tfiles = (share.adoptableFiles as () => TFile[])();
		const tfile = tfiles.find((f) => f.path === `${FOLDER}/${from}`)!;
		const root = new TFolder(FOLDER);
		const localPaths = new Map<string, TFile | TFolder>([[root.path, root]]);
		for (const f of tfiles) {
			if (f === tfile) continue;
			root.children.push(f);
			localPaths.set(f.path, f);
		}
		if (opts.folderMove) {
			const drafts = new TFolder(`${FOLDER}/drafts`, [tfile]);
			root.children.push(drafts);
			localPaths.set(drafts.path, drafts);
		} else {
			root.children.push(tfile);
		}
		localPaths.set(tfile.path, tfile);
		// The server note keeps the guid the persisted index knew at `from`.
		const guid = h.docs.get(to)!.doc.entityGuid;
		const idoc = new Y.Doc();
		const records = idoc.getMap("filemeta_v0");
		for (const note of stationary) {
			records.set(note.path, {
				id: h.docs.get(note.path)!.doc.entityGuid,
				type: ItemKind.Document,
				version: 0,
			});
		}
		records.set(to, { id: guid, type: ItemKind.Document, version: 0 });
		if (opts.folderMove) records.set("archive", { id: "folder-guid", type: ItemKind.Folder, version: 0 });
		const index = Object.create(FolderIndex.prototype);
		Object.assign(index, {
			records,
			stagedWrites: new Map(),
			stagedDeletes: new Set(),
			aliases: new Map(),
			mintedGuids: new Map(),
			flatIdMap: idoc.getMap("docs"),
			scopePath: FOLDER,
		});
		define("folderIndex", index);
		const persisted = new Map<string, { id: string; type: string }>([[from, { id: guid, type: ItemKind.Document }]]);
		if (opts.folderMove) persisted.set("drafts", { id: "folder-guid", type: ItemKind.Folder });
		define("recordsBeforeSync", async () => persisted);
		define("awaitFolderTreeReady", (VaultShare.prototype as unknown as Record<string, unknown>).awaitFolderTreeReady);
		define("awaitSynced", async () => {});
		define("refreshServerMoveRemnants", () => {});
		define("_ensureParentDir", async () => {});
		define("scanFileTree", jest.fn(async () => {}));
		define("_scheduleUploadRetry", jest.fn());
		define("vaultApi", {
			adapter: h.vault.adapter,
			getAbstractFileByPath: (p: string) => localPaths.get(p) ?? null,
			getName: () => "Vault",
		});
		const renames: string[] = [];
		const relocate = (file: TFile | TFolder, path: string) => {
			localPaths.delete(file.path);
			if (file instanceof TFile) {
				const text = h.vault.files.get(file.path)!;
				h.vault.files.delete(file.path);
				h.vault.files.set(path, text);
			}
			file.path = path;
			localPaths.set(path, file);
			if (file instanceof TFolder) for (const child of file.children) relocate(child, `${path}/${child.name}`);
		};
		define("fileOps", {
			renameFile: async (file: TFile | TFolder, path: string) => {
				renames.push(path);
				relocate(file, path);
			},
		});
		if (opts.entry === null) {
			void (share._config as { mutateValue(fn: (c: Record<string, unknown>) => Record<string, unknown>): Promise<void> }).mutateValue((c) => {
				const rest = { ...c };
				delete rest.attachReview;
				return rest;
			});
		}
		const treeReady = () => (h.share as unknown as { awaitFolderTreeReady(): Promise<boolean> }).awaitFolderTreeReady();
		return { h, ui, answer, renames, from: `${FOLDER}/${from}`, to: `${FOLDER}/${to}`, treeReady, internals: h.share as unknown as Internals };
	}

	/** Past the pause a barrier-started check takes before comparing. */
	async function settleTrips(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 350));
		await settle();
	}

	test("held: the dialog comes before the rename; Cancel keeps the note at its path", async () => {
		const { h, ui, answer, renames, from, to } = moved({ server: "server text" });

		const state = await startCheck(h.share);

		expect(ui.decide).toHaveBeenCalledTimes(1);
		expect((ui.decide.mock.calls[0][1] as Model).paths).toEqual(["new.md"]);
		expect(renames).toEqual([]);
		expect(h.vault.writes).toEqual([]);
		expect(h.ydocUpdates()).toBe(0);

		answer("cancel");
		await settle();

		expect(state.result).toBe(false);
		expect(renames).toEqual([]);
		expect(h.vault.files.get(from)).toBe("local text");
		expect(h.vault.files.has(to)).toBe(false);
	});

	test("held, keep server: one dialog, then the move, then the server text with the local one in backup", async () => {
		const { h, ui, answer, renames, to } = moved({ server: "server text" });

		const state = await startCheck(h.share);
		answer("keep-server");
		await settle();

		expect(ui.decide).toHaveBeenCalledTimes(1);
		expect(renames).toEqual([to]);
		expect(h.vault.files.get(to)).toBe("server text");
		const backups = [...h.vault.files.entries()].filter(([p]) => p.startsWith("Team Relay backups/"));
		expect(backups.map(([, text]) => text)).toEqual(["local text"]);
		expect(h.docs.get("new.md")!.doc.content).toBe("server text");
		expect(h.uploads).toEqual([]);
		expect(state.result).toBe(true);
	});

	test("held, folder move, keep both: the copy lands next to the moved note", async () => {
		const { h, ui, answer, renames, to } = moved({ server: "server text", folderMove: true });

		const state = await startCheck(h.share);
		expect(ui.decide).toHaveBeenCalledTimes(1);
		expect((ui.decide.mock.calls[0][1] as Model).paths).toEqual(["archive/note.md"]);
		expect(renames).toEqual([]);

		answer("keep-both");
		await settle();

		expect(renames).toEqual([`${FOLDER}/archive`]);
		expect(h.vault.files.get(to)).toBe("server text");
		const copies = [...h.vault.files.keys()].filter((p) => p !== to && p.startsWith(`${FOLDER}/archive/`));
		expect(copies).toHaveLength(1);
		expect(isConflictCopyPath(copies[0].slice(FOLDER.length + 1))).toBe(true);
		expect(h.vault.files.get(copies[0])).toBe("local text");
		expect(state.result).toBe(true);
	});

	test("positive control: the same text after the move needs no dialog; the move runs", async () => {
		const { h, ui, renames, to } = moved({ server: "local text" });

		const state = await startCheck(h.share);
		await settle();

		expect(ui.decide).not.toHaveBeenCalled();
		expect(renames).toEqual([to]);
		expect(h.vault.files.get(to)).toBe("local text");
		expect(state.result).toBe(true);
	});

	test("not held at start (no pending flag): the move waits for the dialog; Cancel renames nothing", async () => {
		const { h, ui, answer, renames, from, treeReady, internals } = moved({ server: "server text", entry: null });
		expect(internals.attachHeld).toBe(false);

		let ready: boolean | undefined;
		void treeReady().then((r) => (ready = r));
		await settleTrips();

		expect(internals.attachHeld).toBe(true);
		expect(ui.decide).toHaveBeenCalledTimes(1);
		expect(ui.decide.mock.calls[0][2]).toBe("auto");
		expect(renames).toEqual([]);
		expect(h.vault.writes).toEqual([]);

		answer("cancel");
		await settleTrips();

		expect(renames).toEqual([]);
		expect(ready).toBe(false);
		expect(h.vault.files.get(from)).toBe("local text");
	});

	test("not held, the moved note cannot be checked: fail closed, held and nothing renamed", async () => {
		const { h, renames, treeReady, internals } = moved({ server: "server text", entry: null });
		Object.defineProperty(h.share, "ensureDoc", {
			value: () => {
				throw new Error("store unavailable");
			},
		});

		let ready: boolean | undefined;
		void treeReady().then((r) => (ready = r));
		await settleTrips();

		expect(internals.attachHeld).toBe(true);
		expect(renames).toEqual([]);
		expect(ready).toBeUndefined();
			// Stop the retry loop of the held check.
		(h.share as unknown as { isTornDown: boolean }).isTornDown = true;
	});

	test("positive control: not held, a note agreed here before moves at once with no hold", async () => {
		const { h, ui, renames, to, treeReady, internals } = moved({ server: "server text", entry: null });
		const doc = h.docs.get("new.md")!.doc;
		await doc.setSyncBase("server text");
		await doc.markServerAcked();

		expect(await treeReady()).toBe(true);
		await settleTrips();

		expect(internals.attachHeld).toBe(false);
		expect(ui.decide).not.toHaveBeenCalled();
		expect(renames).toEqual([to]);
	});

	test("mixed stationary + moved note, keep both: one summary counts and lists both copies", async () => {
		const { h, ui, answer, renames, to } = moved({
			server: "moved server",
			stationary: [{ path: "stationary.md", local: "stationary local", server: "stationary server" }],
		});

		const state = await startCheck(h.share);
		expect(ui.decide).toHaveBeenCalledTimes(1);
		const model = ui.decide.mock.calls[0][1] as Model;
		expect(model.count).toBe(2);
		expect(model.paths).toEqual(["new.md", "stationary.md"]);

		answer("keep-both");
		await settle();

		expect(state.result).toBe(true);
		expect(renames).toEqual([to]);
		const copies = [...h.vault.files.keys()]
			.filter((p) => p.startsWith(`${FOLDER}/`) && isConflictCopyPath(p.slice(FOLDER.length + 1)))
			.map((p) => p.slice(FOLDER.length + 1));
		expect(copies).toHaveLength(2);
		expect(ui.finished).toHaveBeenCalledTimes(1);
		const summary = ui.finished.mock.calls[0][1] as string;
		expect(summary).toContain("2 files differed between local and server");
		for (const copy of copies) expect(summary).toContain(copy);
	});

	test("mixed stationary + moved note, keep server: one summary counts both files in the same backup", async () => {
		const { h, ui, answer, to } = moved({
			server: "moved server",
			stationary: [{ path: "stationary.md", local: "stationary local", server: "stationary server" }],
		});

		const state = await startCheck(h.share);
		const model = ui.decide.mock.calls[0][1] as Model;
		expect(model.count).toBe(2);

		answer("keep-server");
		await settle();

		expect(state.result).toBe(true);
		expect(h.vault.files.get(`${FOLDER}/stationary.md`)).toBe("stationary server");
		expect(h.vault.files.get(to)).toBe("moved server");
		const backups = [...h.vault.files.keys()].filter((p) => p.startsWith(`${model.backupFolder}/`));
		expect(backups.sort()).toEqual([
			`${model.backupFolder}/new.md`,
			`${model.backupFolder}/stationary.md`,
		]);
		expect(ui.finished).toHaveBeenCalledTimes(1);
		const summary = ui.finished.mock.calls[0][1] as string;
		expect(summary).toContain("2 files differed between local and server");
		expect(summary).toContain(model.backupFolder);
	});

	test("mixed stationary + moved note, moved copy fails after move: summary keeps the pass-1 copy and names the unresolved note", async () => {
		let blockMovedCopy = true;
		const { h, ui, answer } = moved({
			server: "moved server",
			stationary: [{ path: "stationary.md", local: "stationary local", server: "stationary server" }],
			failWrite: (path) => blockMovedCopy && path.startsWith(`${FOLDER}/new (relay conflict`),
		});

		const state = await startCheck(h.share);
		answer("keep-both");
		await settle();

		expect(state.result).toBeUndefined();
		expect(ui.finished).toHaveBeenCalledTimes(1);
		const partial = ui.finished.mock.calls[0][1] as string;
		expect(partial).toContain("2 files differed between local and server");
		expect(partial).toContain("stationary (relay conflict");
		expect(partial).toContain("Not changed, the copy could not be saved: new.md");

		blockMovedCopy = false;
		answer("keep-both");
		await settle();

		expect(state.result).toBe(true);
		expect(ui.finished).toHaveBeenCalledTimes(2);
		const retry = ui.finished.mock.calls[1][1] as string;
		expect(retry).toContain("1 file differed between local and server");
		expect(retry).toContain("new (relay conflict");
	});

	test("mixed stationary + moved note, stationary fails in pass 1: projected move waits until the rename runs", async () => {
		let blockStationaryCopy = true;
		const { h, ui, answer, renames, to } = moved({
			server: "moved server",
			stationary: [{ path: "stationary.md", local: "stationary local", server: "stationary server" }],
			failWrite: (path) => blockStationaryCopy && path.startsWith(`${FOLDER}/stationary (relay conflict`),
		});

		const state = await startCheck(h.share);
		answer("keep-both");
		await settle();

		expect(state.result).toBeUndefined();
		expect(renames).toEqual([]);
		expect(h.vault.files.has(to)).toBe(false);
		expect(ui.decide).toHaveBeenCalledTimes(2);
		expect((ui.decide.mock.calls[1][1] as Model).paths).toEqual(["stationary.md"]);

		blockStationaryCopy = false;
		answer("keep-both");
		await settle();

		expect(state.result).toBe(true);
		expect(renames).toEqual([to]);
		expect(h.vault.files.get(`${FOLDER}/stationary.md`)).toBe("stationary server");
		expect(h.vault.files.get(to)).toBe("moved server");
		const finalSummary = ui.finished.mock.calls[1][1] as string;
		expect(finalSummary).toContain("2 files differed between local and server");
		expect(finalSummary).toContain("stationary (relay conflict");
		expect(finalSummary).toContain("new (relay conflict");
	});
});
