/**
 * GH #117: another program rewrites the file of a shared note that is open in
 * an editor. The upload lane skips an editor-bound note and the outbound
 * writer refuses text the relay does not agree with, so before this fix the
 * rewrite reached neither the Y.Doc nor the relay and members diverged.
 */

import { describe, test, expect } from "@jest/globals";
import { TFile } from "obsidian";
import * as Y from "yjs";
import { Document } from "../src/Document";
import {
	AppWriteLog,
	COPY_ATTEMPTS,
	PREVIOUS_WRITE_WINDOW_MS,
	PathQueue,
	READ_RETRY_MS,
	absorbExternalRewrite,
	onBoundNoteModified,
} from "../src/externalDiskChange";
import { applyDiffToYText } from "../src/ytextDiff";
import { readRelaySyncedText } from "../src/outboundSyncWiring";
import { uploadsOnModify } from "../src/uploadOnModify";

const PATH = "Shared/note.md";

function fakeDoc(ytext: string, base: string, synced: boolean | Promise<void> = true) {
	const crdtDoc = new Y.Doc();
	crdtDoc.getText("contents").insert(0, ytext);
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "crdtDoc", { value: crdtDoc });
	Object.defineProperty(doc, "content", { get: () => crdtDoc.getText("contents").toJSON() });
	Object.defineProperty(doc, "isOnline", { value: true });
	Object.defineProperty(doc, "isSynced", { value: synced === true, writable: true });
	Object.defineProperty(doc, "editLock", { value: true });
	// A note that is still syncing never finishes within these tests.
	(doc as unknown as { onceFreshlySynced: () => Promise<void> }).onceFreshlySynced = () =>
		synced === true ? Promise.resolve() : synced === false ? new Promise<void>(() => {}) : synced;
	(doc as unknown as { getSyncBase: () => Promise<string> }).getSyncBase = async () => base;
	return doc;
}

