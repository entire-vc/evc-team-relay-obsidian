import * as fs from "fs";
import * as path from "path";

/**
 * Guards the SHIPPED call sites in BillingView.svelte, not the helpers they
 * call (`__tests__/billingMoney.test.ts` covers those).
 *
 * Why a source scan rather than a behaviour test: this repo has no Svelte
 * component harness (no @testing-library/svelte), so the component itself
 * cannot be mounted in jest. Without this file the helper tests would pass
 * in full while BillingView still contained `if (result.checkout_url)` and
 * `currency === "USD" ? "$" : currency` -- a green suite proving only that
 * the replacements exist somewhere, never that the screen uses them. That is
 * exactly the "a red control that reverts a dependency proves the dependency
 * is covered, not that the shipped call site is wired" trap, so the asserts
 * below are written against the one file whose behaviour is at stake.
 *
 * Honest limit: this proves the defective SHAPES are gone and the helpers are
 * referenced. It cannot prove the rendered pixels are right -- that is what
 * the 1440/393 screenshots and the live two-case checkout demo on the task
 * are for.
 */
const BILLING_VIEW = path.join(__dirname, "..", "src", "components", "BillingView.svelte");

function source(): string {
	return fs.readFileSync(BILLING_VIEW, "utf8");
}

/** Drops `//` comment lines so prose describing a defect isn't read as one. */
function codeLines(): string[] {
	return source()
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

describe("BillingView.svelte call sites", () => {
	// Guards against the whole file being renamed/moved out from under these
	// asserts, which would otherwise make every test below vacuously pass.
	it("still exists and is non-trivial", () => {
		expect(fs.existsSync(BILLING_VIEW)).toBe(true);
		expect(source().length).toBeGreaterThan(1000);
	});

	describe("currency (defect 1)", () => {
		it("contains no ternary that treats non-USD as its own symbol", () => {
			// The exact defect: `const sym = currency === "USD" ? "$" : currency`,
			// which printed "RUB290".
			const offenders = codeLines().filter((l) =>
				/===\s*"USD"\s*\?/.test(l),
			);
			expect(offenders).toEqual([]);
		});

		it("delegates amount formatting to the money module", () => {
			expect(source()).toContain('from "../billing/money"');
			expect(source()).toMatch(/formatAmount\(/);
		});

		it("formats both price call sites through it -- getPlanPrice too, not just formatPrice", () => {
			// getPlanPrice carried its own duplicate of the defect. It must not
			// build a price string itself any more.
			const getPlanPrice = source().slice(
				source().indexOf("function getPlanPrice"),
				source().indexOf("const NO_PRICE"),
			);
			expect(getPlanPrice.length).toBeGreaterThan(0);
			expect(getPlanPrice).toMatch(/formatPrice\(|formatAmount\(/);
			expect(getPlanPrice).not.toMatch(/\/mo|\/yr/);
		});
	});

	describe("period labels (defect 2)", () => {
		it("hardcodes neither 'mo' nor 'yr' as a literal", () => {
			const offenders = codeLines().filter((l) =>
				/["'`]\/?(?:mo|yr)["'`]/.test(l),
			);
			expect(offenders).toEqual([]);
		});

		it("reads them from the phrasebook instead", () => {
			expect(source()).toContain('uiText("billing.period.month")');
			expect(source()).toContain('uiText("billing.period.year")');
		});
	});

	describe("checkout honesty (defect 3)", () => {
		it("never tests checkout_url for bare truthiness before opening it", () => {
			// `if (result.checkout_url) { window.open(...) }` is the incident.
			const offenders = codeLines().filter((l) =>
				/if\s*\(\s*result\.checkout_url\s*\)/.test(l),
			);
			expect(offenders).toEqual([]);
		});

		it("gates window.open on isOpenableUrl", () => {
			expect(source()).toContain('from "../billing/openableUrl"');
			expect(source()).toMatch(/isOpenableUrl\(checkoutUrl\)/);
			expect(source()).toMatch(/window\.open\(checkoutUrl\)/);
		});

		it("applies the same gate to the portal url", () => {
			expect(source()).toMatch(/isOpenableUrl\(result\.url\)/);
			expect(codeLines().filter((l) => /if\s*\(\s*result\.url\s*\)/.test(l))).toEqual([]);
		});

		it("shows OUR copy on an unopenable url, never the server's message", () => {
			// The server says "Billing is in stub mode..."; that must not be
			// what a buyer or a bank reads off this screen.
			expect(source()).toContain("checkoutComingSoon = true");
			expect(source()).toContain('uiText("billing.checkoutComingSoonNote")');
			expect(
				codeLines().filter((l) => /Notice\(result\.message \|\| uiText\("billing\.checkout/.test(l)),
			).toEqual([]);
		});

		it("keeps the pay button on screen in a Soon state rather than removing it", () => {
			// An empty space tells a bank nothing; a button saying what is
			// happening tells it the mechanism exists.
			expect(source()).toContain('uiText("billing.comingSoonButton")');
			expect(source()).toMatch(/disabled=\{checkingOut \|\| checkoutComingSoon\}/);
		});

		// Every server `message` on this screen is now our copy instead. The
		// server has a stub branch on all three paths, and each one carries the
		// words "stub mode" into a Notice if surfaced.
		it("surfaces no server message anywhere on this screen", () => {
			expect(codeLines().filter((l) => /Notice\(result\.message/.test(l))).toEqual([]);
		});

		it("does not surface the server message on the portal path either", () => {
			expect(codeLines().filter((l) => /result\.message \|\| uiText\("billing\.portalNotAvailable"\)/.test(l))).toEqual([]);
		});

		it("does not special-case the stub marker by name", () => {
			// Matching "#stub-..." would pass today's one known response and
			// break on the next service reply that isn't a URL. Scanned over
			// code lines only -- the component names the marker in a comment
			// on purpose, to record what the incident actually looked like.
			expect(codeLines().filter((l) => l.includes("stub-checkout"))).toEqual([]);
		});

		// finding 2: the RU catalogue moved off
		// BILLING_STUB_MODE, and its real backend throws (422 "Invalid billing
		// data") when the payment gateway isn't active yet -- a DIFFERENT
		// failure shape than the non-URL stub response the tests above cover.
		// The checkout code was tested against a scenario the real backend had
		// already stopped producing: a thrown error still fell through to the
		// generic `catch` and put `e.message` -- raw backend English -- on
		// screen via billing.upgradeFailedNotice.
		describe("checkout failure honesty -- thrown errors, not just non-URL responses (defect from)", () => {
			function handleUpgradeBody(): string {
				const start = source().indexOf("async function handleUpgrade");
				const end = source().indexOf("async function handleManageSubscription");
				expect(start).toBeGreaterThan(-1);
				expect(end).toBeGreaterThan(start);
				return source().slice(start, end);
			}

			it("wraps createCheckout in its own try/catch, not just the outer one", () => {
				const body = handleUpgradeBody();
				const checkoutCallIdx = body.indexOf("createCheckout(");
				const tryIdx = body.lastIndexOf("try", checkoutCallIdx);
				const catchIdx = body.indexOf("catch", checkoutCallIdx);
				expect(checkoutCallIdx).toBeGreaterThan(-1);
				expect(tryIdx).toBeGreaterThan(-1);
				expect(catchIdx).toBeGreaterThan(checkoutCallIdx);
			});

			it("a thrown createCheckout error degrades to the SAME coming-soon state as a non-URL response", () => {
				const body = handleUpgradeBody();
				const checkoutCallIdx = body.indexOf("createCheckout(");
				const catchIdx = body.indexOf("catch", checkoutCallIdx);
				const catchBlockEnd = body.indexOf("}", body.indexOf("{", catchIdx));
				const catchBody = body.slice(catchIdx, catchBlockEnd);
				expect(catchBody).toMatch(/checkoutComingSoon = true/);
				expect(catchBody).toMatch(/uiText\("billing\.checkoutComingSoonNote"\)/);
			});

			it("never puts the caught error's own message on screen for a checkout failure", () => {
				const body = handleUpgradeBody();
				const checkoutCallIdx = body.indexOf("createCheckout(");
				const catchIdx = body.indexOf("catch", checkoutCallIdx);
				const catchBlockEnd = body.indexOf("}", body.indexOf("{", catchIdx));
				const catchBody = body.slice(catchIdx, catchBlockEnd);
				expect(catchBody).not.toMatch(/\.message/);
				expect(catchBody).not.toMatch(/upgradeFailedNotice/);
			});
		});
	});

	it("routes the fractional GB figure through the locale decimal mark", () => {
		expect(source()).toMatch(/localizeDecimal\(\(bytes \/ 1073741824\)\.toFixed\(1\)\)/);
		expect(source()).toContain('uiText("billing.decimalSeparator")');
	});

	// Finding from re-verification: reverting getPlanPrice to its old inline
	// logic left all 727 tests green, so the extraction was unguarded -- the
	// module was tested, its use was not.
	it("delegates the price choice to selectDisplayPrice, not a local copy", () => {
		expect(source()).toContain('from "../billing/planPrice"');
		expect(source()).toMatch(/selectDisplayPrice\(plan\)/);
		const body = source().slice(
			source().indexOf("function getPlanPrice"),
			source().indexOf("const NO_PRICE"),
		);
		expect(body.length).toBeGreaterThan(0);
		// The three-way decision must NOT be re-implemented inline.
		expect(body).not.toMatch(/prices\.find\(/);
		expect(body).not.toMatch(/amount === 0/);
	});

	//: `max_file_size_bytes`/`version_history_days` printed their raw
	// snake_case key, and the boolean-shaped `roles_enabled`/
	// `closing_docs_edo_enabled` printed "Без ограничений"/"Unlimited" -- a
	// count claim on a yes/no feature -- because the render loop had no shape
	// dispatch at all, just a numeric formatter and a `|| key` label fallback.
	describe("entitlement row rendering", () => {
		function entitlementLoopBody(): string {
			const start = source().indexOf('Object.entries(plan.entitlements');
			const end = source().indexOf("<!-- Action -->");
			expect(start).toBeGreaterThan(-1);
			expect(end).toBeGreaterThan(start);
			return source().slice(start, end);
		}

		it("delegates shape classification to classifyEntitlement, not a local copy", () => {
			expect(source()).toContain('from "../billing/entitlements"');
			expect(entitlementLoopBody()).toMatch(/classifyEntitlement\(value\)/);
			// The two-branch numeric-only decision this replaces must not
			// reappear inline in the loop.
			expect(entitlementLoopBody()).not.toMatch(/"limit"\s*in\s*value/);
			expect(entitlementLoopBody()).not.toMatch(/typeof value === "number"/);
		});

		it("never falls back to the raw key as a label", () => {
			// `ENTITLEMENT_LABELS[key] || key` is exactly how "max_file_size_bytes"
			// and "version_history_days" reached the screen as themselves.
			expect(entitlementLoopBody()).not.toMatch(/ENTITLEMENT_LABELS\[key\]\s*\|\|\s*key/);
			expect(entitlementLoopBody()).toMatch(/ENTITLEMENT_LABELS\[key\]/);
		});

		it("routes byte-valued keys through a set, not a single hardcoded key", () => {
			// `key === "max_storage_bytes" ? formatBytes(...) : formatLimit(...)`
			// is exactly the check that left max_file_size_bytes on the numeric
			// (non-byte) formatter path.
			expect(source()).toContain('from "../billing/entitlements"');
			expect(entitlementLoopBody()).toMatch(/BYTE_VALUED_ENTITLEMENTS\.has\(key\)/);
			expect(entitlementLoopBody()).not.toMatch(/key === "max_storage_bytes"/);
		});

		it("never routes a flag-shaped entitlement through formatLimit/formatBytes", () => {
			const body = entitlementLoopBody();
			const flagBranchStart = body.indexOf('"flag"');
			expect(flagBranchStart).toBeGreaterThan(-1);
			// The "flag" branch is the `{:else if}`/its body -- check the whole
			// loop doesn't call formatLimit/formatBytes with anything but
			// display.limit (the "limit" branch's own field).
			expect(body).not.toMatch(/formatLimit\(display\.enabled/);
			expect(body).not.toMatch(/formatBytes\(display\.enabled/);
		});

		it("shows a disabled flag as no row, not as an explicit off-state or a limit", () => {
			const body = entitlementLoopBody();
			expect(body).toMatch(/display\.kind === "flag" && display\.enabled/);
		});

		// AC#5: the USD/entire.vc lineup doesn't ship
		// max_file_size_bytes/version_history_days/roles_enabled/
		// closing_docs_edo_enabled today, but the fix must not be a RU-only
		// patch -- the day any of these appear on a USD plan, they must render
		// the same way. Asserted structurally: the entitlement loop dispatches
		// purely on `key`/`value` shape, never on the plan's own currency or
		// service_id.
		it("dispatches on key/value shape only -- no currency or service_id special-casing", () => {
			const body = entitlementLoopBody();
			expect(body).not.toMatch(/currency/);
			expect(body).not.toMatch(/service_id/);
			expect(body).not.toMatch(/"USD"|"RUB"/);
		});
	});

	describe("no English left hardcoded on the screen", () => {
		it.each([
			"Billing & Plan",
			"Loading billing info...",
			"Your Usage",
			"Current plan",
			"Limit reached",
			"Resubscribe",
			"Unlimited",
			"Opening checkout in browser...",
			"Subscription activated!",
			"Members per share",
		])("no longer contains the literal %p", (literal) => {
			expect(source()).not.toContain(`"${literal}"`);
			expect(source()).not.toContain(`>${literal}<`);
		});
	});
});
