/**
 * Unit tests: buildRedirectInterceptRegex / escapeForRegExp
 * (TR CodeQL js/incomplete-sanitization + js/incomplete-hostname-regexp, PR #166)
 *
 * AuthSession.ts itself can't be unit-tested in this repo (it imports
 * `pocketbase`, an ESM-only package Jest can't parse under the current
 * config — see AuthSessionExtensions.test.ts's header for the same wall).
 * `getWebviewIntercepts`'s Google/Microsoft static intercepts and the shared
 * `redirectInterceptRegex` helper are thin wrappers around
 * `buildRedirectInterceptRegex`, which is fully testable here.
 *
 * The bug: `createIntercept` escaped only `/` before handing a static
 * provider URL (e.g. "https://accounts.google.com/o/oauth2/auth") to
 * `redirectInterceptRegex`, which then interpolated it into a `new RegExp`
 * source string unescaped. The unescaped `.` in the hostname is a regex
 * "any character" wildcard, so the resulting pattern also matched a
 * lookalike host with `.` substituted for any other character (e.g.
 * "accountsXgoogle.com") — the exact CodeQL js/incomplete-hostname-regexp
 * shape. `redirectInterceptRegex` also interpolated `redirectUrl` (which
 * itself contains `.` and, once encodeURIComponent'd, `%2E`/`%3A` etc.) raw.
 */

import { describe, test, expect } from "@jest/globals";
import { buildRedirectInterceptRegex, escapeForRegExp } from "../src/AuthSessionExtensions";

describe("buildRedirectInterceptRegex", () => {
	const redirectUrl = "https://relay.example.com/api/oauth2-redirect";
	const googleAuthUrl = "https://accounts.google.com/o/oauth2/auth";

	test("matches a genuine Google auth-page navigation carrying our redirect_uri (raw form)", () => {
		const regex = buildRedirectInterceptRegex(googleAuthUrl, redirectUrl);
		const navigatedUrl = `${googleAuthUrl}?client_id=x&scope=y&redirect_uri=${redirectUrl}`;

		expect(regex.test(navigatedUrl)).toBe(true);
	});

	test("matches a genuine Google auth-page navigation carrying our redirect_uri (percent-encoded form)", () => {
		const regex = buildRedirectInterceptRegex(googleAuthUrl, redirectUrl);
		const navigatedUrl = `${googleAuthUrl}?client_id=x&scope=y&redirect_uri=${encodeURIComponent(redirectUrl)}`;

		expect(regex.test(navigatedUrl)).toBe(true);
	});

	test("does NOT match a lookalike host with '.' substituted for another character", () => {
		const regex = buildRedirectInterceptRegex(googleAuthUrl, redirectUrl);
		const lookalikeHost = "https://accountsXgoogle.com/o/oauth2/auth";
		const navigatedUrl = `${lookalikeHost}?client_id=x&scope=y&redirect_uri=${redirectUrl}`;

		// This is the point of the test: with the pre-fix slash-only escape
		// (`authProviderUrl.replace(/\//g, "\\/")`), the unescaped `.` in
		// "accounts.google.com" compiles to a regex wildcard, so this
		// lookalike-host string DOES match the old pattern — confirmed by
		// reverting src/AuthSession.ts's createIntercept/redirectInterceptRegex
		// to the pre-fix slash-only-escape logic (git show HEAD~1 or the
		// pre-PR-166 `main` branch) and re-running this exact assertion, which
		// fails (regex.test → true) against that old code. Against the fixed
		// helper it must be false.
		expect(regex.test(navigatedUrl)).toBe(false);
	});

	test("does NOT match a lookalike host in the percent-encoded redirect_uri form either", () => {
		const regex = buildRedirectInterceptRegex(googleAuthUrl, redirectUrl);
		const lookalikeHost = "https://accountsXgoogle.com/o/oauth2/auth";
		const navigatedUrl = `${lookalikeHost}?client_id=x&scope=y&redirect_uri=${encodeURIComponent(redirectUrl)}`;

		expect(regex.test(navigatedUrl)).toBe(false);
	});

	test("still anchors to the start — an auth URL that merely contains the base further in does not match", () => {
		const regex = buildRedirectInterceptRegex(googleAuthUrl, redirectUrl);
		const navigatedUrl = `https://evil.example.com/?next=${googleAuthUrl}&redirect_uri=${redirectUrl}`;

		expect(regex.test(navigatedUrl)).toBe(false);
	});
});

describe("escapeForRegExp", () => {
	test("escapes every regex metacharacter", () => {
		const escaped = escapeForRegExp("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o");
		// A literal match of the original string against the escaped-and-compiled
		// pattern must succeed, and no character class/quantifier/group was left
		// live to change what the pattern matches.
		expect(new RegExp(`^${escaped}$`).test("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(true);
		expect(new RegExp(`^${escaped}$`).test("aXbXcXdXeXfXgXhXiXjXkXlXmXnXo")).toBe(false);
	});

	test("leaves ordinary characters (including '/') untouched", () => {
		expect(escapeForRegExp("accounts/google/com")).toBe("accounts/google/com");
	});
});
