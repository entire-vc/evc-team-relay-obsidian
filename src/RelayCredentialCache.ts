// Token store wiring specific to the real-time (TeamRelayPlugin) client path.
import { CredentialCache, type CredentialEntry } from "./CredentialCache";
import type { Clock } from "./Clock";
import { AuthSession } from "./AuthSession";
import { namedLogger } from "./logging";
import type { DocumentGrant, FileGrant } from "./relay/TokenShapes";
import { VaultScopedMap } from "./VaultScopedMap";
import type { App } from "obsidian";
import { ResourceAddress, type ResourceAddressType, RemoteFileAddress } from "./ResourceAddress";
import { platformFetch } from "./platformFetch";
import { refresh as universalRefresh } from "./RelayCredentialRefresh";
import {
	RelayAccessDeniedError,
	type RelayOnPremTokenProvider,
} from "./auth/RelayOnPremTokenProvider";
import { AccessDeniedBackoff } from "./accessDeniedBackoff";

declare const GIT_TAG: string;

// The JWT's own expiry field is what actually governs validity server-side —
// this getter just exposes it in the shape CredentialCache's generic cache expects.
function getJwtExpiryFromDocumentGrant(grant: DocumentGrant): number {
	return grant.expiryTime || 0;
}

/** Refusals are per share: every document of a folder share shares one entry. */
export function shareIdOf(documentId: string): string {
	try {
		const address = ResourceAddress.parse(documentId);
		return "folderGuid" in address ? address.folderGuid : documentId;
	} catch {
		return documentId;
	}
}

export class RelayCredentialCache extends CredentialCache<DocumentGrant> {
	// Multi-server: one RelayOnPremTokenProvider per configured on-prem
	// server, each bound to that server's own controlPlaneUrl + auth
	// provider (main.ts builds/maintains this). A single shared provider
	// used to be bound to the DEFAULT server only, so every on-prem share
	// -- regardless of which server it actually belonged to -- had its
	// /tokens/relay request routed to the default server's control plane.
	private relayOnPremProviders: Map<string, RelayOnPremTokenProvider> = new Map();
	// Fallback for documents with no recorded server (legacy folders
	// created before onpremServerId existed) -- preserves the old
	// single-provider behavior for that case instead of failing outright.
	private defaultRelayOnPremServerId?: string;
	private isRelayOnPremMode = false;
	// documentId -> filePath, needed by relay-onprem refresh (it has no other
	// way to recover the path once it's holding only a documentId).
	private filePathMap: Map<string, string> = new Map();
	// documentId -> onprem serverId, so refresh()/fetchFileTokenFromApi() can pick
	// the right provider out of relayOnPremProviders. Same outbound-parameter
	// pattern as filePathMap -- kept alongside the ResourceAddress-encoded
	// documentId rather than inside it, since relayId in that encoding is a
	// fixed "relay-onprem" marker, not a real server identifier.
	private documentServerMap: Map<string, string> = new Map();
	// Shares whose token the control plane refused (401/403): not asked again
	// until their backoff runs out, whichever path asks (reconnect gate,
	// background poller, editor open).
	private accessDenied = new AccessDeniedBackoff();
	// Shares that granted a token since their last refusal, and the one
	// token request in flight for each share that has not.
	private grantedShares = new Set<string>();
	private shareProbes = new Map<string, Promise<void>>();
	private accessListeners = new Set<(shareId: string) => void>();

