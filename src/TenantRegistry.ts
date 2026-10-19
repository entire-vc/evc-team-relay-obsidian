import { platformFetch } from "./platformFetch";
import { namedLogger } from "./logging";
import { type JWTPayload, importSPKI, jwtVerify } from "jose";
import type { SettingsScope } from "./SettingsPersistence";

declare const API_URL: string;
declare const AUTH_URL: string;
declare const BUILD_TYPE: string;

// Public half of the keypair we sign endpoint-validation certificates with.
// Only Entire VC holds the private half; this lets any client verify a
// license without talking to a server first.
const ENDPOINT_VALIDATION_PUBLIC_KEY = `
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyDIav6xzBzyi6eQu8aJA
O8DufA/MyTMDsD9d6PmjhuPTSlVPharZSjxRkHi6sK50ZmRedQbyiBuNp0g6so30
+zunoqT9XUpvZD0+USlGvi0J48Cop+DQbbpTlAlsmX6BxhHJLUrmgU0AhHjvJLNL
rRuzzQxrn/Oi0byUHu/moitUypX1hSYrKH5meRy8zoyGb8b0qIOEKpcpVKGyD/ne
+u0Bhh6tI8t2vQDQK0RL87dc+EqlQXxtijXBSClqvJi7o3JYTtWtuaWcZ2pQdg5y
+gDMii2hZYLNdgDM+/NcJlp3fkPztVeVRpiV20gZDhqANSjWjx9iN1Jt9A97rCSH
XQIDAQAB
-----END PUBLIC KEY-----
`.trim();

export enum LicenseFailureKind {
	LICENSE_INVALID = "LICENSE_INVALID",
	LICENSE_EXPIRED = "LICENSE_EXPIRED",
	JWT_VERIFICATION_FAILED = "JWT_VERIFICATION_FAILED",
	URL_INVALID = "URL_INVALID",
	NETWORK_ERROR = "NETWORK_ERROR",
	LICENSE_NOT_FOUND = "LICENSE_NOT_FOUND",
}

export class ValidationError extends Error {
	constructor(
		message: string,
		public readonly type: LicenseFailureKind,
		public readonly diagnosticContext?: unknown,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

/** One enterprise endpoint a user has pointed this vault at, and what we know about its license. */
export interface TenantRecord {
	id: string;
	name: string;
	tenantUrl: string;
	apiUrl?: string;
	authUrl?: string;
	customer?: string;
	logo?: string;
	isValidated: boolean;
	lastValidated?: number;
	environment?: string;
}

export interface TenantSettings {
	tenants?: TenantRecord[];
	activeTenantId?: string;
	_lastValidationError?: string;
	_lastValidationAttempt?: number;
}

export interface LicenseRecord {
	license: string;
	id?: string;
	url?: string;
}

export interface LicenseAttributes {
	[key: string]: unknown;
}

export interface LicenseSummary {
	tokenIssuer: string;
	tokenSubject: string;
	issuedAt: string;
	expiresAt: string;
	verified: boolean;
}

interface LicenseClaims extends JWTPayload {
	apiUrl?: string;
	authUrl?: string;
	customer?: string;
	logo?: string;
}

type Outcome<D extends object = object> = ({ success: true } & D) | { success: false; error: string };

function ok<D extends object>(data: D): { success: true } & D {
	return { success: true, ...data };
}

function fail(error: string): { success: false; error: string } {
	return { success: false, error };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function isLicense(candidate: unknown): candidate is LicenseRecord {
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		"license" in candidate &&
		typeof candidate.license === "string"
	);
}

function isLicenseArray(candidate: unknown): candidate is LicenseRecord[] {
	return Array.isArray(candidate) && candidate.every(isLicense);
}

/** A response body can be a bare LicenseRecord, an array of them, or `{licenses: [...]}` — normalize to an array or throw. */
function extractLicenses(body: unknown): LicenseRecord[] {
	if (isLicenseArray(body)) return body;
	if (body && typeof body === "object" && "licenses" in body && isLicenseArray(body.licenses)) {
		return (body as { licenses: LicenseRecord[] }).licenses;
	}
	if (isLicense(body)) return [body];
	throw new ValidationError("No valid licenses found in response", LicenseFailureKind.LICENSE_NOT_FOUND);
}

/** Rewrites low-level fetch/HTTP failures into messages a user reading a settings dialog can act on. */
function friendlyFetchError(tenantUrl: string, rawMessage: string): string {
	if (
		rawMessage.includes("Failed to fetch") ||
		rawMessage.includes("NetworkError") ||
		rawMessage.includes("ERR_") ||
		rawMessage.includes("ECONNREFUSED")
	) {
		return `Unable to connect to ${tenantUrl}. Please check the URL and ensure the server is running.`;
	}
	if (rawMessage.includes("404")) {
		return `No tenant license found at ${tenantUrl}. This may not be a valid Enterprise Relay tenant.`;
	}
	return rawMessage;
}

function raceTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	const timeout = new Promise<never>((_, reject) =>
		window.setTimeout(() => reject(new Error(`Validation timed out after ${timeoutMs}ms`)), timeoutMs),
	);
	return Promise.race([work, timeout]);
}

/**
 * Manages the "bring your own enterprise endpoint" flow: a self-hosted relay
 * proves itself with a signed license fetched from a well-known path, we
 * verify it against our public key, and — once validated — traffic for this
 * vault gets pointed at that tenant's API/AUTH urls instead of the compiled
 * defaults.
 */
export class TenantRegistry {
	private logger = namedLogger("[TenantRegistry]");
	private activeApiUrl?: string;
	private activeAuthUrl?: string;
	private publicKey?: CryptoKey;

