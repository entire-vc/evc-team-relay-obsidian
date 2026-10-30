/**
 * Run 7: announced edits to four closed notes, each pull hitting a connect
 * that never settles (the first connect for two notes, the reconnect inside
 * the wait for the other two).
 *
 * Drives the real CrdtBackgroundSyncPoller and TransferQueue over document
 * doubles that keep a real Y.Doc with a seed-shaped history gap; only the
 * clock, the socket (bringOnline) and the vault are faked. Each note must
 * end up with the relay's current text on disk, within the same minute, with
 * a local edit kept as a conflict copy.
 *
 * On c17f4a27 the two stuck reconnects hold their pull until the await-content
 * budget (AWAIT_CONTENT_MS + PULL_DEADLINE_MS) runs out, so their text
 * reaches the disk only after ~90s.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import * as Y from "yjs";

import { MockClock } from "./mocks/MockClock";
import { CrdtBackgroundSyncPoller } from "src/CrdtBackgroundSyncPoller";
import { TransferQueue } from "src/TransferQueue";
import { Document } from "src/Document";
import { textFingerprint, type RemoteActivityListener } from "src/docActivity";

const flush = async (times = 5): Promise<void> => {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const OLD_TEXT = "Run 7 note\nlast agreed text\n";
const LOCAL_EDIT = "Run 7 note\nlast agreed text\nlocal edit not yet uploaded\n";

type Stuck = "first-connect" | "reconnect";

function makeNote(index: number, stuck: Stuck, localEdit: boolean) {
	const newText = `${OLD_TEXT}relay edit ${index}\n`;
	// The author's doc: a seed in the users map, then the text. This client
	// stored everything but the seed, so its doc has a gap until the relay answers.
	const author = new Y.Doc();
	author.getMap("users").set("author", "seeded before the store attached");
	const seeded = Y.encodeStateVector(author);
	author.getText("contents").insert(0, newText);
	const stored = Y.encodeStateAsUpdate(author, seeded);
	const full = Y.encodeStateAsUpdate(author);

	const crdtDoc = new Y.Doc();
	Y.applyUpdate(crdtDoc, stored);
	const state = { vault: localEdit ? LOCAL_EDIT : OLD_TEXT, syncBase: OLD_TEXT as string | undefined };
	const written: string[] = [];
	const conflictCopies: string[] = [];
	let connects = 0;
	const deliver = () => Y.applyUpdate(crdtDoc, full);
	const bringOnline = jest.fn(async (): Promise<boolean> => {
		connects++;
		if (stuck === "first-connect") {
			if (connects === 1) return new Promise<boolean>(() => undefined);
			deliver();
		} else {
			// The first socket opens but the relay never pushes the text to it;
			// the reconnect hangs; the next one gets it.
			if (connects === 2) return new Promise<boolean>(() => undefined);
			if (connects >= 3) deliver();
		}
		return true;
	});

	const guid = `guid-${index}`;
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "entryPath", { value: `notes/${index}.md` });
	Object.defineProperty(doc, "entityGuid", { value: guid });
	Object.defineProperty(doc, "isOnline", { value: false });
	Object.defineProperty(doc, "editLock", { value: false });
	Object.defineProperty(doc, "resourceAddress", { value: {} });
	Object.defineProperty(doc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(doc, "content", { get: () => crdtDoc.getText("contents").toString() });
	Object.defineProperty(doc, "crdtDoc", { value: crdtDoc });
	Object.defineProperty(doc, "connectionIntent", { value: "disconnected" });
	Object.defineProperty(doc, "bringOnline", { value: bringOnline });
	Object.defineProperty(doc, "onceOnline", { value: async () => {} });
	Object.defineProperty(doc, "onceFreshlySynced", { value: async () => {} });
	Object.defineProperty(doc, "goOffline", { value: jest.fn() });
	Object.defineProperty(doc, "_liveProvider", { value: { ws: null, awareness: null } });
	Object.defineProperty(doc, "getSyncBase", { value: async () => state.syncBase });
	Object.defineProperty(doc, "setSyncBase", {
		value: async (text: string) => {
			state.syncBase = text;
		},
	});
	Object.defineProperty(doc, "vaultShare", {
		value: {
			workspaceId: "relay-1",
			readContents: async () => state.vault,
			hasFile: async () => true,
			isDeletePending: () => false,
			ensureParentDir: async () => {},
			writeConflictCopy: async (_doc: unknown, content: string) => {
				conflictCopies.push(content);
				return "copy.md";
			},
			writeContents: async (_doc: unknown, content: string) => {
				state.vault = content;
				written.push(content);
			},
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { doc, guid, newText, state, written, conflictCopies, bringOnline };
}

describe("announced pulls over a connect that never settles", () => {
	let clock: MockClock;
	let t0: number;

	beforeEach(() => {
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		jest.spyOn(console, "warn").mockImplementation(() => undefined);
		clock = new MockClock();
		t0 = clock.now();
	});

	/** Moves the clock in small steps so the poller, the queue and their timers interleave. */
	async function advance(ms: number): Promise<void> {
		for (let step = 0; step < ms; step += 250) {
			clock.setTime(clock.now() + 250);
			await flush();
		}
	}

	test("deadline / timeout -> re-check -> compare -> write: all four notes get the relay text within 45s, a local edit stays as a conflict copy", async () => {
		const notes = [
			makeNote(0, "first-connect", false),
			makeNote(1, "first-connect", true),
			makeNote(2, "reconnect", false),
			makeNote(3, "reconnect", true),
		];
		const queue = new TransferQueue({} as never, clock, {} as never);
		jest.spyOn(queue, "enqueueUpload").mockResolvedValue(undefined);
		const listeners = new Set<RemoteActivityListener>();
		const trackedEntries = new Map<string, Document>();
		const folder = {
			workspaceId: "relay-1",
			isOnline: true,
			path: "notes",
			trackedEntries,
			transfers: queue,
			docActivity: {
				subscribeRemote: (listener: RemoteActivityListener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		};
		const poller = new CrdtBackgroundSyncPoller(clock as never, { each: (cb: (f: typeof folder) => void) => cb(folder) } as never, 3_600_000);
		poller.start();
		for (const n of notes) trackedEntries.set(n.guid, n.doc);

		for (const n of notes) listeners.forEach((l) => l(n.guid, textFingerprint(n.newText)));
		await flush();
		await advance(45_000);

		for (const n of notes) {
			expect({ path: n.doc.entryPath, vault: n.state.vault }).toEqual({ path: n.doc.entryPath, vault: n.newText });
		}
		// The local edit is kept, once, in a copy; the others had nothing to keep.
		expect(notes[1].conflictCopies).toEqual([LOCAL_EDIT]);
		expect(notes[3].conflictCopies).toEqual([LOCAL_EDIT]);
		expect(notes[0].conflictCopies).toEqual([]);
		expect(notes[2].conflictCopies).toEqual([]);
		expect(clock.now() - t0).toBeGreaterThanOrEqual(45_000);
		expect(poller.stats().inflight).toBe(0);
		poller.destroy();
	});
});
