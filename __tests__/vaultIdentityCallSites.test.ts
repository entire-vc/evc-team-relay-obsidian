import * as fs from "fs";
import * as path from "path";

/**
 * Guards the SHIPPED create-share call sites and the share list, not just the
 * `buildVaultIdentity` helper. The repo has no Svelte harness, so (as in
 * billingCallSites.test.ts) these are source scans: a green helper test alone
 * would pass even if a caller stopped sending vault_id.
 */
const SRC = path.join(__dirname, "..", "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("vault identity wiring (GH #265)", () => {
	it.each([
		"components/CreateShareView.svelte",
		"ui/QuickShareModal.ts",
		"ui/ShareManagementModal.ts",
	])("%s spreads buildVaultIdentity into the create-share request", (file) => {
		const code = read(file);
		expect(code).toMatch(/\.\.\.buildVaultIdentity\(\s*(live|this\.plugin)\.instanceAppId,/);
	});

	it("the client serializes the whole request, so vault fields reach the wire", () => {
		const code = read("RelayOnPremShareClient.ts");
		expect(code).toMatch(/vault_id\?: string/);
		expect(code).toMatch(/vault_name\?: string/);
		expect(code).toMatch(/body: JSON\.stringify\(request\)/);
	});

	it("the share list renders the returned vault_name", () => {
		expect(read("components/ShareListView.svelte")).toMatch(/share\.vault_name/);
	});
});