	constructor(
		private authSession: AuthSession,
		timeProvider: Clock,
		vaultName: string,
		maxConnections = 5,
		relayOnPremProviders?: Map<string, RelayOnPremTokenProvider>,
		app?: App,
		defaultRelayOnPremServerId?: string,
	) {
		super(
			{
				logMessage: namedLogger("[RelayCredentialCache/store]", "debug"),
				getTokenExpiry: getJwtExpiryFromDocumentGrant,
				getClock: () => timeProvider,
				getPersistedTokens: app
					? () =>
							new VaultScopedMap<CredentialEntry<DocumentGrant>>(
								// Persisted storage key, not a class name: this string is
								// the vault-scoped local storage key under which cached
								// credentials already live on every existing install, and
								// it survives restarts. Changing it to match the class name
								// would orphan those entries and force everyone to log in
								// again. Renaming it needs a data migration, not an edit.
								"TokenStore/" + vaultName,
								app,
							)
					: undefined,
				refreshToken: (
					documentId: string,
					onSuccess: (grant: DocumentGrant) => void,
					onError: (err: Error) => void,
				) => void this.gatedRefresh(documentId, onSuccess, onError),
			},
			maxConnections,
		);

		if (relayOnPremProviders && relayOnPremProviders.size > 0) {
			this.relayOnPremProviders = relayOnPremProviders;
			this.isRelayOnPremMode = true;
			this.defaultRelayOnPremServerId = defaultRelayOnPremServerId;
		}
	}

	/**
	 * Resolve the provider for a document's OWN server, falling back to the
	 * default server's provider when the document's server is unknown, and
	 * to whichever provider exists when there's no default either --
	 * matches the pre-multi-server behavior of "there's exactly one
	 * provider" for callers that never recorded a serverId.
	 */
	private getRelayOnPremProvider(documentId: string): RelayOnPremTokenProvider | null {
		const serverId = this.documentServerMap.get(documentId);
		const provider =
			(serverId && this.relayOnPremProviders.get(serverId)) ||
			(this.defaultRelayOnPremServerId &&
				this.relayOnPremProviders.get(this.defaultRelayOnPremServerId)) ||
			this.relayOnPremProviders.values().next().value;
		return provider ?? null;
	}

	/** Relay-onprem mode can flip at runtime (settings change), unlike the
	 * constructor args, which are fixed for the plugin's lifetime. */
	setRelayOnPremMode(enabled: boolean) {
		this.isRelayOnPremMode = enabled;
	}

	/** Multi-server management, mirroring AuthSession's addServer/
	 * removeServer -- main.ts's settings-change watcher keeps this in sync
	 * with relayOnPremSettings.servers. */
	setRelayOnPremProvider(serverId: string, provider: RelayOnPremTokenProvider): void {
		// Destroy whatever provider (if any) this replaces -- callers pass a
		// freshly-constructed provider on a server URL/name edit, not a
		// mutation of the existing one, so the old instance's throttle timer
		// would otherwise leak.
		this.relayOnPremProviders.get(serverId)?.destroy();
		this.relayOnPremProviders.set(serverId, provider);
		this.isRelayOnPremMode = true;
	}

	removeRelayOnPremProvider(serverId: string): void {
		this.relayOnPremProviders.get(serverId)?.destroy();
		this.relayOnPremProviders.delete(serverId);
	}

