/**
 * Decides whether a value the server handed us is something we may actually
 * open in the user's browser.
 *
 * The defect this closes: the checkout handler tested `if (result.checkout_url)`
 * -- truthiness -- and the stub billing backend answers with
 * `"#stub-checkout-not-available"`, a non-empty string that is not a link.
 * The plugin therefore opened a junk window AND announced "Opening checkout in
 * browser...", telling the user their payment page was loading when no payment
 * path exists at all.
 *
 * Written as "is this an openable link?" rather than "is this the stub
 * marker?" on purpose. Matching `#stub-...` specifically would pass the one
 * response we happen to know about today and break on the next service reply
 * that isn't a URL -- an error object, an empty-ish placeholder, a relative
 * path. The question worth asking is the general one.
 *
 * Restricting to http/https (rather than "did `new URL()` parse?") also means
 * `javascript:`, `data:` and `file:` URLs can never reach `window.open`, even
 * if a compromised or misconfigured control plane returns one.
 */
export function isOpenableUrl(value: string | null | undefined): boolean {
	if (typeof value !== "string") return false;

	const trimmed = value.trim();
	if (trimmed === "") return false;

	let parsed: URL;
	try {
		// No base argument on purpose: a bare fragment or relative path must
		// FAIL here. Passing a base would helpfully resolve
		// "#stub-checkout-not-available" into a valid absolute URL and
		// reintroduce the exact bug this function exists to prevent.
		parsed = new URL(trimmed);
	} catch {
		return false;
	}

	return parsed.protocol === "http:" || parsed.protocol === "https:";
}
