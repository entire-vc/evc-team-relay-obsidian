import type { AvailablePlan } from "../RelayOnPremShareClient";

type Price = AvailablePlan["prices"][number];

/**
 * What a plan card should show as its headline price.
 *
 * Three outcomes, kept apart because conflating the last two is the bug this
 * replaces:
 *   - `{ kind: "price" }` -- show this price
 *   - `{ kind: "free" }`  -- the plan carries an explicit zero price
 *   - `{ kind: "none" }`  -- the server named NO price for this plan
 */
export type DisplayPrice =
	| { kind: "price"; price: Price }
	| { kind: "free" }
	| { kind: "none" };

/**
 * The old rule was `if (!monthly || monthly.amount === 0) return "Free"`,
 * which reads "no price" and "price is zero" as the same thing. They are not:
 * the RU catalogue's "Организация" tier is quoted on request and carries no
 * price row at all, so a paid enterprise plan rendered as free -- on a screen
 * being sent to a bank.
 *
 * Absence is not zero. A plan with no monthly price falls back to whatever
 * price it does have (a yearly-only plan should show its yearly price, not
 * claim to be free), and a plan with no prices at all reports `none` so the
 * caller can decline to state a price rather than invent one.
 *
 * Pure and i18n-free on purpose -- the caller owns the wording for `free` and
 * the placeholder for `none`.
 */
export function selectDisplayPrice(plan: Pick<AvailablePlan, "prices">): DisplayPrice {
	const prices = plan.prices ?? [];
	if (prices.length === 0) return { kind: "none" };

	const chosen = prices.find((p) => p.billing_period === "month") ?? prices[0];
	if (!chosen) return { kind: "none" };
	if (chosen.amount === 0) return { kind: "free" };
	return { kind: "price", price: chosen };
}
