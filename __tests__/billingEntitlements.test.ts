import { BYTE_VALUED_ENTITLEMENTS, classifyEntitlement } from "../src/billing/entitlements";

//. Live prod RU catalogue (`GET https://cp.teamrelay.ru/v1/billing/plans`),
// "Командный" tier, is the exact repro these fixtures are copied from.

describe("classifyEntitlement -- numeric limits (the existing, still-correct shape)", () => {
	it.each([
		[{ limit: 10 }, 10],
		[{ limit: null }, null],
		[5, 5],
		[null, null],
		[undefined, null],
	])("classifies %j as a limit of %j", (value, expected) => {
		expect(classifyEntitlement(value)).toEqual({ kind: "limit", limit: expected });
	});
});

describe("classifyEntitlement -- boolean feature flags (the defect this replaces)", () => {
	// The exact two RU "Командный"-tier values from the live repro.
	it.each([
		["roles_enabled", { enabled: true }],
		["closing_docs_edo_enabled", { enabled: true }],
	])("classifies %s as a flag, never a limit", (_key, value) => {
		expect(classifyEntitlement(value)).toEqual({ kind: "flag", enabled: true });
	});

	it("classifies enabled: false as a flag too, not as an absent/null limit", () => {
		expect(classifyEntitlement({ enabled: false })).toEqual({ kind: "flag", enabled: false });
	});

	// The actual bug: before this module existed, `{ enabled: true }` had no
	// `.limit` field, so the old getEntitlementLimit() returned null, and
	// `formatLimit(null)` -- built for "no limit set" -- printed "Без
	// ограничений" for a plain yes/no feature. Assert the shapes are
	// distinguishable, which is what makes that conflation impossible now.
	it("a flag and a null-limit are NOT the same classification", () => {
		expect(classifyEntitlement({ enabled: true })).not.toEqual(
			classifyEntitlement({ limit: null }),
		);
	});
});

describe("classifyEntitlement -- unrecognised shapes", () => {
	// `allowed_web_visibility`'s shape, handled by BillingView's own
	// HIDDEN_ENTITLEMENTS before it would ever reach this function in
	// practice -- covered here anyway so the module's own contract doesn't
	// depend on the caller always filtering it out first.
	it("classifies a shape with neither .limit nor .enabled as unknown", () => {
		expect(classifyEntitlement({ allowed: ["public"] })).toEqual({ kind: "unknown" });
	});

	it("classifies a string, an array, and a non-boolean .enabled as unknown", () => {
		expect(classifyEntitlement("nonsense")).toEqual({ kind: "unknown" });
		expect(classifyEntitlement([1, 2, 3])).toEqual({ kind: "unknown" });
		expect(classifyEntitlement({ enabled: "yes" })).toEqual({ kind: "unknown" });
	});
});

describe("BYTE_VALUED_ENTITLEMENTS", () => {
	it("covers both byte-valued keys the RU catalogue ships today", () => {
		expect(BYTE_VALUED_ENTITLEMENTS.has("max_storage_bytes")).toBe(true);
		expect(BYTE_VALUED_ENTITLEMENTS.has("max_file_size_bytes")).toBe(true);
	});

	it("does not claim a day count or a share count is byte-valued", () => {
		expect(BYTE_VALUED_ENTITLEMENTS.has("version_history_days")).toBe(false);
		expect(BYTE_VALUED_ENTITLEMENTS.has("max_shares")).toBe(false);
	});
});
