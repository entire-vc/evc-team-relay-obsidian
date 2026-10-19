/**
 * Regression test: — TransferQueue.pullIfUnchanged silently
 * discarded the losing client's unsynced edit in the two-client restart race
 *, with NO conflict-copy and no trace.
 *
 * Root cause (traced live with temporary instrumentation against the
 * self-hosted stand, see task comments): pullIfUnchanged()'s only guard
 * against clobbering a local edit was "the vault file didn't change DURING
 * this call's own ~2s connect+grace window". That proves the file was
 * stable while this call watched it, not that its content is actually
 * synced. An edit written straight to disk (app.vault.modify() with no live
 * editor binding) that landed BEFORE this call started, and then simply sat
 * there because the client that owns pushing it is offline/mid-restart,
 * satisfies "unchanged" trivially and used to be overwritten with the
 * relay's stale content — no conflict copy, no trace. Live-reproduced 6/6:
 * `/tmp/tr-mechb-probe.log` from the investigation instrumentation caught
 * `pullIfUnchanged CHECK unchanged=true ... WRITING remoteText over vault
 * (OVERWRITE, no conflict-copy)` clobbering a live, never-yet-synced local
 * edit on both sides of the race.
 *
 * Fix: same invariant uploadDocumentViaSocket()/reconcileRelayContent()
 * already use — check the vault content against `Document.getSyncBase()`
 * (what THIS client last CONFIRMED it and the relay agreed on), not just
 * against a same-call snapshot, before ever overwriting. A recorded,
 * diverging base means a genuine unsynced edit: preserve it as a
 * conflict-copy first. No recorded base at all means we can't tell a
 * genuine edit apart from this client's own in-flight seed/upload racing
 * the read (the exact false-positive class pullIfUnchanged was
 * built to avoid) — skip the write entirely rather than guess.
 *
 * These tests exercise the real `TransferQueue.pullIfUnchanged()` against a
 * minimal duck-typed Document (real `Document.prototype` in its chain) —
 * same pattern as syncBaseNoConflictCopy.test.ts. Timers are driven by a
 * fake Clock that fires every scheduled callback on the next macrotask, so
 * pullIfUnchanged()'s internal connect-timeout race and fixed grace delay
 * resolve immediately instead of costing real wall-clock seconds per test.
 */

import { describe, test, expect, jest } from "@jest/globals";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";

/** Fires every scheduled timeout/interval callback on the next macrotask,
 * regardless of the requested delay -- keeps pullIfUnchanged()'s internal
 * raceTimeout()/delay() calls from costing real wall-clock time in tests. */
class InstantClock implements Clock {
	now(): number {
		return Date.now();
	}
	scheduleTimeout(callback: () => void): number {
		setImmediate(callback);
		return 0;
	}
	scheduleInterval(callback: () => void): number {
		setImmediate(callback);
		return 0;
	}
	cancelTimeout(): void {}
	cancelInterval(): void {}
	teardown(): void {}
	debounced<T extends (...args: unknown[]) => void>(func: T): (...args: Parameters<T>) => void {
		return (...args: Parameters<T>) => func(...args);
	}
}

interface FakeDocOptions {
	/** What's currently on disk when pullIfUnchanged() is called. */
	vaultContents: string;
	/** What the relay's Y.Doc currently holds (post fresh-sync). */
	remoteText: string;
	/** The last text this client recorded as agreeing with the relay on, or undefined if never set. */
	syncBase: string | undefined;
	/** Whether the doc's folder still tracks this path (default true). */
	tracked?: boolean;
}

function makeFakeDoc(opts: FakeDocOptions) {
	// Mutable, so a sequence of pulls sees what the previous one left behind.
	const state = { vault: opts.vaultContents, remote: opts.remoteText, syncBase: opts.syncBase };
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict TIMESTAMP).md");
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockImplementation(async (_doc, content) => {
			state.vault = content;
		});
	const setSyncBase = jest.fn<(text: string) => Promise<void>>().mockImplementation(async (text) => {
		state.syncBase = text;
	});

	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "entityGuid", { value: "test-guid" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => state.remote });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => state.syncBase });
	Object.defineProperty(fakeDoc, "setSyncBase", { value: setSyncBase });
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			readContents: async () => state.vault,
			writeConflictCopy,
			writeContents,
			folderIndex: { tracks: () => opts.tracked ?? true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});

	return { fakeDoc, writeConflictCopy, writeContents, setSyncBase, state };
}

function makeQueue(): TransferQueue {
	const queue = new TransferQueue({} as never, new InstantClock(), {} as never);
	// pullIfUnchanged() must never push by itself; when it decides the local
	// edit should go up it hands the doc to the upload lane.
	jest.spyOn(queue, "enqueueUpload").mockResolvedValue(undefined);
	return queue;
}

