/**
 * GH #114: the pure parts of the attach check -- the dialog
 * model, the order of writes per choice, the backup path rule, the declined
 * auto-connect list and the one result notice.
 */

import { describe, expect, jest, test } from "@jest/globals";
import {
	ATTACH_BACKUP_ROOT,
	applyAttachChoice,
	attachBackupFolder,
	buildAttachReviewModel,
	compareWithServer,
	isAttachBackupPath,
	isAttachDeclined,
	keepBothCopyLabel,
	withDeclinedAttach,
	withoutDeclinedAttach,
	type AttachApplyPorts,
	type AttachDifference,
	type AttachEntry,
} from "../src/attachReview";
import { formatAttachChoiceSummary } from "../src/attachConflictSummary";
import { buildConflictCopyPath, isConflictCopyPath } from "../src/conflictCopyPath";
import { sameTextContent } from "../src/textEquivalence";
import { attachReviewListItems, attachReviewTitle } from "../src/ui/AttachReviewModal";

function entry(vpath: string, local: string | null, server: string | null): AttachEntry {
	return {
		vpath,
		readLocal: async () => local,
		readServer: async () => server,
		same: sameTextContent,
	};
}

function differences(n: number): AttachDifference[] {
	return Array.from({ length: n }, (_, i) => {
		const vpath = `note-${String(i + 1).padStart(2, "0")}.md`;
		return { entry: entry(vpath, `local ${i}`, `server ${i}`), local: `local ${i}`, server: `server ${i}` };
	});
}

describe("dialog model (AC1, AC5)", () => {
	test("12 differing notes: the first 10 by path and +2 more", () => {
		const model = buildAttachReviewModel("Projects", differences(12), true, "Team Relay backups/Projects x");
		expect(model.count).toBe(12);
		expect(model.paths).toHaveLength(10);
		expect(model.more).toBe(2);
		expect(attachReviewListItems(model)).toEqual([...model.paths, "+2 more"]);
		expect(attachReviewTitle(model)).toBe("12 notes differ from the shared folder");
		expect(attachReviewTitle({ count: 1 })).toBe("1 note differs from the shared folder");
	});

	test("without write access keep local is unavailable; with it, available", () => {
		expect(buildAttachReviewModel("P", differences(3), false, "b").canKeepLocal).toBe(false);
		expect(buildAttachReviewModel("P", differences(3), true, "b").canKeepLocal).toBe(true);
	});
});

describe("compare", () => {
	test("CRLF is not a difference; an empty server note is one; unreadable is reported", async () => {
		const outcome = await compareWithServer([
			entry("crlf.md", "a\r\nb\r\n", "a\nb\n"),
			entry("diff.md", "mine", "theirs"),
			entry("empty.md", "mine", ""),
			entry("offline.md", "mine", null),
		]);
		expect(outcome.agreed.map((e) => e.vpath)).toEqual(["crlf.md"]);
		// A peer may have cleared the note on purpose: uploading over it is a choice too.
		expect(outcome.differing.map((d) => d.entry.vpath)).toEqual(["diff.md", "empty.md"]);
		expect(outcome.unreadable.map((e) => e.vpath)).toEqual(["offline.md"]);
	});

	test("at most 4 notes are read at once, and cancel stops the walk", async () => {
		let inFlight = 0;
		let peak = 0;
		let cancelled = false;
		const slow = (vpath: string): AttachEntry => ({
			...entry(vpath, "l", "s"),
			readServer: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setImmediate(r));
				inFlight--;
				if (vpath === "n-05.md") cancelled = true;
				return "s";
			},
		});
		const entries = Array.from({ length: 20 }, (_, i) => slow(`n-${String(i + 1).padStart(2, "0")}.md`));
		const outcome = await compareWithServer(entries, { isCancelled: () => cancelled });
		expect(peak).toBeLessThanOrEqual(4);
		expect(outcome.cancelled).toBe(true);
		expect(outcome.differing.length).toBeLessThan(20);
	});
});

describe("an unreadable local file is never taken for an empty note", () => {
	test("compare: a failed disk read is unreadable, not a difference", async () => {
		const outcome = await compareWithServer([entry("locked.md", null, "server text")]);
		expect(outcome.unreadable.map((e) => e.vpath)).toEqual(["locked.md"]);
		expect(outcome.differing).toEqual([]);
	});

	test.each(["keep-both", "keep-server", "keep-local"] as const)(
		"%s: the disk read fails at apply time -> nothing is written anywhere",
		async (choice) => {
			const writes: string[] = [];
			const record = (what: string) => async () => {
				writes.push(what);
				return what;
			};
			const ports: AttachApplyPorts = {
				writeDisk: async () => {
					writes.push("disk");
				},
				writeLocalCopy: record("copy"),
				writeBackup: record("backup"),
				replaceServer: async () => {
					writes.push("server");
					return true;
				},
				markAgreed: async () => {
					writes.push("agreed");
				},
			};
			const outcome = await applyAttachChoice(
				choice,
				[{ entry: entry("locked.md", null, "server text"), local: "old", server: "server text" }],
				ports,
			);
			expect(writes).toEqual([]);
			expect(outcome.unresolved).toEqual(["locked.md"]);
		},
	);
});

