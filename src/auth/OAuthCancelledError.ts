/**
 * Thrown by the OAuth flow when the user aborts the wait for the browser
 * sign-in (the `AbortSignal` handed to `loginWithOAuth2` fired). Distinct
 * from a timeout or a rejected callback so the UI can treat "I changed my
 * mind" as a quiet cancel instead of a failure with a fallback notice.
 */
export class OAuthCancelledError extends Error {
	constructor() {
		super("OAuth login cancelled");
		this.name = "OAuthCancelledError";
	}
}