	constructor(private settings: SettingsScope<TenantSettings>) {}

	/** True in staging/dev builds — relaxes the HTTPS-only URL requirement. */
	public isDevBuild(): boolean {
		return BUILD_TYPE === "debug";
	}

	private redactUrlForLog(url: string): string {
		try {
			const parsed = new URL(url);
			parsed.search = "";
			return parsed.toString();
		} catch {
			return url;
		}
	}

	private assertValidUrl(url: string): void {
		if (!url || typeof url !== "string") {
			throw new ValidationError("URL must be a non-empty string", LicenseFailureKind.URL_INVALID);
		}

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new ValidationError("Invalid URL format", LicenseFailureKind.URL_INVALID);
		}

		const allowHttp = this.isDevBuild();
		const protocolOk = allowHttp
			? parsed.protocol === "https:" || parsed.protocol === "http:"
			: parsed.protocol === "https:";
		if (!protocolOk) {
			throw new ValidationError(
				allowHttp ? "Only HTTP and HTTPS URLs are allowed in development" : "Only HTTPS URLs are allowed in production",
				LicenseFailureKind.URL_INVALID,
			);
		}

		const hostname = parsed.hostname.toLowerCase();
		if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
			this.logger(`Warning: Using localhost endpoint (development build: ${allowHttp})`);
		}
		if (!hostname || hostname.length < 3) {
			throw new ValidationError("Invalid hostname", LicenseFailureKind.URL_INVALID);
		}
	}

	private async resolveSigningPublicKey(): Promise<CryptoKey> {
		if (this.publicKey) return this.publicKey;
		try {
			this.publicKey = await importSPKI(ENDPOINT_VALIDATION_PUBLIC_KEY, "RS256");
			return this.publicKey;
		} catch (error: unknown) {
			throw new ValidationError("Failed to import public key", LicenseFailureKind.JWT_VERIFICATION_FAILED, error);
		}
	}

	/** Verifies an RS256-signed license token against our pinned public key. Deliberately allowlists only RS256 — no algorithm negotiation. */
	private async verifySignedToken(token: string): Promise<LicenseClaims> {
		try {
			const key = await this.resolveSigningPublicKey();
			const { payload } = await jwtVerify(token, key, { algorithms: ["RS256"] });
			return payload;
		} catch (error: unknown) {
			this.logger("JWT verification failed:", error);
			throw new ValidationError(`JWT verification failed: ${messageOf(error)}`, LicenseFailureKind.JWT_VERIFICATION_FAILED, error);
		}
	}

	resolveApiUrl(): string {
		return this.activeApiUrl || API_URL;
	}

	resolveAuthUrl(): string {
		return this.activeAuthUrl || AUTH_URL;
	}

	resolveDefaultUrls(): { apiUrl: string; authUrl: string; environment: string } {
		return {
			apiUrl: API_URL,
			authUrl: AUTH_URL,
			environment: this.isDevBuild() ? "staging" : "production",
		};
	}

	resetValidatedEndpoints(): void {
		this.activeApiUrl = undefined;
		this.activeAuthUrl = undefined;
		this.logger("Cleared validated endpoints, reverted to defaults");
	}

	endpointsAreValidated(): boolean {
		return !!(this.activeApiUrl && this.activeAuthUrl);
	}

	private resolveActiveTenant(settings: TenantSettings): TenantRecord | undefined {
		if (!settings.activeTenantId || !settings.tenants) return undefined;
		return settings.tenants.find((t) => t.id === settings.activeTenantId);
	}

	private deriveTenantId(tenantUrl: string): string {
		try {
			const url = new URL(tenantUrl);
			return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
		} catch {
			return tenantUrl.replace(/[^a-zA-Z0-9]/g, "_");
		}
	}

	/** Fetches the license(s) published at `<tenantUrl>/.well-known/evc-team-relay/license` and returns the first one. */
	private async retrieveTenantLicense(tenantUrl: string): Promise<Outcome<{ license: string }>> {
		try {
			const url = new URL(tenantUrl);
			const certUrl = `${url.protocol}//${url.host}/.well-known/evc-team-relay/license`;
			this.logger("Fetching tenant license from:", certUrl);

			const response = await platformFetch(certUrl, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			});
			if (!response.ok) {
				throw new Error(`LicenseRecord fetch failed: ${response.status} ${response.statusText}`);
			}

			const licenses = extractLicenses(await response.json());
			if (licenses.length === 0) {
				throw new Error("Empty license list");
			}
			return ok({ license: licenses[0].license });
		} catch (error: unknown) {
			const message = friendlyFetchError(tenantUrl, messageOf(error));
			this.logger("Tenant license fetch error:", message);
			return fail(message);
		}
	}

	/** Checks issuer + subject claims — the two invariants every endpoint-certificate license must carry regardless of what it's asserting URLs for. */
	private async verifyTenantLicense(license: string, tenantUrl: string): Promise<Outcome<{ licenseInfo: LicenseSummary }>> {
		this.logger(`Tenant license validation starting: ${this.redactUrlForLog(tenantUrl)}`);
		try {
			const payload = await this.verifySignedToken(license);

			if (payload.iss !== AUTH_URL) {
				throw new ValidationError(`Invalid token issuer: expected ${AUTH_URL}, got ${payload.iss}`, LicenseFailureKind.LICENSE_INVALID);
			}
			if (payload.sub !== "endpoint-certificate") {
				throw new ValidationError(
					`Invalid token subject: expected "endpoint-certificate", got ${payload.sub}`,
					LicenseFailureKind.LICENSE_INVALID,
				);
			}

			const licenseInfo: LicenseSummary = {
				tokenIssuer: payload.iss || "Unknown",
				tokenSubject: payload.sub || "Unknown",
				issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : "Unknown",
				expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : "Unknown",
				verified: true,
			};
			this.logger(`Tenant license validation successful: ${this.redactUrlForLog(tenantUrl)}`);
			return ok({ licenseInfo });
		} catch (error: unknown) {
			const message = messageOf(error);
			this.logger(`Tenant license validation failed: ${this.redactUrlForLog(tenantUrl)} - ${message}`);
			return fail(message);
		}
	}

	/**
	 * Shared core of `applyValidatedEndpoints`/`dryRunValidateTenant`: fetch +
	 * verify a tenant's license. `commit: true` additionally requires the
	 * license to assert both apiUrl/authUrl, requires authUrl to match the
	 * URL we validated against, and — only then — updates the manager's
	 * active endpoints. `commit: false` (test mode) stops at "is this a
	 * validly-signed endpoint-certificate license" without touching state.
	 */
	private async runLicenseValidation(
		tenantUrl: string,
		commit: boolean,
	): Promise<Outcome<{ licenseInfo?: LicenseSummary }>> {
		try {
			this.assertValidUrl(tenantUrl);

			const fetched = await this.retrieveTenantLicense(tenantUrl);
			if (!fetched.success) {
				return fail(`Failed to fetch tenant license: ${fetched.error}`);
			}

			const validated = await this.verifyTenantLicense(fetched.license, tenantUrl);
			if (!validated.success) {
				return fail(`Tenant license validation failed: ${validated.error}`);
			}

			const payload = await this.verifySignedToken(fetched.license);

			if (commit) {
				if (!payload.apiUrl || !payload.authUrl) {
					return fail("License missing required apiUrl or authUrl");
				}
				if (payload.authUrl !== tenantUrl) {
					return fail(`Tenant URL mismatch: expected ${tenantUrl}, license has ${payload.authUrl}`);
				}
				this.activeApiUrl = payload.apiUrl;
				this.activeAuthUrl = payload.authUrl;
				this.logger("Successfully validated enterprise tenant", {
					tenant: tenantUrl,
					apiUrl: this.activeApiUrl,
					authUrl: this.activeAuthUrl,
					customer: payload.customer,
				});
			} else {
				this.logger("Test validation successful for tenant", {
					tenantUrl,
					apiUrl: payload.apiUrl,
					authUrl: payload.authUrl,
				});
			}

			return ok({ licenseInfo: validated.licenseInfo });
		} catch (error: unknown) {
			return fail(messageOf(error));
		}
	}

	async applyValidatedEndpoints(timeoutMs = 10000): Promise<Outcome<{ licenseInfo?: LicenseSummary }>> {
		const active = this.resolveActiveTenant(this.settings.readValue());
		if (!active) {
			this.logger("No active enterprise tenant configured, using defaults");
			this.resetValidatedEndpoints();
			return ok({});
		}

		try {
			return await raceTimeout(this.runLicenseValidation(active.tenantUrl, true), timeoutMs);
		} catch (error: unknown) {
			const message = messageOf(error);
			this.logger("Failed to validate tenant:", message);
			return fail(message);
		}
	}

	async dryRunValidateTenant(tenantUrl: string, timeoutMs = 10000): Promise<Outcome<{ licenseInfo?: LicenseSummary }>> {
		try {
			return await raceTimeout(this.runLicenseValidation(tenantUrl, false), timeoutMs);
		} catch (error: unknown) {
			const message = messageOf(error);
			this.logger("Failed to test validate endpoints:", message);
			return fail(message);
		}
	}

	async registerTenant(tenantUrl: string, validate = true): Promise<Outcome<{ tenantId: string; licenseInfo?: LicenseSummary }>> {
		try {
			this.assertValidUrl(tenantUrl);
			const tenantId = this.deriveTenantId(tenantUrl);
			const settings = this.settings.readValue();

			if (settings.tenants?.some((t) => t.id === tenantId)) {
				return fail("This tenant is already configured");
			}

			let tenant: TenantRecord = {
				id: tenantId,
				name: tenantUrl,
				tenantUrl,
				isValidated: false,
			};
			let licenseInfo: LicenseSummary | undefined;

			if (validate) {
				const fetched = await this.retrieveTenantLicense(tenantUrl);
				if (!fetched.success) {
					return fail(fetched.error || "Failed to fetch tenant license");
				}
				const validated = await this.verifyTenantLicense(fetched.license, tenantUrl);
				if (!validated.success) {
					return fail(validated.error || "Tenant license validation failed");
				}
				licenseInfo = validated.licenseInfo;

				const payload = await this.verifySignedToken(fetched.license);
				tenant = {
					...tenant,
					name: payload.customer || tenantUrl,
					apiUrl: payload.apiUrl,
					authUrl: payload.authUrl,
					customer: payload.customer,
					logo: payload.logo,
					environment: payload.environment as string,
					isValidated: true,
					lastValidated: Date.now(),
				};
			}

			await this.settings.mutateValue((current) => ({
				...current,
				tenants: [...(current.tenants || []), tenant],
			}));

			return ok({ tenantId, licenseInfo });
		} catch (error: unknown) {
			return fail(messageOf(error));
		}
	}

	async deleteTenant(tenantId: string): Promise<boolean> {
		const settings = this.settings.readValue();
		const tenants = settings.tenants || [];
		if (!tenants.some((t) => t.id === tenantId)) return false;

		const wasActive = settings.activeTenantId === tenantId;
		await this.settings.mutateValue((current) => ({
			...current,
			tenants: (current.tenants || []).filter((t) => t.id !== tenantId),
			...(wasActive ? { activeTenantId: undefined } : {}),
		}));

		if (wasActive) this.resetValidatedEndpoints();
		return true;
	}

	async activateTenant(tenantId: string): Promise<{ success: boolean; error?: string }> {
		const tenant = this.settings.readValue().tenants?.find((t) => t.id === tenantId);
		if (!tenant) {
			return { success: false, error: "Tenant not found" };
		}

		await this.settings.mutateValue((current) => ({ ...current, activeTenantId: tenantId }));

		if (tenant.isValidated && tenant.apiUrl && tenant.authUrl) {
			this.activeApiUrl = tenant.apiUrl;
			this.activeAuthUrl = tenant.authUrl;
		} else {
			this.resetValidatedEndpoints();
		}
		return { success: true };
	}

	async resolveCustomerInfo(): Promise<{ customer?: string; logo?: string } | null> {
		if (!this.endpointsAreValidated()) return null;

		const active = this.resolveActiveTenant(this.settings.readValue());
		if (!active) return null;

		try {
			if (active.isValidated && active.customer) {
				return { customer: active.customer, logo: active.logo };
			}
			const fetched = await this.retrieveTenantLicense(active.tenantUrl);
			if (fetched.success) {
				const payload = await this.verifySignedToken(fetched.license);
				return { customer: payload.customer, logo: payload.logo };
			}
		} catch (error: unknown) {
			this.logger("Failed to get customer info:", error);
		}
		return null;
	}

	async resolveDefaultTenantInfo(): Promise<{ customer?: string; logo?: string; environment?: string } | null> {
		try {
			const fetched = await this.retrieveTenantLicense(AUTH_URL);
			if (fetched.success) {
				const payload = await this.verifySignedToken(fetched.license);
				return {
					customer: payload.customer,
					logo: payload.logo,
					environment: this.isDevBuild() ? "staging" : "production",
				};
			}
		} catch (error: unknown) {
			this.logger("Failed to get default tenant info:", error);
		}
		return null;
	}
}
