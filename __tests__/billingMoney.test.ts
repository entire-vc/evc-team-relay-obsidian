import { formatAmount } from "../src/billing/money";
import { isOpenableUrl } from "../src/billing/openableUrl";

//. Two of these blocks are the acceptance criteria of that task
// expressed as asserts: the RU catalogue must render as the teamrelay.ru
// site already writes its prices, and the USD catalogue must not move at all
// while that happens.

describe("formatAmount -- RUB (the defect this replaces)", () => {
	// The exact four strings the task names, and the exact bytes the site
	// ships (src/pages/pricing/index.astro: '290 ₽', '2 790 ₽' -- plain
	// U+0020 both as group separator and before the symbol, verified with a
	// codepoint dump, NOT the U+00A0 Intl would produce).
	it.each([
		[29000, "290 ₽"],
		[89000, "890 ₽"],
		[279000, "2 790 ₽"],
		[849000, "8 490 ₽"],
	])("renders %i minor units as %s", (minor, expected) => {
		expect(formatAmount(minor, "RUB")).toBe(expected);
	});

	it("never emits the literal ISO code -- 'RUB290' is the bug", () => {
		expect(formatAmount(29000, "RUB")).not.toContain("RUB");
	});

	it("separates thousands with a PLAIN space (U+0020), not U+00A0", () => {
		const rendered = formatAmount(279000, "RUB");
		expect([...rendered].map((c) => c.codePointAt(0))).toEqual([
			0x32, 0x20, 0x37, 0x39, 0x30, 0x20, 0x20bd,
		]);
		expect(rendered).not.toContain(" ");
	});

	it("puts the symbol AFTER the number, with a space", () => {
		expect(formatAmount(29000, "RUB")).toMatch(/^\d[\d ]* ₽$/u);
	});

	it("does not group a three-digit amount", () => {
		expect(formatAmount(89000, "RUB")).toBe("890 ₽");
	});

	it("groups a seven-figure amount every three digits", () => {
		expect(formatAmount(123456700, "RUB")).toBe("1 234 567 ₽");
	});

	it("renders zero without a group separator", () => {
		expect(formatAmount(0, "RUB")).toBe("0 ₽");
	});
});

// POSITIVE CONTROL. Without this the RUB asserts above cannot distinguish
// "currency handling was fixed" from "currency handling was replaced by
// something that happens to suit RUB and broke the other contour".
describe("formatAmount -- USD (entire.vc contour, must not move)", () => {
	it("renders the Builder plan exactly as before the change", () => {
		expect(formatAmount(900, "USD")).toBe("$9");
	});

	it("renders a zero-priced plan as $0", () => {
		expect(formatAmount(0, "USD")).toBe("$0");
	});

	it("puts the symbol BEFORE the number with no space", () => {
		expect(formatAmount(900, "USD")).toMatch(/^\$\d+$/);
	});

	it("leaves USD ungrouped, as it was", () => {
		expect(formatAmount(100000, "USD")).toBe("$1000");
	});
});

describe("formatAmount -- other currencies", () => {
	it("knows the euro sign", () => {
		expect(formatAmount(900, "EUR")).toBe("€9");
	});

	it("accepts a lowercase / padded code from the wire", () => {
		expect(formatAmount(29000, " rub ")).toBe("290 ₽");
	});

	// The fallback must not reproduce the original defect's shape.
	it("puts an unknown ISO code AFTER the number, not glued in front", () => {
		expect(formatAmount(29000, "GBP")).toBe("290 GBP");
		expect(formatAmount(29000, "GBP")).not.toBe("GBP290");
	});

	it("renders a bare number when the server sent no currency at all", () => {
		expect(formatAmount(29000, "")).toBe("290");
	});
});

describe("isOpenableUrl", () => {
	// The exact value the stub billing backend returns, and the reason this
	// function exists: it is truthy, so `if (result.checkout_url)` opened a
	// junk window and claimed a checkout was loading.
	it("rejects the stub marker that caused the incident", () => {
		expect(isOpenableUrl("#stub-checkout-not-available")).toBe(false);
	});

	it("accepts a real https checkout link", () => {
		expect(isOpenableUrl("https://checkout.stripe.com/c/pay/cs_test_123")).toBe(true);
	});

	it("accepts plain http", () => {
		expect(isOpenableUrl("http://localhost:8000/pay")).toBe(true);
	});

	it.each([
		["empty string", ""],
		["whitespace only", "   "],
		["null", null],
		["undefined", undefined],
		["bare fragment", "#anything"],
		["relative path", "/v1/billing/checkout"],
		["scheme-less host", "checkout.stripe.com/pay"],
		["arbitrary prose", "Billing is in stub mode."],
	])("rejects %s", (_label, value) => {
		expect(isOpenableUrl(value as string | null | undefined)).toBe(false);
	});

	// Not the original bug, but the same call feeds window.open(), so a
	// control plane returning one of these must not be able to execute it.
	it.each(["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"])(
		"rejects the non-web scheme %s",
		(value) => {
			expect(isOpenableUrl(value)).toBe(false);
		},
	);

	it("tolerates surrounding whitespace on an otherwise valid link", () => {
		expect(isOpenableUrl("  https://checkout.stripe.com/x  ")).toBe(true);
	});
});