	setDefaultRelayOnPremServerId(serverId: string | undefined): void {
		this.defaultRelayOnPremServerId = serverId;
	}

	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: DocumentGrant) => void,
		onpremServerId?: string,
	): Promise<DocumentGrant> {
		const havePath = this.isRelayOnPremMode && friendlyName && friendlyName !== "unknown";
		if (havePath) {
			this.filePathMap.set(documentId, friendlyName);
		}
		if (this.isRelayOnPremMode && onpremServerId) {
			this.documentServerMap.set(documentId, onpremServerId);
		}
		return super.acquireToken(documentId, friendlyName, callback);
	}

	/**
	 * Every token request goes through here: a document reconnecting
	 * (getToken) and the periodic renewal sweep alike, so a refused share is
	 * backed off on both paths.
	 */
	private async gatedRefresh(
		documentId: string,
		onSuccess: (grant: DocumentGrant) => void,
		onError: (err: Error) => void,
	): Promise<void> {
		const shareId = shareIdOf(documentId);
		// Until a share has granted a token, its documents ask one at a time,
		// so a refused share costs one request per backoff window, not one
		// per document reconnecting at once. The price is that a working
		// share's first token of the session is awaited before its other
		// documents ask; after that first grant they ask concurrently again.
		// Renewals of tokens a document already holds always ask one at a
		// time: nothing waits on them, and a share refused mid-session must
		// not cost one request per renewal running at once.
		const renewing = !!this.tokenEntries?.get(documentId)?.token;
		const serialized = () => renewing || !this.grantedShares.has(shareId);
		for (;;) {
			const probe = serialized() ? this.shareProbes.get(shareId) : undefined;
			if (!probe) break;
			await probe;
		}
		const retryAt = this.accessDenied.retryAt(shareId, Date.now());
		if (retryAt !== undefined) {
			const denied = new RelayAccessDeniedError(0, `Relay token refused for share ${shareId}; next try in ${Math.ceil((retryAt - Date.now()) / 1000)}s`);
			denied.retryAt = retryAt;
			// Not inline: the renewal queue calls the next refresh from this
			// callback, and a run of backed-off documents would recurse.
			void Promise.resolve().then(() => onError(denied));
			return;
		}
		let settle: (() => void) | undefined;
		let probe: Promise<void> | undefined;
		if (serialized()) {
			probe = new Promise<void>((resolve) => (settle = resolve));
			this.shareProbes.set(shareId, probe);
		}
		const done = () => {
			if (probe && this.shareProbes.get(shareId) === probe) this.shareProbes.delete(shareId);
			settle?.();
		};
		try {
			await universalRefresh(
				this.getRelayOnPremProvider(documentId),
				this.isRelayOnPremMode,
				documentId,
				(grant) => {
					const wasDenied = this.accessDenied.isDenied(shareId);
					this.grantedShares.add(shareId);
					this.accessDenied.clear(shareId);
					done();
					if (wasDenied) this.notifyAccessChange(shareId);
					onSuccess(grant);
				},
				(err) => {
					if (err instanceof RelayAccessDeniedError) {
						const wasDenied = this.accessDenied.isDenied(shareId);
						this.grantedShares.delete(shareId);
						err.retryAt = this.accessDenied.recordDenied(shareId, Date.now());
						if (!wasDenied) this.notifyAccessChange(shareId);
					}
					done();
					onError(err);
				},
				this.filePathMap.get(documentId),
			);
		} finally {
			done();
		}
	}

	/** True while the share of this document is refused by the control plane. */
	isAccessDenied(documentId: string): boolean {
		return this.accessDenied.isDenied(shareIdOf(documentId));
	}

	/** Forget every refusal: after a sign-in/token refresh or a manual reconnect. */
	clearAccessDenied(): void {
		const denied = this.accessDenied.deniedShares();
		this.accessDenied.clear();
		for (const provider of this.relayOnPremProviders.values()) {
			provider.clearRefused();
		}
		for (const shareId of denied) this.notifyAccessChange(shareId);
	}

	/** Called with a share id whenever that share becomes refused or stops being refused. */
	onAccessDeniedChange(listener: (shareId: string) => void): () => void {
		this.accessListeners.add(listener);
		return () => this.accessListeners.delete(listener);
	}

	private notifyAccessChange(shareId: string): void {
		for (const listener of this.accessListeners) listener(shareId);
	}

	clear(filter?: (token: CredentialEntry<DocumentGrant>) => boolean) {
		if (!filter) {
			this.filePathMap.clear();
			this.documentServerMap.clear();
			super.purge(filter);
			return;
		}
		this.tokenEntries?.forEach((value, key) => {
			if (filter(value)) {
				this.filePathMap.delete(key);
				this.documentServerMap.delete(key);
			}
		});
		super.purge(filter);
	}

	destroy() {
		this.filePathMap.clear();
		this.documentServerMap.clear();
		for (const provider of this.relayOnPremProviders.values()) {
			provider.destroy();
		}
		this.relayOnPremProviders.clear();
		super.teardown();
	}

	/** Auth header set shared by every request this store makes — bearer JWT
	 * plus the version pin the relay server uses for compat checks. */
	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.authSession.currentUser?.authToken}`,
			"Relay-Version": GIT_TAG,
			"Content-Type": "application/json",
		};
	}

	private async parseFileTokenResponse(
		response: Response,
		debug: (...args: unknown[]) => void,
	): Promise<FileGrant> {
		if (!response.ok) {
			debug(response.status, await response.text());
			const body = (await response.json()) as { error?: string };
			throw new Error(body.error ?? "Unknown error");
		}
		return (await response.json()) as FileGrant;
	}

	async fetchFileTokenFromApi(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileGrant> {
		const debug = namedLogger("[RelayCredentialCache/fetchFileTokenFromApi]", "debug");
		debug(`requesting file token for ${documentId}`);

		const entity: ResourceAddressType = ResourceAddress.parse(documentId);
		if (!(entity instanceof RemoteFileAddress)) {
			throw new Error(`${documentId} does not resolve to a remote file`);
		}

		// mirror universalRefresh's isRelayOnPremMode/tokenProvider branch
		// (RelayCredentialRefresh.ts) — this method previously always hit the
		// cloud-backend API regardless of mode, so BlobClient.ts's verify/readFile/writeFile
		// silently used an empty API URL in relay-onprem builds.
		const relayOnPremProvider = this.getRelayOnPremProvider(documentId);
		if (this.isRelayOnPremMode && relayOnPremProvider) {
			return relayOnPremProvider.requestFileToken(
				entity.relayGuid,
				entity.folderGuid,
				entity.fileGuid,
				fileHash,
				contentType,
				contentLength,
			);
		}

		if (!this.authSession.isAuthenticated) {
			throw new Error("cannot fetch a file token while logged out");
		}

		const apiUrl = this.authSession.resolveTenantRegistry().resolveApiUrl();
		const response = await platformFetch(`${apiUrl}/file-token`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({
				docId: entity.fileGuid,
				relay: entity.relayGuid,
				folder: entity.folderGuid,
				hash: fileHash,
				contentType,
				contentLength,
			}),
		});

		return this.parseFileTokenResponse(response, debug);
	}

	/**
	 * documentId+fileHash keys both the token cache and the in-flight-request
	 * map, so concurrent callers asking for the same file's token collapse
	 * onto one network request instead of racing duplicate ones.
	 */
	private async acquireFreshFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileGrant> {
		const key = `${documentId}${fileHash}`;
		const inFlight = this._inFlightPromises.get(key);
		if (inFlight) {
			return inFlight as Promise<FileGrant>;
		}

		this.tokenEntries.set(documentId, {
			token: null,
			expiryTime: 0,
			attempts: 0,
		} as CredentialEntry<DocumentGrant>);

		const request = this.requestAndCacheFileToken(
			documentId,
			fileHash,
			contentType,
			contentLength,
			key,
		);
		this._inFlightPromises.set(key, request);
		return request;
	}

	private async requestAndCacheFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		key: string,
	): Promise<FileGrant> {
		try {
			const newToken = await this.fetchFileTokenFromApi(
				documentId,
				fileHash,
				contentType,
				contentLength,
			);
			const existing = this.tokenEntries.get(key)!;
			this.tokenEntries.set(fileHash, {
				...existing,
				token: newToken,
				expiryTime: this.resolveJwtExpiry(newToken),
			});
			return newToken;
		} finally {
			this._inFlightPromises.delete(key);
		}
	}

	private validCachedToken(key: string): FileGrant | undefined {
		const tokenInfo = this.tokenEntries.get(key);
		if (!tokenInfo?.token || !this.tokenIsValid(tokenInfo)) {
			return undefined;
		}
		this.logLine("cache hit: cached token still passes validity check");
		this._inFlightPromises.delete(key);
		return tokenInfo.token as FileGrant;
	}

	async resolveFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		onpremServerId?: string,
	): Promise<FileGrant> {
		if (this.isRelayOnPremMode && onpremServerId) {
			this.documentServerMap.set(documentId, onpremServerId);
		}
		const key = `${documentId}${fileHash}`;
		const cached = this.validCachedToken(key);
		if (cached) {
			return cached;
		}
		return this.acquireFreshFileToken(
			documentId,
			fileHash,
			contentType,
			contentLength,
		);
	}
}