describe("apply order: the overwritten side is saved first", () => {
	function ports(failing: "copy" | "backup" | "none") {
		const calls: string[] = [];
		const p: AttachApplyPorts = {
			writeDisk: jest.fn(async (e: AttachEntry) => {
				calls.push(`disk ${e.vpath}`);
			}),
			writeLocalCopy: jest.fn(async (e: AttachEntry) => {
				if (failing === "copy") throw new Error("disk full");
				calls.push(`copy ${e.vpath}`);
				return `${e.vpath} copy`;
			}),
			writeBackup: jest.fn(async (e: AttachEntry) => {
				if (failing === "backup") throw new Error("disk full");
				calls.push(`backup ${e.vpath}`);
				return `b/${e.vpath}`;
			}),
			replaceServer: jest.fn(async (e: AttachEntry, _local: string, preserve: (t: string) => Promise<void>) => {
				try {
					await preserve("server text");
				} catch {
					return false;
				}
				calls.push(`server ${e.vpath}`);
				return true;
			}),
			markAgreed: jest.fn(async (e: AttachEntry) => {
				calls.push(`agreed ${e.vpath}`);
			}),
		};
		return { p, calls };
	}

	test.each([
		["keep-both", "copy", ["copy x.md", "disk x.md", "agreed x.md"]],
		["keep-server", "backup", ["backup x.md", "disk x.md", "agreed x.md"]],
		["keep-local", "backup", ["backup x.md", "server x.md", "agreed x.md"]],
	] as const)("%s writes in order, and touches nothing when the %s fails", async (choice, failing, order) => {
		const ok = ports("none");
		const done = await applyAttachChoice(choice, [{ entry: entry("x.md", "l", "s"), local: "l", server: "s" }], ok.p);
		expect(ok.calls).toEqual(order);
		expect(done.resolved).toEqual(["x.md"]);

		const bad = ports(failing);
		const failed = await applyAttachChoice(choice, [{ entry: entry("x.md", "l", "s"), local: "l", server: "s" }], bad.p);
		expect(bad.calls).toEqual([]);
		expect(failed.unresolved).toEqual(["x.md"]);
	});
});

describe("paths", () => {
	test("backup folder: under the vault root, named after the folder and the local time", () => {
		const now = new Date(2026, 10, 25, 9, 5);
		expect(attachBackupFolder("Projects", now)).toBe(`${ATTACH_BACKUP_ROOT}/Projects 2026-11-25 09-05`);
		expect(attachBackupFolder("", now)).toBe(`${ATTACH_BACKUP_ROOT}/Vault 2026-11-25 09-05`);
	});

	test("isAttachBackupPath: the folder and everything inside, nothing else", () => {
		expect(isAttachBackupPath("Team Relay backups")).toBe(true);
		expect(isAttachBackupPath("Team Relay backups/P 2026/a.md")).toBe(true);
		expect(isAttachBackupPath("Team Relay backups 2/a.md")).toBe(false);
		expect(isAttachBackupPath("Projects/Team Relay backups/a.md")).toBe(false);
	});

	test("keep both's copy is a conflict copy (stays local, GH #4)", () => {
		const copy = buildConflictCopyPath("notes/a.md", keepBothCopyLabel(new Date("2026-11-25T13:00:00Z")));
		expect(isConflictCopyPath(copy)).toBe(true);
		expect(isConflictCopyPath(`Projects/${copy}`)).toBe(true);
	});
});

describe("declined auto-connect (AC3)", () => {
	test("record -> check -> forget, keyed by share id and path", () => {
		const declined = withDeclinedAttach(undefined, "share-1", "Projects");
		expect(isAttachDeclined(declined, "share-1", "Projects")).toBe(true);
		expect(isAttachDeclined(declined, "share-1", "Other")).toBe(false);
		expect(isAttachDeclined(declined, "share-2", "Projects")).toBe(false);
		expect(withDeclinedAttach(declined, "share-1", "Projects")).toEqual(declined);
		expect(isAttachDeclined(withoutDeclinedAttach(declined, "share-1", "Projects"), "share-1", "Projects")).toBe(false);
	});
});

describe("result notice (single summary notice)", () => {
	test.each([
		["keep-both", "kept the server version; local copies created: a (copy).md"],
		["keep-server", "kept the server version; local versions saved to B"],
		["keep-local", "kept the local version; server versions saved to B"],
	] as const)("%s", (choice, text) => {
		const summary = formatAttachChoiceSummary("Projects", {
			choice,
			differed: 2,
			copies: choice === "keep-both" ? ["a (copy).md"] : [],
			backupFolder: "B",
			unresolved: [],
		});
		expect(summary).toBe(`Team Relay (Projects): 2 files differed between local and server; ${text}`);
	});

	test("partly failed: the untouched notes are named", () => {
		const summary = formatAttachChoiceSummary("P", {
			choice: "keep-server",
			differed: 2,
			copies: [],
			backupFolder: "B",
			unresolved: ["b.md"],
		});
		expect(summary).toBe(
			"Team Relay (P): 2 files differed between local and server; kept the server version; local versions saved to B. Not changed, the copy could not be saved: b.md",
		);
	});
});