describe("pullIfUnchanged — sync-base gates the overwrite, never silently discards", () => {
	test("REGRESSION: both sides moved since the last agreed sync -- local edit preserved as a conflict copy, relay content lands", async () => {
		// The two-client restart race: this client wrote an edit straight to
		// disk (no live editor binding) that never made it back to the relay,
		// AND the relay moved on (the peer's edit) since the last agreed sync.
		// The file hasn't moved DURING this call's window, so the old code's
		// only guard was satisfied and it silently discarded the local edit.
		// A genuine three-way divergence: preserve the local side, take the relay's.
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "B-EDIT-DURING-RESTART",
			remoteText: "TWO-CLIENT-RESTART-PROBE PEER EDIT",
			syncBase: "TWO-CLIENT-RESTART-PROBE initial",
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy).toHaveBeenCalledWith(
			fakeDoc,
			"B-EDIT-DURING-RESTART",
			expect.stringMatching(/^relay conflict /),
		);
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "TWO-CLIENT-RESTART-PROBE PEER EDIT");
		expect(queue.enqueueUpload).not.toHaveBeenCalled();
	});

	test(": the relay has NOT moved since the last agreed sync -- the author's own pending edit is kept on disk and its upload queued, not reverted", async () => {
		// A edits an existing, already-synced note. Its own upload is still on
		// the way, so the relay still holds the previous text -- which is also
		// the recorded sync base. The vault differs from the base only because
		// of the author's own edit. The old code treated that as a genuine
		// unsynced edit, preserved it in a conflict copy and then OVERWROTE the
		// file with the relay's stale text: the author's edit vanished from
		// disk ~6-9s after being made, and the upload that followed re-read the
		// reverted file and pushed nothing, so the peer never got it.
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "note v2 (edited on A)",
			remoteText: "note v1",
			syncBase: "note v1",
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeContents).not.toHaveBeenCalled();
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(queue.enqueueUpload).toHaveBeenCalledTimes(1);
		expect(queue.enqueueUpload).toHaveBeenCalledWith(fakeDoc);
	});

	test(" edge: an EMPTY vault file with the relay unchanged keeps the previous restore behaviour (the upload path skips empty content, so queueing it would loop)", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "",
			remoteText: "note v1",
			syncBase: "note v1",
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(queue.enqueueUpload).not.toHaveBeenCalled();
		// Restored, but no 0-byte copy: an empty file holds nothing to preserve (GH #4).
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "note v1");
	});

	test("no recorded sync base yet: skips the write entirely rather than guess (avoids reintroducing)", async () => {
		// This doc has never completed a successful uploadDocumentViaSocket
		// cycle -- e.g. VaultShare.publishDoc()'s raw Y.Text insert is still
		// mid-seed and racing this read. We cannot tell that apart from a
		// genuine unsynced edit here, so neither overwrite NOR conflict-copy.
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "freshly seeded content",
			remoteText: "",
			syncBase: undefined,
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
	});

	test("vault content matches the last confirmed sync base: safe to overwrite directly, no conflict copy needed", async () => {
		// Nothing local has changed since we last agreed with the relay --
		// this is the ordinary "peer edited a closed file" case the poller
		// exists for. The relay genuinely moved; our own content
		// did not.
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "shared content",
			remoteText: "shared content EDITED BY PEER",
			syncBase: "shared content",
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "shared content EDITED BY PEER");
	});

	test("relay content already matches disk: no write, no conflict copy", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vaultContents: "same everywhere",
			remoteText: "same everywhere",
			syncBase: "same everywhere",
		});

		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).not.toHaveBeenCalled();
	});

	test(": a delivered edit becomes the new sync base -- the NEXT delivered edit is not read as a local edit and produces no conflict copy", async () => {
		// The receiver (B) is fed edit after edit by the author. Each pull
		// overwrites the file with the relay text. Before the fix the base
		// stayed at the initial content, so from the second edit on the file
		// (our own previous delivery) differed from the base and was copied
		// out as a "relay conflict" file -- one per edit, on every participant.
		const { fakeDoc, writeConflictCopy, writeContents, state } = makeFakeDoc({
			vaultContents: "v0",
			remoteText: "edit1",
			syncBase: "v0",
		});
		const queue = makeQueue();
		for (let i = 1; i <= 10; i++) {
			state.remote = `edit${i}`;
			await queue.pullIfUnchanged(fakeDoc);
			expect(state.vault).toBe(`edit${i}`);
			expect(state.syncBase).toBe(`edit${i}`);
		}
		expect(writeContents).toHaveBeenCalledTimes(10);
		expect(writeConflictCopy).not.toHaveBeenCalled();
	});

	test(": a real two-sided divergence AFTER a delivery still yields exactly one conflict copy", async () => {
		const { fakeDoc, writeConflictCopy, state } = makeFakeDoc({
			vaultContents: "v0",
			remoteText: "edit1",
			syncBase: "v0",
		});
		const queue = makeQueue();
		await queue.pullIfUnchanged(fakeDoc); // edit1 delivered, base = edit1
		state.vault = "LOCAL-EDIT-NOT-UPLOADED"; // this client edits the same version
		state.remote = "edit2"; // the peer edits it too
		await queue.pullIfUnchanged(fakeDoc);

		expect(writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(writeConflictCopy).toHaveBeenCalledWith(
			fakeDoc,
			"LOCAL-EDIT-NOT-UPLOADED",
			expect.stringMatching(/^relay conflict /),
		);
		expect(state.vault).toBe("edit2");
	});
});
