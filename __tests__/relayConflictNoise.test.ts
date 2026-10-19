/**
 * GH issue #4: spurious "(relay conflict ...)" copies.
 *  A. an empty / not-yet-written file must never be preserved as a 0-byte copy
 *  B. CRLF vs LF differences are not conflicts
 *  C. conflict copies are local recovery artefacts and must not be synced
 */
import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import { VaultShare } from "../src/VaultShare";
import { reconcileWithConflictCopy } from "../src/ytextDiff";
import { isConflictCopyPath } from "../src/conflictCopyPath";
import { hasPreservableContent } from "../src/textEquivalence";
import { hasUnsyncedEdit } from "../src/preserveBeforeTrash";

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

function makeFakeDoc(opts: { vault: string | null; remote: string; syncBase: string | undefined }) {
	const state = { vault: opts.vault, remote: opts.remote, syncBase: opts.syncBase };
	const writeConflictCopy = jest
		.fn<(doc: unknown, content: string, label: string) => Promise<string>>()
		.mockResolvedValue("note (relay conflict T).md");
	const writeContents = jest
		.fn<(doc: unknown, content: string) => Promise<void>>()
		.mockImplementation(async (_d, c) => {
			state.vault = c;
		});
	const fakeDoc = Object.create(Document.prototype) as Document;
	Object.defineProperty(fakeDoc, "entryPath", { value: "note.md" });
	Object.defineProperty(fakeDoc, "editLock", { value: false });
	Object.defineProperty(fakeDoc, "resourceAddress", { value: {} });
	Object.defineProperty(fakeDoc, "awaitFirstSync", { value: async () => {} });
	Object.defineProperty(fakeDoc, "content", { get: () => state.remote });
	Object.defineProperty(fakeDoc, "connectionIntent", { get: () => "disconnected" });
	Object.defineProperty(fakeDoc, "bringOnline", { value: async () => true });
	Object.defineProperty(fakeDoc, "onceOnline", { value: async () => {} });
	Object.defineProperty(fakeDoc, "goOffline", { value: () => {} });
	Object.defineProperty(fakeDoc, "getSyncBase", { value: async () => state.syncBase });
	Object.defineProperty(fakeDoc, "setSyncBase", {
		value: async (t: string) => {
			state.syncBase = t;
		},
	});
	Object.defineProperty(fakeDoc, "vaultShare", {
		value: {
			readContents: async () => {
				if (state.vault === null) throw new Error("ENOENT");
				return state.vault;
			},
			writeConflictCopy,
			writeContents,
			folderIndex: { tracks: () => true },
			credentialCache: { dropFromQueue: () => {} },
		},
	});
	return { fakeDoc, writeConflictCopy, writeContents };
}

function makeQueue(): TransferQueue {
	const q = new TransferQueue({} as never, new InstantClock(), {} as never);
	jest.spyOn(q, "enqueueUpload").mockResolvedValue(undefined);
	return q;
}

describe("A: no 0-byte conflict copies", () => {
	test("pullIfUnchanged: file not on disk yet, stale non-empty syncBase -> relay content lands, no copy", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vault: null,
			remote: "relay text v2",
			syncBase: "relay text v1",
		});
		await makeQueue().pullIfUnchanged(fakeDoc);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "relay text v2");
	});

	test("pullIfUnchanged: genuinely empty file, diverged base -> no copy either", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			vault: "",
			remote: "relay text v2",
			syncBase: "relay text v1",
		});
		await makeQueue().pullIfUnchanged(fakeDoc);
		expect(writeConflictCopy).not.toHaveBeenCalled();
	});

	test("reconcileWithConflictCopy: empty Y.Text is not preserved, vault content is applied", async () => {
		const ydoc = new Y.Doc();
		const write = jest.fn<(c: string) => Promise<string>>().mockResolvedValue("x");
		const r = await reconcileWithConflictCopy(ydoc, "local text", write);
		expect(write).not.toHaveBeenCalled();
		expect(r.reconciled).toBe(true);
		expect(ydoc.getText("contents").toJSON()).toBe("local text");
	});
});

