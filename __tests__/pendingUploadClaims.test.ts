import { VaultShare } from "../src/VaultShare";
import { TFolder } from "obsidian";

type Anyish = Record<string, unknown>;

function makeShare(opts: { files: Record<string, boolean>; claims: string[]; folder?: boolean }) {
	const claims = new Map<string, string>(opts.claims.map((c) => [c, "g-" + c]));
	const warn = jest.fn();
	const nodes = new Map<string, unknown>();
	for (const p of Object.keys(opts.files)) nodes.set("Shared/" + p, { path: "Shared/" + p });
	if (opts.folder !== false) {
		const f: TFolder = Object.create(TFolder.prototype);
		f.path = "Shared";
		f.children = [];
		nodes.set("Shared", f);
	}
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared",
		uploadClaims: claims,
		warn,
		isTornDown: false,
		vaultApi: { getAbstractFileByPath: (p: string) => nodes.get(p) ?? null },
		absolutePath: (p: string) => "Shared/" + p,
		isDeletePending: () => false,
		toVirtualPath: (p: string) => p.replace(/^Shared\//, ""),
		isSyncableVaultFile: (t: { path: string }) => opts.files[t.path.replace(/^Shared\//, "")] === true,
		folderIndex: { tracks: () => false, new: jest.fn(), isSyncable: () => true },
		crdtDoc: { transact: (fn: () => void) => fn() },
		log: jest.fn(),
	});
	return { share: share as unknown as Anyish & VaultShare, claims, warn, nodes };
}

describe("pending upload claims", () => {
	test("claim for a non-syncable file is dropped, syncable file's claim is kept", () => {
		const { share, claims } = makeShare({
			files: { ".artifacts/a.bin": false, "note.md": true },
			claims: [".artifacts/a.bin", "note.md", "gone.md"],
		});
		(share as unknown as { _pruneStalePendingUploads(): void })._pruneStalePendingUploads();
		expect([...claims.keys()]).toEqual(["note.md"]);
		expect(share.pendingUploadCount()).toBe(1);
	});

	test("claimPaths never mints a guid for a non-syncable file", () => {
		const { share, nodes } = makeShare({ files: { ".artifacts/a.bin": false, "n.md": true }, claims: [] });
		const claimed = share.claimPaths([
			nodes.get("Shared/.artifacts/a.bin"),
			nodes.get("Shared/n.md"),
		] as never);
		expect(claimed).toEqual(["n.md"]);
	});

	test("share with no on-disk folder does not throw and warns once", () => {
		const { share, warn } = makeShare({ files: {}, claims: [], folder: false });
		const scope = (share as unknown as { vaultFilesInScope(): unknown[] });
		expect(scope.vaultFilesInScope()).toEqual([]);
		expect(scope.vaultFilesInScope()).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(share.folderMissing).toBe(true);
	});

	test("pending syncable claim triggers a retry and the file is not deleted", async () => {
		jest.useFakeTimers();
		const { share, claims } = makeShare({ files: { "n.md": true }, claims: ["n.md"] });
		const adopt = jest.fn().mockResolvedValue(undefined);
		Object.assign(share, { adoptLocalFiles: adopt });
		share._scheduleUploadRetry();
		await jest.advanceTimersByTimeAsync(61_000);
		expect(adopt).toHaveBeenCalledWith(false);
		expect(claims.has("n.md")).toBe(true);
		jest.useRealTimers();
	});
});
