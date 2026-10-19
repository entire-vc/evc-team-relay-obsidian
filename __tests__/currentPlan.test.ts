import { resolveCurrentPlanId } from "../src/billing/currentPlan";
import type { AvailablePlan } from "../src/RelayOnPremShareClient";

const plan = (id: string, name: string, amount: number): AvailablePlan => ({
	id,
	name,
	service_id: "relay",
	type: "subscription",
	status: "active",
	prices: [{ id: `${id}-m`, amount, currency: "RUB", billing_period: "month" }],
	entitlements: {},
	metadata: {},
});

// The reported defect: on a deployment where the paid plan carries no non-zero
// price, the old per-card logic classified BOTH cards as "the free one" and both
// rendered the Current badge. Whatever else this returns, it must never be true
// for two cards at once.
describe("resolveCurrentPlanId", () => {
	it("never marks two plans as current, even when both are priced at zero", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 0)];
		const id = resolveCurrentPlanId({ plan: "Relay Free" }, plans);
		const marked = plans.filter((p) => p.id === id);
		expect(marked.length).toBeLessThanOrEqual(1);
		expect(id).toBe("free");
	});

	it("picks the paid plan when the server names it", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "Relay Builder" }, plans)).toBe("builder");
	});

	it("picks nothing when the server names no plan", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "" }, plans)).toBeNull();
		expect(resolveCurrentPlanId(null, plans)).toBeNull();
	});

	it("picks nothing when ambiguous - none is better than two", () => {
		const plans = [plan("a", "Relay", 0), plan("b", "Relay", 900)];
		expect(resolveCurrentPlanId({ plan: "Relay" }, plans)).toBeNull();
	});

	it("tolerates case and surrounding whitespace in the name", () => {
		const plans = [plan("free", "  Relay Free ", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "relay free" }, plans)).toBe("free");
	});

	//: a server whose /plans response uses a different field name
	// for the identifier (e.g. `product_id` instead of `id`) still satisfies
	// the AvailablePlan cast in getAvailablePlans() at compile time -- the
	// mismatch only shows up at runtime, where the matched plan's `.id` is
	// `undefined`. The old code returned that `undefined` unconditionally;
	// BillingView.svelte then compared it against every OTHER plan's equally
	// `undefined` `.id` and marked all of them "Current" at once. A client/
	// server field-name mismatch must degrade to "no current plan", never to
	// "every plan is current".
	it("picks nothing when the matched plan has no id (client/server schema drift)", () => {
		const malformed = [
			{ ...plan("free", "Relay Free", 0), id: undefined as unknown as string },
			{ ...plan("builder", "Relay Builder", 900), id: undefined as unknown as string },
		];
		const id = resolveCurrentPlanId({ plan: "Relay Free" }, malformed);
		expect(id).toBeNull();
		const marked = malformed.filter((p) => p.id === id);
		expect(marked.length).toBe(0);
	});
});