function setup(ytext: string, base: string, disk: string, synced: boolean | Promise<void> = true) {
	const doc = fakeDoc(ytext, base, synced);
	const tfile: TFile = Object.create(TFile.prototype);
	(tfile as unknown as { path: string }).path = PATH;
	const vault = {
		getAbstractFileByPath: () => tfile,
		read: async () => disk,
	};
	const registry = {
		shareFor: () => ({ isOnline: true, rootRelative: { entryFor: () => doc } }),
	};
	const copies: string[] = [];
	const notices: string[] = [];
	let now = 1_000;
	const writes = new AppWriteLog(() => now);
	const deps = {
		writes,
		read: async (): Promise<string> => disk,
		sleep: async (_ms: number) => {},
		writeConflictCopy: async (content: string) => {
			copies.push(content);
			return "Shared/note (outside change).md";
		},
		log: () => {},
		notify: (message: string) => {
			notices.push(message);
		},
	};
	return {
		doc,
		vault,
		registry,
		copies,
		notices,
		writes,
		deps,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

/** The vault "modify" path for an editor-bound note, then the outbound read. */
async function afterModify(
	s: ReturnType<typeof setup>,
	loadedText: string | undefined,
) {
	const uploadLane = uploadsOnModify(s.doc);
	if (!uploadLane) await onBoundNoteModified(PATH, s.doc, loadedText, s.deps);
	const outbound = await readRelaySyncedText(s.vault as never, s.registry as never, PATH);
	return { uploadLane, outbound, ydoc: s.doc.content };
}

describe("GH #117 outside rewrite of an open shared note", () => {
	test("positive control: an editor save (disk == Y.Doc) is pushed outbound unchanged", async () => {
		const s = setup("clean", "garbled", "clean");
		const r = await afterModify(s, "clean");
		expect(r.outbound).toBe("clean");
		expect(r.ydoc).toBe("clean");
		expect(s.copies).toEqual([]);
	});

	test("the triage case: Y.Doc=base='garbled', disk rewritten to 'clean' reaches the Y.Doc and the relay", async () => {
		const s = setup("garbled", "garbled", "clean");
		const r = await afterModify(s, "garbled");
		expect(r.uploadLane).toBe(false);
		expect(r.ydoc).toBe("clean");
		expect(r.outbound).toBe("clean");
		expect(s.copies).toEqual([]);
	});

	test("the text before the rewrite comes from this app's last write when the editor's is unknown", async () => {
		const s = setup("line one\n", "old base", "line one\nadded outside\n");
		s.writes.record(PATH, "line one\n");
		const r = await afterModify(s, undefined);
		expect(r.ydoc).toBe("line one\nadded outside\n");
		expect(s.copies).toEqual([]);
	});

	test("an editor save trailing a collaborator's newer edit is not taken for an outside change", async () => {
		// The editor saved "A" (through the vault adapter); a collaborator's
		// edit reached the Y.Doc before the "modify" event was handled.
		const s = setup("A plus remote edit", "A", "A");
		s.writes.record(PATH, "A");
		const r = await afterModify(s, "A");
		expect(r.ydoc).toBe("A plus remote edit");
		expect(s.copies).toEqual([]);
	});

	test("the write before the latest one counts as this app's only for a short window", () => {
		const s = setup("", "", "");
		s.writes.record(PATH, "first");
		s.writes.record(PATH, "second");
		expect(s.writes.isOwnWrite(PATH, "first")).toBe(true);
		s.advance(PREVIOUS_WRITE_WINDOW_MS + 1);
		expect(s.writes.isOwnWrite(PATH, "first")).toBe(false);
		expect(s.writes.isOwnWrite(PATH, "second")).toBe(true);
	});

	test("Y.Doc moved on since the file was last written: the rewrite goes in, the replaced text is kept in a copy", async () => {
		const s = setup("v1 plus remote edit", "v1", "v2 from outside");
		const r = await afterModify(s, "v1");
		expect(r.ydoc).toBe("v2 from outside");
		expect(r.outbound).toBe("v2 from outside");
		expect(s.copies).toEqual(["v1 plus remote edit"]);
	});

	test("nothing known about the text before the rewrite: the replaced text is kept in a copy", async () => {
		const s = setup("live text", "", "rewritten");
		const r = await afterModify(s, undefined);
		expect(r.ydoc).toBe("rewritten");
		expect(s.copies).toEqual(["live text"]);
	});

	test("a failed conflict copy leaves the Y.Doc untouched", async () => {
		const ydoc = new Y.Doc();
		ydoc.getText("contents").insert(0, "live text");
		const r = await absorbExternalRewrite(
			ydoc,
			"rewritten",
			"older",
			async () => {
				throw new Error("disk full");
			},
			"test",
		);
		expect(r.kind).toBe("skipped");
		expect(ydoc.getText("contents").toJSON()).toBe("live text");
	});

	test("a note that does not sync in time keeps the outside text in a copy and its Y.Doc as it was", async () => {
		const s = setup("partial", "partial", "rewritten", false);
		const r = await onBoundNoteModified(PATH, s.doc, "partial", s.deps);
		expect(r.kind).toBe("kept-as-copy");
		expect(s.doc.content).toBe("partial");
		expect(s.copies).toEqual(["rewritten"]);
	});

	test("a file another program still holds locked is read again before giving up", async () => {
		const s = setup("before", "before", "after");
		let failures = 2;
		s.deps.read = async () => {
			if (failures-- > 0) throw new Error("EBUSY: resource busy or locked");
			return "after";
		};
		const r = await onBoundNoteModified(PATH, s.doc, "before", s.deps);
		expect(r.kind).toBe("merged");
		expect(s.doc.content).toBe("after");
	});

	test("a file that stays unreadable is reported, not taken for no change", async () => {
		const s = setup("before", "before", "after");
		s.deps.read = async () => {
			throw new Error("EBUSY: resource busy or locked");
		};
		const r = await onBoundNoteModified(PATH, s.doc, "before", s.deps);
		expect(r.kind).toBe("unreadable");
		expect(s.doc.content).toBe("before");
	});

	test("a quick A -> B -> A from outside is taken in both times, not read as this app's echo", async () => {
		const s = setup("A", "A", "B");
		s.writes.record(PATH, "A");
		expect((await onBoundNoteModified(PATH, s.doc, "A", s.deps)).kind).toBe("merged");
		expect(s.doc.content).toBe("B");
		s.deps.read = async () => "A";
		expect((await onBoundNoteModified(PATH, s.doc, "B", s.deps)).kind).toBe("merged");
		expect(s.doc.content).toBe("A");
		expect(s.copies).toEqual([]);
	});

	test("a text seen after an outside change does not become this app's previous write", () => {
		const s = setup("", "", "");
		s.writes.observe(PATH, "outside", s.writes.mark());
		s.writes.record(PATH, "saved by the editor");
		expect(s.writes.isOwnWrite(PATH, "outside")).toBe(false);
		expect(s.writes.isOwnWrite(PATH, "saved by the editor")).toBe(true);
	});

	test("a CRLF rewrite of an LF note goes in with LF endings, as an editor reload would", async () => {
		const s = setup("a\nb\n", "a\nb\n", "a\r\nb changed\r\n");
		await afterModify(s, "a\r\nb\r\n");
		expect(s.doc.content).toBe("a\nb changed\n");
		expect(s.copies).toEqual([]);
	});

	test("a CRLF-only difference is no change at all", async () => {
		const s = setup("a\nb\n", "a\nb\n", "a\r\nb\r\n");
		const r = await afterModify(s, "a\nb\n");
		expect(r.ydoc).toBe("a\nb\n");
		expect(s.copies).toEqual([]);
	});
	test("the user is told when an outside change could not be shared", async () => {
		const locked = setup("before", "before", "after");
		locked.deps.read = async () => {
			throw new Error("EBUSY: resource busy or locked");
		};
		await onBoundNoteModified(PATH, locked.doc, "before", locked.deps);
		expect(locked.notices).toHaveLength(1);
		expect(locked.notices[0]).toContain(PATH);
		expect(locked.notices[0]).toContain("not shared");

		const noCopy = setup("live text", "", "rewritten");
		noCopy.deps.writeConflictCopy = async () => {
			throw new Error("disk full");
		};
		expect((await onBoundNoteModified(PATH, noCopy.doc, undefined, noCopy.deps)).kind).toBe("skipped");
		expect(noCopy.doc.content).toBe("live text");
		expect(noCopy.notices).toHaveLength(1);
		expect(noCopy.notices[0]).toContain("not shared");

		const unsynced = setup("partial", "partial", "rewritten", false);
		unsynced.deps.writeConflictCopy = async () => {
			throw new Error("disk full");
		};
		expect((await onBoundNoteModified(PATH, unsynced.doc, "partial", unsynced.deps)).kind).toBe("not-shared");
		expect(unsynced.notices[0]).toContain("not shared");
	});

	test("the user is told where a copy went, and nothing when the change simply went in", async () => {
		const copied = setup("v1 plus remote edit", "v1", "v2 from outside");
		await onBoundNoteModified(PATH, copied.doc, "v1", copied.deps);
		expect(copied.notices).toHaveLength(1);
		expect(copied.notices[0]).toContain("Shared/note (outside change).md");

		const plain = setup("garbled", "garbled", "clean");
		await onBoundNoteModified(PATH, plain.doc, "garbled", plain.deps);
		expect(plain.notices).toEqual([]);
	});

	test("a collaborator's edit arriving while the conflict copy is written is kept, not erased", async () => {
		const s = setup("remote-before", "", "outside");
		s.deps.writeConflictCopy = async (content: string) => {
			s.copies.push(content);
			applyDiffToYText(s.doc.crdtDoc, "remote-before remote-edit-during-copy");
			return `copy ${s.copies.length}.md`;
		};
		const r = await onBoundNoteModified(PATH, s.doc, "base", s.deps);
		expect(r.kind).toBe("merged-with-copy");
		expect(s.doc.content).toBe("outside");
		expect(s.copies).toEqual(["remote-before", "remote-before remote-edit-during-copy"]);
	});

	test("collaborators who keep editing through every copy leave the Y.Doc alone, and the user is told", async () => {
		const s = setup("live", "", "outside");
		s.deps.writeConflictCopy = async (content: string) => {
			s.copies.push(content);
			applyDiffToYText(s.doc.crdtDoc, `${content}+`);
			return `copy ${s.copies.length}.md`;
		};
		const r = await onBoundNoteModified(PATH, s.doc, "base", s.deps);
		expect(r).toEqual({ kind: "skipped", reason: "kept-changing", conflictPath: `copy ${COPY_ATTEMPTS}.md` });
		expect(s.doc.content).toBe("live" + "+".repeat(COPY_ATTEMPTS));
		expect(s.notices).toHaveLength(1);
	});

	test("an older change still waiting for sync does not replace a newer one already taken in", async () => {
		let finishSync!: () => void;
		const syncing = new Promise<void>((resolve) => {
			finishSync = resolve;
		});
		const s = setup("base", "base", "v1", syncing);
		let disk = "v1";
		s.deps.read = async () => disk;
		s.deps.sleep = () => new Promise<void>(() => {}); // the sync wait does not time out
		const first = onBoundNoteModified(PATH, s.doc, "base", s.deps);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		(s.doc as unknown as { isSynced: boolean }).isSynced = true;
		disk = "v2";
		expect((await onBoundNoteModified(PATH, s.doc, "base", s.deps)).kind).toBe("merged");
		finishSync();
		expect((await first).kind).toBe("superseded");
		expect(s.doc.content).toBe("v2");
		expect(s.copies).toEqual([]);
	});

	test("changes of one note queued in order end on the newest text", async () => {
		let finishSync!: () => void;
		const syncing = new Promise<void>((resolve) => {
			finishSync = resolve;
		});
		const s = setup("base", "base", "v1", syncing);
		let disk = "v1";
		s.deps.read = async () => disk;
		s.deps.sleep = () => new Promise<void>(() => {}); // the sync wait does not time out
		const queue = new PathQueue();
		const first = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		for (let i = 0; i < 5; i++) await Promise.resolve(); // the first change is read and waits for sync
		disk = "v2";
		const second = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		finishSync();
		expect((await first).kind).toBe("superseded");
		expect((await second).kind).toBe("merged");
		expect(s.doc.content).toBe("v2");
	});

	test("this app's own disk write while the note syncs does not cancel the outside text", async () => {
		let finishSync!: () => void;
		const syncing = new Promise<void>((resolve) => {
			finishSync = resolve;
		});
		const s = setup("relay text", "relay text", "outside", syncing);
		let disk = "outside";
		s.deps.read = async () => disk;
		s.deps.sleep = () => new Promise<void>(() => {}); // the sync wait does not time out
		const pending = onBoundNoteModified(PATH, s.doc, "relay text", s.deps);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		// The sync writes the Y.Doc's text to disk through the vault adapter.
		s.writes.record(PATH, "relay text");
		disk = "relay text";
		(s.doc as unknown as { isSynced: boolean }).isSynced = true;
		finishSync();
		expect((await pending).kind).toBe("merged");
		expect(s.doc.content).toBe("outside");
	});
	/** A note that is still syncing, with a disk the test changes, as the vault "modify" handler sees it. */
	function syncingNote() {
		let finishSync!: () => void;
		const syncing = new Promise<void>((resolve) => {
			finishSync = resolve;
		});
		const s = setup("base", "base", "v1", syncing);
		const disk = { text: "v1", failReads: false };
		s.deps.read = async () => {
			if (disk.failReads) throw new Error("EBUSY: resource busy or locked");
			return disk.text;
		};
		s.deps.sleep = (ms: number) => (ms === READ_RETRY_MS ? Promise.resolve() : new Promise<void>(() => {}));
		const synced = () => {
			(s.doc as unknown as { isSynced: boolean }).isSynced = true;
			finishSync();
		};
		const settle = async () => {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		};
		return { s, disk, synced, settle, queue: new PathQueue() };
	}

	test("this app's own write queued behind an outside change is still its own after that change goes in", async () => {
		const { s, disk, synced, settle, queue } = syncingNote();
		const outside = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		await settle();
		// While the note syncs, this app writes the file and its "modify" queues.
		s.writes.record(PATH, "base");
		disk.text = "base";
		const echo = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		synced();
		expect([(await outside).kind, (await echo).kind]).toEqual(["merged", "own-write"]);
		expect(s.doc.content).toBe("v1");
		expect(s.notices).toEqual([]);
	});

	test("an outside change queued behind another is read when it happens, before this app writes over it", async () => {
		const { s, disk, synced, settle, queue } = syncingNote();
		const first = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		await settle();
		disk.text = "v2";
		const second = onBoundNoteModified(PATH, s.doc, "base", s.deps, queue);
		await settle();
		s.writes.record(PATH, "base");
		disk.text = "base";
		synced();
		await first;
		expect((await second).kind).not.toBe("own-write");
		expect(s.doc.content).toBe("v2");
	});

	test("a file that cannot be read again after the sync wait keeps the outside text in a copy and says so", async () => {
		const { s, disk, synced, settle } = syncingNote();
		const pending = onBoundNoteModified(PATH, s.doc, "base", s.deps);
		await settle();
		disk.text = "v2";
		disk.failReads = true;
		synced();
		const r = await pending;
		expect(r).toEqual({ kind: "kept-as-copy", conflictPath: "Shared/note (outside change).md", reason: "recheck-failed" });
		expect(s.doc.content).toBe("base");
		expect(s.copies).toEqual(["v1"]);
		expect(s.notices).toHaveLength(1);
		expect(s.notices[0]).toContain("not shared");
	});

	test("a file that cannot be read again after the conflict copy leaves the Y.Doc alone and keeps the outside text", async () => {
		const s = setup("live text", "", "rewritten");
		let reads = 0;
		s.deps.read = async () => {
			if (++reads > 1) throw new Error("EBUSY: resource busy or locked");
			return "rewritten";
		};
		const r = await onBoundNoteModified(PATH, s.doc, undefined, s.deps);
		expect(r.kind).toBe("kept-as-copy");
		expect(s.doc.content).toBe("live text");
		expect(s.copies).toEqual(["live text", "rewritten"]);
		expect(s.notices[0]).toContain("not shared");
	});
});
