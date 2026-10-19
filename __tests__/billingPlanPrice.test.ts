import { selectDisplayPrice } from "../src/billing/planPrice";

const price = (amount: number, billing_period: string, currency = "RUB") => ({
	id: `p-${amount}-${billing_period}`, amount, currency, billing_period,
});

describe("selectDisplayPrice", () => {
	it("picks the monthly price when there is one", () => {
		const r = selectDisplayPrice({ prices: [price(279000, "year"), price(29000, "month")] });
		expect(r).toEqual({ kind: "price", price: price(29000, "month") });
	});

	it("reports an explicit zero price as free", () => {
		expect(selectDisplayPrice({ prices: [price(0, "month")] })).toEqual({ kind: "free" });
	});

	// The defect this module exists for: "Организация" is quoted on request
	// and carries no price row, and the old code called that Free.
	it("reports NO price as none -- never as free", () => {
		const r = selectDisplayPrice({ prices: [] });
		expect(r).toEqual({ kind: "none" });
		expect(r.kind).not.toBe("free");
	});

	it("treats a missing prices field the same as an empty one", () => {
		expect(selectDisplayPrice({ prices: undefined as never })).toEqual({ kind: "none" });
	});

	// A yearly-only plan is paid, not free.
	it("falls back to a yearly price rather than claiming free", () => {
		const r = selectDisplayPrice({ prices: [price(849000, "year")] });
		expect(r).toEqual({ kind: "price", price: price(849000, "year") });
	});

	// Positive control: the entire.vc contour's two plans must resolve exactly
	// as they did before this module existed.
	it("resolves the entire.vc Free plan to free", () => {
		expect(selectDisplayPrice({ prices: [price(0, "month", "USD")] })).toEqual({ kind: "free" });
	});

	it("resolves the entire.vc Builder plan to its monthly price, not its yearly", () => {
		const r = selectDisplayPrice({
			prices: [price(900, "month", "USD"), price(9000, "year", "USD")],
		});
		expect(r).toEqual({ kind: "price", price: price(900, "month", "USD") });
	});
});
