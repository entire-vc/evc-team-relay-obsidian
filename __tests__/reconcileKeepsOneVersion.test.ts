/**
 * GH #113: an upload that finds the relay text off the file with no common
 * base (no sync base recorded, or a lost reconcile claim) used to keep the
 * relay text as a "relay conflict" copy and then rewrite the shared Y.Text
 * with a character diff from the CURRENT relay text to the file. A
 * collaborator typing in the same lines at that moment merged with that diff
 * inside words: the note got words and rows no side had ever written, and
 * every participant received them.
 *
 * The note must hold one side's text in full and the copy the other side's;
 * never a mix. These tests drive the real TransferQueue.uploadDocumentViaSocket()
 * with a second Y.Doc as the collaborator (the network is the only boundary).
 */
import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { SystemClock } from "../src/Clock";
import { applyDiffToYText } from "../src/ytextDiff";

function sync(a: Y.Doc, b: Y.Doc) {
	const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
	const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
	Y.applyUpdate(b, ua);
	Y.applyUpdate(a, ub);
}

function makeFakeDoc(ydoc: Y.Doc, vaultContents: string, initialBase: string | undefined) {
	let base = initialBase;
	let disk = vaultContents;
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict TS).md");
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockImplementation(async (_doc, content) => {
			disk = content;
		});
	const d = Object.create(Document.prototype) as Document;
	const def = (k: string, v: unknown) => Object.defineProperty(d, k, { value: v });
	def("path", "note.md");
	def("entityGuid", "test-guid");
	def("crdtDoc", ydoc);
	def("editLock", false);
	def("awaitFirstSync", async () => {});
	Object.defineProperty(d, "content", { get: () => ydoc.getText("contents").toJSON() });
	def("vaultShare", {
		workspaceId: "relay-id",
		readContents: async () => disk,
		writeConflictCopy,
		writeContents,
		isDeletePending: () => false,
	});
	def("onceEverSynced", async () => {});
	def("onceFreshlySynced", async () => {});
	Object.defineProperty(d, "connectionIntent", { get: () => "connected" });
	def("bringOnline", async () => true);
	def("_liveProvider", { ws: null });
	def("getSyncBase", async () => base);
	def("setSyncBase", async (t: string) => {
		base = t;
	});
	return {
		d,
		writeConflictCopy,
		writeContents,
		getBase: () => base,
		getDisk: () => disk,
	};
}

const relay = "| Thema | Status |\n| Dringlichkeit | offen |\nTemplate - Duplicate.md\n";
const vault = "| Thema | Status |\n| Lösung | erledigt |\nTemplate - Editor.md\n";
const peerSameLines = "| Thema | Status |\n| Dringlichkeit hoch | offen |\nTemplate - Duplicator.md\n";
const peerOtherLine = relay.replace("| Thema | Status |", "| Thema | Status (neu) |");

interface Run {
	/** The shared note text once both replicas exchanged everything. */
	merged: string;
	copies: string[];
	disk: string;
	base: string | undefined;
}

/**
 * Client A uploads while collaborator B has an edit A has not received yet;
 * then the two replicas exchange everything.
 */
async function run(peer: string | null, initialBase: string | undefined): Promise<Run> {
	const a = new Y.Doc();
	const b = new Y.Doc();
	a.getText("contents").insert(0, relay);
	sync(a, b);
	// B's editor binding: a diff of its view against its own Y.Text.
	if (peer !== null) applyDiffToYText(b, peer);
	const fake = makeFakeDoc(a, vault, initialBase);
	const queue = new TransferQueue({} as never, new SystemClock(), {} as never);
	expect(await queue.uploadDocumentViaSocket(fake.d)).toBe(true);
	sync(a, b);
	expect(b.getText("contents").toJSON()).toBe(a.getText("contents").toJSON());
	return {
		merged: a.getText("contents").toJSON(),
		copies: fake.writeConflictCopy.mock.calls.map((c) => c[1]),
		disk: fake.getDisk(),
		base: fake.getBase(),
	};
}

describe("GH #113: reconcile without a common base keeps one version whole", () => {
	test("a collaborator typing in the same lines: the note is a whole version, the file text is the copy", async () => {
		const r = await run(peerSameLines, undefined);
		// The collaborator's edit is a normal CRDT edit on the relay text,
		// so the note ends up as their text, and nothing else.
		expect(r.merged).toBe(peerSameLines);
		expect(r.copies).toEqual([vault]);
	});

	test("control: no concurrent edit -- the note keeps the relay text, the file text is the copy, the base is the relay text", async () => {
		const r = await run(null, undefined);
		expect(r.merged).toBe(relay);
		expect(r.copies).toEqual([vault]);
		expect(r.disk).toBe(relay);
		expect(r.base).toBe(relay);
	});

	test("control: a collaborator editing another line keeps their edit, the file text is the copy", async () => {
		const r = await run(peerOtherLine, undefined);
		expect(r.merged).toBe(peerOtherLine);
		expect(r.copies).toEqual([vault]);
	});

	test("a failed copy writes nothing and leaves the base unset, so the next sync tries again", async () => {
		const a = new Y.Doc();
		a.getText("contents").insert(0, relay);
		const fake = makeFakeDoc(a, vault, undefined);
		fake.writeConflictCopy.mockRejectedValue(new Error("disk full"));
		const queue = new TransferQueue({} as never, new SystemClock(), {} as never);
		await queue.uploadDocumentViaSocket(fake.d);
		expect(a.getText("contents").toJSON()).toBe(relay);
		expect(fake.writeContents).not.toHaveBeenCalled();
		expect(fake.getDisk()).toBe(vault);
		expect(fake.getBase()).toBeUndefined();
	});

	test("a collaborator's edit landing during the reconcile claim: the note is a whole version, the file text is the copy", async () => {
		// The base equals the relay text, so this takes the claim path; the
		// collaborator's edit arrives mid-settle, the claim is not used, and
		// the safe path runs while the collaborator is still typing.
		const a = new Y.Doc();
		const b = new Y.Doc();
		a.getText("contents").insert(0, relay);
		sync(a, b);
		const fake = makeFakeDoc(a, vault, relay);
		const firstPeerEdit = relay.replace("| Thema | Status |", "| Thema | Status (neu) |");
		const timer = window.setTimeout(() => {
			applyDiffToYText(b, firstPeerEdit);
			sync(a, b);
			applyDiffToYText(b, firstPeerEdit.replace("Duplicate.md", "Duplicator.md"));
		}, 50);
		const queue = new TransferQueue({} as never, new SystemClock(), {} as never);
		await queue.uploadDocumentViaSocket(fake.d);
		window.clearTimeout(timer);
		sync(a, b);
		const merged = a.getText("contents").toJSON();
		expect(merged).toBe(firstPeerEdit.replace("Duplicate.md", "Duplicator.md"));
		expect(fake.writeConflictCopy.mock.calls.map((c) => c[1])).toEqual([vault]);
	});
});
