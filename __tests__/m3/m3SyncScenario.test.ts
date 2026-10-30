/**
 * M3 receipt: the real pull code, two completed syncs on a disposable relay.
 *
 *   npx jest __tests__/m3                                # synthetic fixture
 *   M3_FIXTURE=<file> M3_RECEIPT_OUT=<file> npx jest __tests__/m3/m3SyncScenario.test.ts
 *
 * See __tests__/m3/README.md for the private-copy run and the output limits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, test, expect } from "@jest/globals";
import { runM3Scenario, SYNTHETIC_FIXTURE, type M3Fixture, type M3Result } from "./scenario";

const REPO = path.resolve(__dirname, "../..");

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** What the receipt is bound to: the commit and a digest of the code under test. */
function codeIdentity() {
	const files = git("ls-files", "src").split("\n").sort();
	const hash = createHash("sha256");
	for (const f of files) hash.update(f).update("\0").update(fs.readFileSync(path.join(REPO, f)));
	return { head: git("rev-parse", "HEAD"), src_sha256: hash.digest("hex"), src_files: files.length };
}

/** Receipt fields only: sizes, digests and booleans, never note text. */
function redact(r: M3Result) {
	const { _relayText, ...rest } = r;
	void _relayText;
	return rest;
}

function loadFixture(): { fixture: M3Fixture; source: string } {
	const file = process.env.M3_FIXTURE;
	if (!file) return { fixture: SYNTHETIC_FIXTURE, source: "synthetic" };
	const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as M3Fixture;
	for (const key of ["entryPath", "agreedText", "peerAppend"] as const) {
		if (typeof fixture[key] !== "string" || fixture[key] === "") throw new Error(`fixture is missing ${key}`);
	}
	return { fixture, source: "private-copy" };
}

describe("M3: two completed syncs, peer edit on disk, conflict copy kept", () => {
	const { fixture, source } = loadFixture();
	const receipts: Record<string, unknown> = {};

	test("a local edit never uploaded: the peer's text lands and the local edit is kept in a conflict copy", async () => {
		const withEdit: M3Fixture = { ...fixture, localEdit: fixture.localEdit ?? SYNTHETIC_FIXTURE.localEdit };
		const r = await runM3Scenario(withEdit);
		receipts.with_local_edit = redact(r);
		expect(r.completedSyncs).toBeGreaterThanOrEqual(2);
		expect(r.vaultAfter).not.toEqual(r.vaultBefore);
		expect(r.vaultAfterEqualsPeerText).toBe(true);
		expect(r.conflictCopies).toHaveLength(1);
		expect(r.conflictCopyKeepsLocalEdit).toBe(true);
	}, 60_000);

	test("no local edit: the peer's text lands, nothing to keep", async () => {
		const r = await runM3Scenario({ ...fixture, localEdit: undefined });
		receipts.without_local_edit = redact(r);
		expect(r.completedSyncs).toBeGreaterThanOrEqual(2);
		expect(r.vaultAfterEqualsPeerText).toBe(true);
		expect(r.conflictCopies).toEqual([]);
	}, 60_000);

	test("RED control: one completed sync is not enough, the file stays as it was", async () => {
		const r = await runM3Scenario({ ...fixture, localEdit: undefined }, { maxPulls: 1 });
		expect(r.completedSyncs).toBe(1);
		expect(r.vaultAfter).toEqual(r.vaultBefore);
		expect(r.vaultAfterEqualsPeerText).toBe(false);
	}, 60_000);

	test("receipt", () => {
		const receipt = {
			scenario: "m3-isolated-sync",
			fixture: source,
			candidate: codeIdentity(),
			command: "npx jest __tests__/m3",
			results: receipts,
		};
		const out = process.env.M3_RECEIPT_OUT;
		if (out) fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
		else console.log(JSON.stringify(receipt, null, 2));
		expect(Object.keys(receipts)).toHaveLength(2);
	});
});
