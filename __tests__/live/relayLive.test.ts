/**
 * LIVE integration harness for the rewritten sync core.
 *
 * Runs the REAL modules against a REAL locally-running relay stack:
 *   control-plane  http://localhost:58080   (FastAPI, mints CWT relay tokens)
 *   relay-server   ws://localhost:58081     (y-sweet fork, validates them)
 *
 * Nothing on the path under test is mocked. The only stand-in is the Obsidian
 * app API (`__tests__/live/obsidianLive.ts`), a true external boundary — and
 * even there `requestUrl` performs real HTTP, so `src/platformFetch.ts` is
 * exercised for real. The tokens, the JWT login, the share, the websockets and
 * the CRDT traffic are all genuine.
 *
 * Modules actually driven end-to-end here:
 *   src/auth/RelayOnPremAuthProvider.ts   real password login -> JWT
 *   src/RelayOnPremShareClient.ts         real share creation / read-back
 *   src/auth/RelayOnPremTokenProvider.ts  real POST /tokens/relay
 *   src/RelayCredentialRefresh.ts          real onprem refresh branch
 *   src/RelayCredentialCache.ts + src/CredentialCache.ts   real token cache/refresh
 *   src/ResourceAddress.ts                           real encode/decode round trip
 *   src/platformFetch.ts                    real requests
 *   src/ProviderBacked.ts + src/client/provider.ts  real websocket + Yjs sync
 *
 * Run:
 *   LIVE_RELAY=1 npx jest --config jest.live.config.js
 */

import {
	describe,
	test,
	expect,
	beforeAll,
	afterAll,
} from "@jest/globals";
import * as Y from "yjs";
import { execSync } from "node:child_process";

