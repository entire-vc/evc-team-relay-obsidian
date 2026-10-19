/**
 * Pure URL-format validation for ServerConfigModalContent.svelte's "add
 * tenant" field -- no network calls, just protocol/hostname shape checks,
 * so it doesn't belong inline next to the component's reactive state.
 */
export interface UrlValidationResult {
	isValid: boolean;
	error: string;
}

const VALID: UrlValidationResult = { isValid: true, error: "" };

export function validateEndpointUrl(url: string, isDevelopment: boolean): UrlValidationResult {
	if (!url.trim()) {
		return VALID; // Empty is valid (uses default)
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { isValid: false, error: "Invalid URL format" };
	}

	// Protocol validation - allow HTTP in development builds, HTTPS only in production
	const allowedProtocols = isDevelopment ? ["https:", "http:"] : ["https:"];
	if (!allowedProtocols.includes(parsed.protocol)) {
		return {
			isValid: false,
			error: isDevelopment
				? "Only HTTP and HTTPS URLs are allowed in development"
				: "Only HTTPS URLs are allowed in production",
		};
	}

	if (parsed.hostname.length < 3) {
		return { isValid: false, error: "Invalid hostname" };
	}

	return VALID;
}

export function describeCaughtError(action: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : "Unknown error occurred";
	return `Error ${action}: ${detail}`;
}
