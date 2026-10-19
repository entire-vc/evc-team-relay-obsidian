import { buildVaultIdentity } from "../src/vaultIdentity";

describe("buildVaultIdentity", () => {
	it("sends a stable vault_id and vault_name", () => {
		expect(buildVaultIdentity("abc123", "kanban")).toEqual({ vault_id: "abc123", vault_name: "kanban" });
	});

	it("two vaults produce distinct ids so a second whole-vault share is not a duplicate", () => {
		const a = buildVaultIdentity("id-a", "kanban");
		const b = buildVaultIdentity("id-b", "handbook");
		expect(a.vault_id).not.toEqual(b.vault_id);
	});

	it("omits vault_name when empty and everything when appId is missing (legacy)", () => {
		expect(buildVaultIdentity("abc123", "")).toEqual({ vault_id: "abc123" });
		expect(buildVaultIdentity("", "kanban")).toEqual({});
	});
});