import { ProviderBacked } from "../../src/ProviderBacked";
import { YSweetProvider } from "../../src/client/provider";
import { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../../src/auth/RelayOnPremTokenProvider";
import { RelayOnPremAuthProvider } from "../../src/auth/RelayOnPremAuthProvider";
import { RelayOnPremShareClient } from "../../src/RelayOnPremShareClient";
import { SystemClock } from "../../src/Clock";
import { ResourceAddress, RemoteDocumentAddress } from "../../src/ResourceAddress";
import { AuthSession, type AuthSettings } from "../../src/AuthSession";
import { Settings, SettingsScope } from "../../src/SettingsPersistence";
import { TenantRegistry, type TenantSettings } from "../../src/TenantRegistry";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import type { DocumentGrant } from "../../src/relay/TokenShapes";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const CONTROL_PLANE = process.env.LIVE_CONTROL_PLANE ?? "http://localhost:58080";
const RELAY_SERVER = process.env.LIVE_RELAY_SERVER ?? "http://localhost:58081";
const ADMIN_EMAIL = process.env.LIVE_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.LIVE_ADMIN_PASSWORD ?? "super-secret-pass";

/** Relay id used by main.ts for every relay-onprem VaultShare. */
const RELAY_ID = "relay-onprem";
const SERVER_ID = "live-harness-server";
const YTEXT_KEY = "contents"; // Shared text key used by Document.ts.

const gate = process.env.LIVE_RELAY === "1" ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers (test-side only — none of these stand in for a module under test)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function assertStackReachable(): Promise<void> {
	const probes: Array<[string, string]> = [
		[`${CONTROL_PLANE}/health`, "control-plane"],
		[`${RELAY_SERVER}/ready`, "relay-server"],
	];
	for (const [url, name] of probes) {
		let status: number | string;
		try {
			status = (await fetch(url)).status;
		} catch (e) {
			status = e instanceof Error ? e.message : String(e);
		}
		if (status !== 200) {
			throw new Error(
				`LIVE harness precondition failed: ${name} at ${url} returned ${String(status)} (expected 200). ` +
					`Start the stack before running this config.`,
			);
		}
	}
}

/**
 * Polls `read()` until it equals `expected`. Rejects — with the last value
 * actually observed — if it never does. The rejection path is exercised by the
 * negative control below, so this cannot silently pass on a wrong value.
 */
async function waitForText(
	read: () => string,
	expected: string,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = read();
	while (Date.now() < deadline) {
		last = read();
		if (last === expected) return;
		await sleep(50);
	}
	throw new Error(
		`${label}: text never converged within ${timeoutMs}ms.\n` +
			`  expected: ${JSON.stringify(expected)}\n` +
			`  last seen: ${JSON.stringify(last)}`,
	);
}

/**
 * Reads the relay-server's own log so eviction can be ASSERTED rather than
 * assumed from a sleep. Override the command with LIVE_RELAY_LOG_CMD if the
 * stack is not the local `docker compose -p trlive` one.
 */
const RELAY_LOG_CMD =
	process.env.LIVE_RELAY_LOG_CMD ??
	"docker compose -p trlive logs relay-server --since 5m";

function relayLogContains(needle: string): boolean {
	try {
		return execSync(RELAY_LOG_CMD, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).includes(needle);
	} catch {
		throw new Error(
			`Could not read the relay-server log via \`${RELAY_LOG_CMD}\`. ` +
				`Set LIVE_RELAY_LOG_CMD, or LIVE_SKIP_EVICTION=1 to skip the durability test.`,
		);
	}
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(50);
	}
	throw new Error(`${label}: condition never became true within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------

gate("LIVE relay integration", () => {
	let authProvider: IAuthProvider;
	let shareClient: RelayOnPremShareClient;
	let tokenProvider: RelayOnPremTokenProvider;
	let tokenStore: RelayCredentialCache;
	let authSession: AuthSession;
	let loginSettings: SettingsScope<AuthSettings>;
	let tenantSettings: SettingsScope<TenantSettings>;

	let shareId: string;
	let sharePath: string;
	let docId: string;
	let s3rn: string;

	const openProviders: ProviderBacked[] = [];
	const openRawProviders: YSweetProvider[] = [];

	function newClient(name: string): ProviderBacked {
		const hp = new ProviderBacked(
			docId,
			new RemoteDocumentAddress(RELAY_ID, shareId, docId),
			tokenStore,
			authSession,
			SERVER_ID,
		);
		hp.entryPath = `${sharePath}/${name}.md`;
		openProviders.push(hp);
		return hp;
	}

	beforeAll(async () => {
		await assertStackReachable();

		const stamp = Date.now();

		// Mock: external boundary — Obsidian's plugin data file only. The
		// settings scopes, per-server auth manager and session remain real.
		const settings = new Settings<Record<string, unknown>>(
			{
				loadData: async () => null,
				saveData: async () => undefined,
			},
			{ login: { provider: undefined }, tenants: {} },
		);
		await settings.hydrate();
		loginSettings = new SettingsScope<AuthSettings>(settings, "login");
		tenantSettings = new SettingsScope<TenantSettings>(settings, "tenants");
		const serverSettings: RelayOnPremSettings = {
			enabled: true,
			defaultServerId: SERVER_ID,
			servers: [
				{
					id: SERVER_ID,
					name: "Live harness",
					controlPlaneUrl: CONTROL_PLANE,
					isValidated: true,
				},
			],
		};
		authSession = new AuthSession(
			`live-harness-${stamp}`,
			async () => undefined,
			new SystemClock(),
			() => undefined,
			loginSettings,
			new TenantRegistry(tenantSettings),
			serverSettings,
		);
		await authSession.waitForRestore();
		expect(
			await authSession.loginToServer(SERVER_ID, ADMIN_EMAIL, ADMIN_PASSWORD),
		).toBe(true);
		const provider = authSession.getAuthProviderForServer(SERVER_ID);
		if (!(provider instanceof RelayOnPremAuthProvider)) {
			throw new Error("Live server auth provider was not configured");
		}
		authProvider = provider;
		expect(authSession.getCurrentUserForServer(SERVER_ID)?.emailAddress).toBe(
			ADMIN_EMAIL,
		);

		// --- REAL share creation through the plugin's own client ----------
		shareClient = new RelayOnPremShareClient(CONTROL_PLANE, () =>
			authProvider.getValidToken(),
		);
		sharePath = `LiveHarness-${stamp}`;
		const share = await shareClient.createShare({
			kind: "folder",
			path: sharePath,
			visibility: "private",
		});
		shareId = share.id;

		// --- REAL token plumbing ------------------------------------------
		tokenProvider = new RelayOnPremTokenProvider({
			controlPlaneUrl: CONTROL_PLANE,
			authProvider,
		});
		tokenStore = new RelayCredentialCache(
			authSession,
			new SystemClock(),
			`live-harness-${stamp}`,
			5,
			new Map([[SERVER_ID, tokenProvider]]),
			undefined,
			SERVER_ID,
		);
		tokenStore.startSweeping();

		docId = crypto.randomUUID();
		s3rn = ResourceAddress.serialize(new RemoteDocumentAddress(RELAY_ID, shareId, docId));
	});

	afterAll(async () => {
		for (const hp of openProviders) {
			try {
				hp.dismantle();
			} catch {
				/* teardown best-effort */
			}
		}
		for (const p of openRawProviders) {
			try {
				p.destroy();
			} catch {
				/* teardown best-effort */
			}
		}
		try {
			tokenStore?.destroy();
			await authSession?.logoutFromAllServers();
			authSession?.shutdown();
			loginSettings?.destroy();
			tenantSettings?.destroy();
		} catch {
			/* teardown best-effort */
		}
		// Give sockets a beat to close before jest tears the context down.
		await sleep(200);
	});

	// =====================================================================
	// STEP 1 — token chain
	// =====================================================================

	describe("step 1: token chain", () => {
		test("ResourceAddress round-trips the live share/doc identity", () => {
			const decoded = ResourceAddress.parse(s3rn);
			expect(decoded).toBeInstanceOf(RemoteDocumentAddress);
			const d = decoded as RemoteDocumentAddress;
			expect(d.relayGuid).toBe(RELAY_ID);
			expect(d.folderGuid).toBe(shareId);
			expect(d.documentGuid).toBe(docId);
		});

		test("RelayCredentialCache mints a real relay token from the control plane", async () => {
			const token: DocumentGrant = await tokenStore.getToken(
				s3rn,
				`${sharePath}/live-note.md`,
				() => undefined,
			);

			// Issued by the live server, not a fixture.
			expect(typeof token.token).toBe("string");
			expect(token.token.length).toBeGreaterThan(32);
			expect(token.docId).toBe(docId);
			expect(token.folder).toBe(shareId);
			expect(token.expiryTime).toBeGreaterThan(Date.now());

			// The relay URL must point at the relay-server this stack is running,
			// and carry the per-doc route relay-server actually serves.
			const relayHost = new URL(RELAY_SERVER).host;
			expect(new URL(token.url).host).toBe(relayHost);
			expect(token.url).toBe(`ws://${relayHost}/d/${docId}/ws`);

			// Write access was granted (the plugin always asks for "write" and
			// falls back to "read" on a 403 — RelayOnPremTokenProvider.requestToken).
			expect(token.authorization).toBe("full");
		});

		test("relay-server ACCEPTS the token: ProviderBacked connects and syncs", async () => {
			const client = newClient("step1");
			const connected = await client.bringOnline();
			expect(connected).toBe(true);

			await waitFor(() => client.isOnline, 15_000, "step1 websocket connect");
			expect(client.isOnline).toBe(true);

			await client.onceEverSynced();
			expect(client.isSynced).toBe(true);
		});
	});

	// =====================================================================
	// NEGATIVE CONTROL for step 1 — a bad token must be refused
	// =====================================================================

	describe("negative control: token validity is actually enforced", () => {
		test("a tampered token is rejected by the relay while the genuine one is accepted", async () => {
			const good: DocumentGrant = await tokenStore.getToken(
				s3rn,
				`${sharePath}/live-note.md`,
				() => undefined,
			);

			// Corrupt the signature region of the CWT while leaving the shape,
			// length and URL identical — the ONLY difference is validity.
			const tampered =
				good.token.slice(0, -8) +
				(good.token.slice(-8) === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA");
			expect(tampered).not.toBe(good.token);
			expect(tampered.length).toBe(good.token.length);

			const buildRaw = (tok: string) => {
				const provider = new YSweetProvider(good.url, good.docId, new Y.Doc(), {
					connect: false,
					params: { token: tok },
					disableBc: true,
					maxConnectionErrors: 1,
					maxBackoffTime: 500,
				});
				openRawProviders.push(provider);
				return provider;
			};

			const bad = buildRaw(tampered);
			bad.connect();
			await sleep(6_000);
			expect(bad.wsconnected).toBe(false);
			expect(bad.synced).toBe(false);

			// Positive half of the same control: identical construction, genuine
			// token — proves the rejection above is about the token, not about the
			// way this test builds a provider.
			const ok = buildRaw(good.token);
			ok.connect();
			await waitFor(() => ok.wsconnected, 15_000, "genuine-token control connect");
			expect(ok.wsconnected).toBe(true);
		}, 40_000);
	});

	// =====================================================================
	// STEP 2 — two-client convergence
	// =====================================================================

	describe("step 2: two-client convergence", () => {
		const MARKER = `live-convergence-${Date.now()}-alpha`;
		let clientA: ProviderBacked;
		let clientB: ProviderBacked;

		test("client A's text reaches client B through the live relay", async () => {
			clientA = newClient("clientA");
			clientB = newClient("clientB");

			expect(await clientA.bringOnline()).toBe(true);
			expect(await clientB.bringOnline()).toBe(true);
			await clientA.onceEverSynced();
			await clientB.onceEverSynced();

			// Independent Y.Docs — no shared memory, no broadcast channel
			// (ProviderBacked builds providers with disableBc: true), so the only
			// path from A to B is the relay server.
			expect(clientA.crdtDoc).not.toBe(clientB.crdtDoc);

			clientA.crdtDoc.getText(YTEXT_KEY).insert(0, MARKER);

			await waitForText(
				() => clientB.crdtDoc.getText(YTEXT_KEY).toString(),
				MARKER,
				20_000,
				"A->B convergence",
			);

			// Assert on content, not on connection state.
			expect(clientB.crdtDoc.getText(YTEXT_KEY).toString()).toBe(MARKER);
			expect(clientA.crdtDoc.getText(YTEXT_KEY).toString()).toBe(MARKER);
		}, 60_000);

		test("and back: B's edit reaches A", async () => {
			const suffix = "-plus-beta";
			const textB = clientB.crdtDoc.getText(YTEXT_KEY);
			textB.insert(textB.length, suffix);

			await waitForText(
				() => clientA.crdtDoc.getText(YTEXT_KEY).toString(),
				MARKER + suffix,
				20_000,
				"B->A convergence",
			);
			expect(clientA.crdtDoc.getText(YTEXT_KEY).toString()).toBe(MARKER + suffix);
		}, 40_000);

		// -----------------------------------------------------------------
		// NEGATIVE CONTROL for step 2
		// -----------------------------------------------------------------
		test("negative control: the convergence waiter fails on a wrong expectation", async () => {
			const wrong = `${MARKER}-THIS-WAS-NEVER-WRITTEN`;
			await expect(
				waitForText(
					() => clientB.crdtDoc.getText(YTEXT_KEY).toString(),
					wrong,
					3_000,
					"deliberate-mismatch",
				),
			).rejects.toThrow(/never converged/);
		}, 20_000);
	});

	// =====================================================================
	// STEP 3 — persistence across reconnect ( ordering invariant)
	// =====================================================================

	describe("step 3: content survives a reconnect, and is only readable after sync", () => {
		/**
		 * Self-contained: writes its own marker, confirms an INDEPENDENT client
		 * saw it (so the relay demonstrably holds it, not just the writer's local
		 * Y.Doc), tears both down, and only then opens the "restarted" client.
		 * It does not lean on step 2's state.
		 */
		test("a freshly constructed client reads empty before sync and the full text after", async () => {
			const RESTART_MARKER = `restart-marker-${Date.now()}`;

			// --- write, and prove the server has it -------------------------
			const writer = newClient("clientD-writer");
			await writer.bringOnline();
			await writer.onceEverSynced();
			const wText = writer.crdtDoc.getText(YTEXT_KEY);
			wText.insert(wText.length, RESTART_MARKER);

			const witness = newClient("clientE-witness");
			await witness.bringOnline();
			await witness.onceEverSynced();
			await waitForText(
				() => witness.crdtDoc.getText(YTEXT_KEY).toString(),
				writer.crdtDoc.getText(YTEXT_KEY).toString(),
				20_000,
				"writer->witness (server holds the marker)",
			);
			const expectedText = witness.crdtDoc.getText(YTEXT_KEY).toString();
			expect(expectedText).toContain(RESTART_MARKER);

			// --- both clients go away ---------------------------------------
			writer.dismantle();
			witness.dismantle();
			await sleep(1_000);

			// --- "restart": brand-new ProviderBacked on a brand-new Y.Doc -------
			const reconnected = newClient("clientF-after-restart");

			// Pre-connect: nothing loaded yet.
			expect(reconnected.crdtDoc.getText(YTEXT_KEY).toString()).toBe("");

			await reconnected.bringOnline();

			// Sampled synchronously right after connect() resolves — before any
			// await that could let sync-step-2 land. This is the exact read that
			// TransferQueue.uploadDocumentViaSocket used to perform on `doc.text`
			// with no wait: it observes an EMPTY document even though the server
			// holds content, which is how a populated file got re-seeded from the
			// vault and doubled.
			const textBeforeSync = reconnected.crdtDoc.getText(YTEXT_KEY).toString();
			expect(reconnected.isSynced).toBe(false);
			expect(textBeforeSync).toBe("");

			// The fix's ordering: wait for sync FIRST, then read.
			await reconnected.onceEverSynced();
			await waitForText(
				() => reconnected.crdtDoc.getText(YTEXT_KEY).toString(),
				expectedText,
				20_000,
				"post-restart content arrival",
			);

			const textAfterSync = reconnected.crdtDoc.getText(YTEXT_KEY).toString();
			expect(textAfterSync).toBe(expectedText);
			expect(textAfterSync).toContain(RESTART_MARKER);

			// The whole point, stated as one assertion: the value you get before
			// waiting is NOT the value you get after.
			expect(textBeforeSync).not.toBe(textAfterSync);

			reconnected.dismantle();
		}, 90_000);

		/**
		 * Stronger form of the same claim. The test above re-reads while the
		 * relay still holds the doc in memory, so it proves the client reconnect
		 * path but not durability. Here every client goes away and stays away
		 * long enough for the relay to run its GC ("GCing doc" ->
		 * "Terminating loop for <doc>"), which forces the next reader to be
		 * served from object storage (MinIO) rather than a warm room.
		 *
		 * Eviction is asserted, not assumed: the relay's own log is grepped for
		 * the termination line for THIS doc id. Set LIVE_SKIP_EVICTION=1 to skip
		 * where the relay's logs are not reachable by that command.
		 */
		(process.env.LIVE_SKIP_EVICTION === "1" ? test.skip : test)("content is re-hydrated from object storage after the relay evicts the doc", async () => {
			const DURABILITY_MARKER = `durability-marker-${Date.now()}`;
			const evictDocId = crypto.randomUUID();
			const evictS3rn = new RemoteDocumentAddress(RELAY_ID, shareId, evictDocId);

			const makeClient = (label: string) => {
				const hp = new ProviderBacked(
					evictDocId,
					evictS3rn,
					tokenStore,
					authSession,
					SERVER_ID,
				);
				hp.entryPath = `${sharePath}/${label}.md`;
				openProviders.push(hp);
				return hp;
			};

			const writer = makeClient("evict-writer");
			await writer.bringOnline();
			await writer.onceEverSynced();
			writer.crdtDoc.getText(YTEXT_KEY).insert(0, DURABILITY_MARKER);

			const witness = makeClient("evict-witness");
			await witness.bringOnline();
			await witness.onceEverSynced();
			await waitForText(
				() => witness.crdtDoc.getText(YTEXT_KEY).toString(),
				DURABILITY_MARKER,
				20_000,
				"evict-writer->witness",
			);

			writer.dismantle();
			witness.dismantle();

			// Wait out the relay's GC. Observed on relay-server 0.9.12:
			// "candidate for GC" at ~10s idle, "GCing doc" at ~20s,
			// "Terminating loop" at ~30s.
			await waitFor(
				() => relayLogContains(`Terminating loop for ${evictDocId}`),
				90_000,
				`relay eviction of ${evictDocId}`,
			);

			const afterEviction = makeClient("evict-reader");
			await afterEviction.bringOnline();
			await afterEviction.onceEverSynced();
			await waitForText(
				() => afterEviction.crdtDoc.getText(YTEXT_KEY).toString(),
				DURABILITY_MARKER,
				20_000,
				"post-eviction re-hydration from object storage",
			);
			expect(afterEviction.crdtDoc.getText(YTEXT_KEY).toString()).toBe(
				DURABILITY_MARKER,
			);

			afterEviction.dismantle();
		}, 180_000);
	});

	// =====================================================================
	// STEP 4 — share creation / read-back via the control plane
	// =====================================================================

	describe("step 4 (partial): share lifecycle through RelayOnPremShareClient", () => {
		test("the share created for this run reads back from the live control plane", async () => {
			const detail = await shareClient.getShare(shareId);
			expect(detail.id).toBe(shareId);
			expect(detail.path).toBe(sharePath);
			expect(detail.kind).toBe("folder");

			const shares = await shareClient.listShares();
			expect(shares.map((s) => s.id)).toContain(shareId);
		}, 30_000);
	});
});