describe("B: line-ending-only differences are not conflicts", () => {
	test("pullIfUnchanged: vault CRLF vs relay LF -> no conflict copy", async () => {
		const { fakeDoc, writeConflictCopy } = makeFakeDoc({
			vault: "a\r\nb\r\n",
			remote: "a\nb\n",
			syncBase: "a\nb\n",
		});
		await makeQueue().pullIfUnchanged(fakeDoc);
		expect(writeConflictCopy).not.toHaveBeenCalled();
	});

	test("pullIfUnchanged: base differs from vault only by line endings, relay moved -> no copy", async () => {
		const { fakeDoc, writeConflictCopy, writeContents } = makeFakeDoc({
			vault: "a\r\nb\r\n",
			remote: "a\nb\nc\n",
			syncBase: "a\nb\n",
		});
		await makeQueue().pullIfUnchanged(fakeDoc);
		expect(writeConflictCopy).not.toHaveBeenCalled();
		expect(writeContents).toHaveBeenCalledWith(fakeDoc, "a\nb\nc\n");
	});

	test("reconcileWithConflictCopy: CRLF vs LF is already reconciled, no copy, Y.Text untouched", async () => {
		const ydoc = new Y.Doc();
		ydoc.getText("contents").insert(0, "line\n");
		const write = jest.fn<(c: string) => Promise<string>>().mockResolvedValue("x");
		const r = await reconcileWithConflictCopy(ydoc, "line\r\n", write);
		expect(write).not.toHaveBeenCalled();
		expect(r.reconciled).toBe(false);
		expect(ydoc.getText("contents").toJSON()).toBe("line\n");
	});

	test("hasUnsyncedEdit ignores line endings", () => {
		expect(hasUnsyncedEdit("a\r\nb", "a\nb")).toBe(false);
		expect(hasUnsyncedEdit("a\nb!", "a\nb")).toBe(true);
	});
});

describe("C: conflict copies are not synced", () => {
	test("isConflictCopyPath recognises the plugin's own labels, also nested", () => {
		expect(isConflictCopyPath("n (relay conflict 2026-10-01T10-00-00-000Z).md")).toBe(true);
		expect(isConflictCopyPath("d/n (relay deleted 2026-10-01T10-00-00-000Z).md")).toBe(true);
		expect(
			isConflictCopyPath("n (relay conflict A) (relay conflict B).md"),
		).toBe(true);
		expect(isConflictCopyPath("n.md")).toBe(false);
		expect(isConflictCopyPath("notes about (relay conflict) handling.md")).toBe(false);
		expect(isConflictCopyPath("meeting (draft).md")).toBe(false);
	});

	test("VaultShare.isSyncableVaultFile rejects conflict copies, accepts the original", () => {
		const fake = {
			containsPath: () => true,
			toVirtualPath: (p: string) => p,
			folderIndex: { isSyncable: () => true },
			attachmentSettings: { isFileTypeAllowed: () => true },
		};
		const isSyncable = (VaultShare.prototype as unknown as {
			isSyncableVaultFile: (this: unknown, f: { path: string }) => boolean;
		}).isSyncableVaultFile;
		expect(isSyncable.call(fake, { path: "s/note.md" })).toBe(true);
		expect(isSyncable.call(fake, { path: "s/note (relay conflict 2026-10-01T10-00-00-000Z).md" })).toBe(false);
	});
});

describe("A2: whitespace-only content is preserved", () => {
	test("hasPreservableContent: empty is not, whitespace-only is", () => {
		expect(hasPreservableContent("")).toBe(false);
		expect(hasPreservableContent("\n")).toBe(true);
		expect(hasPreservableContent("  \t")).toBe(true);
	});
});
