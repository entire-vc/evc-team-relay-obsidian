/**
 * What to show for one entitlement row on the plan-feature list.
 *
 *   - `{ kind: "limit" }` -- a count, possibly unlimited (`limit: null`)
 *   - `{ kind: "flag" }`  -- a yes/no feature. `enabled: false` means the
 *      caller should render nothing for this row, not a "no" -- on the
 *      catalogue we have today a disabled flag entitlement is simply absent
 *      from `entitlements` altogether (see the RU "Свободный"/"Личный"
 *      tiers, which never mention `roles_enabled` at all); a shown-but-off
 *      row would say something the absent case never says.
 *   - `{ kind: "unknown" }` -- neither shape recognised. The caller must NOT
 *      fall back to printing the raw key or routing it through the numeric
 *      formatter -- that fallback is the bug this module replaces. Treat it
 *      the same as "don't render this row" until it gets a real branch.
 */
export type EntitlementDisplay =
	| { kind: "limit"; limit: number | null }
	| { kind: "flag"; enabled: boolean }
	| { kind: "unknown" };

/**
 * Classifies one entitlement value by its SHAPE, never by its key name.
 *
 * The defect this replaces: `roles_enabled` and `closing_docs_edo_enabled`
 * arrived as `{ enabled: true }` -- a yes/no feature flag -- but the old
 * `getEntitlementLimit()` only knew `{ limit: number | null }` and bare
 * numbers. Neither shape has a `.limit` field, so it fell through to
 * `return null`, and the caller's `formatLimit(null)` reads "no limit
 * field" as "unlimited" and prints "Без ограничений" -- a claim about
 * *how many* on an entitlement that isn't a count at all.
 *
 * Shape-based dispatch (not a lookup table keyed on today's two flag names)
 * is deliberate: the next `{ enabled: bool }` entitlement the billing
 * service adds is handled correctly the day it ships, the same way this
 * pair should have been from the start.
 */
export function classifyEntitlement(value: unknown): EntitlementDisplay {
	if (value === null || value === undefined) return { kind: "limit", limit: null };
	if (typeof value === "number") return { kind: "limit", limit: value };

	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.enabled === "boolean") return { kind: "flag", enabled: obj.enabled };
		if ("limit" in obj) {
			return { kind: "limit", limit: typeof obj.limit === "number" ? obj.limit : null };
		}
	}

	return { kind: "unknown" };
}

/**
 * Entitlement keys whose limit is a byte count and should go through
 * `formatBytes`, not the bare-number `formatLimit`. `max_storage_bytes` was
 * the only one until the RU catalogue's `018_teamrelay_ru_pricing` migration
 * added `max_file_size_bytes` -- same unit, same formatter, just never added
 * to the set that decides which formatter a key gets.
 */
export const BYTE_VALUED_ENTITLEMENTS = new Set(["max_storage_bytes", "max_file_size_bytes"]);
