<script lang="ts">
	import { onMount } from "svelte";
	import { Notice } from "obsidian";
	import type TeamRelayPlugin from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { BillingApiError } from "../RelayOnPremShareClient";
	import { resolveCurrentPlanId } from "../billing/currentPlan";
	import { BYTE_VALUED_ENTITLEMENTS, classifyEntitlement } from "../billing/entitlements";
	import { formatAmount } from "../billing/money";
	import { isOpenableUrl } from "../billing/openableUrl";
	import { selectDisplayPrice } from "../billing/planPrice";
	import { uiText } from "../wording/uiText";
	import type { BillingPlanResponse, AvailablePlan } from "../RelayOnPremShareClient";

	export let live: TeamRelayPlugin;
	export let server: RelayOnPremServer;

	let billingData: BillingPlanResponse | null = null;
	let availablePlans: AvailablePlan[] = [];
	let loading = true;
	let error: string | null = null;
	let cancellingSubscription = false;
	let checkingOut = false;
	let openingPortal = false;
	// Set once the server answers a checkout attempt with something that is
	// not an openable link. Drives the "Soon" button + explanatory line: the
	// button must STAY on screen saying what is happening, not disappear
	// (an empty space tells a bank nothing; "being
	// connected" tells it the mechanism exists and is waiting on them).
	let checkoutComingSoon = false;

	onMount(async () => {
		await loadBillingData();
	});

	function getClient() {
		return live.shareClientManager?.getClient(server.id) || live.shareClient;
	}

	async function loadBillingData() {
		loading = true;
		error = null;
		try {
			const client = getClient();
			if (!client) {
				error = uiText("billing.notConnectedToServer");
				return;
			}
			billingData = await client.getBillingPlan();
			try {
				availablePlans = await client.getAvailablePlans();
			} catch {
				// Non-critical
			}
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : uiText("billing.loadFailed");
		} finally {
			loading = false;
		}
	}

	function getUsagePercent(usage: { current: number; max: number | null | undefined; percentage: number | null | undefined }): number {
		if (usage.percentage !== null && usage.percentage !== undefined) return usage.percentage;
		if (usage.max === null || usage.max === undefined || usage.max === 0) return 0;
		return Math.min(100, Math.round((usage.current / usage.max) * 100));
	}

	function getUsageClass(percent: number): string {
		if (percent >= 100) return "evc-usage-full";
		if (percent >= 80) return "evc-usage-warning";
		return "evc-usage-ok";
	}

	function formatLimit(max: number | null | undefined): string {
		return max == null ? uiText("billing.unlimited") : String(max);
	}

	/** `3.0` -> `3,0`. The only fractional figure on this screen is GB. */
	function localizeDecimal(value: string): string {
		return value.replace(".", uiText("billing.decimalSeparator"));
	}

	function formatBytes(bytes: number | null | undefined): string {
		// The API's declared type promises `number | null` for these fields, but a
		// real server has been observed sending a field back missing entirely
		// (JS `undefined`, not JSON `null`) -- treat that the same as "no limit"
		// rather than falling through to the numeric branches below and printing
		// the literal string "undefined B".
		if (bytes === null || bytes === undefined) return uiText("billing.unlimited");
		if (bytes >= 1073741824)
			return uiText("billing.bytes.gigabytes", {
				value: localizeDecimal((bytes / 1073741824).toFixed(1)),
			});
		if (bytes >= 1048576)
			return uiText("billing.bytes.megabytes", { value: (bytes / 1048576).toFixed(0) });
		return uiText("billing.bytes.bytes", { value: bytes });
	}

	/**
	 * The `/mo` half of a price. Interface language, unlike the symbol --
	 * `formatAmount` deliberately knows nothing about the phrasebook.
	 */
	function formatPeriod(billingPeriod: string): string {
		return billingPeriod === "month"
			? uiText("billing.period.month")
			: uiText("billing.period.year");
	}

	function formatPrice(amount: number, currency: string, period: string): string {
		return `${formatAmount(amount, currency)}/${formatPeriod(period)}`;
	}

	/**
	 * Shown as the card's headline price. The three-way choice lives in
	 * `selectDisplayPrice` (pure, unit-tested); this only puts words to it.
	 */
	function getPlanPrice(plan: AvailablePlan): string {
		const display = selectDisplayPrice(plan);
		if (display.kind === "none") return NO_PRICE;
		if (display.kind === "free") return uiText("billing.freePrice");
		const { amount, currency, billing_period } = display.price;
		return formatPrice(amount, currency, billing_period);
	}

	/** Em dash: "we were told no price", as opposed to "the price is zero". */
	const NO_PRICE = "—";

	// Built once, not reactively: the interface language is fixed for the
	// lifetime of the Obsidian window, so there is nothing here to re-run.
	const USAGE_LABELS: Record<string, string> = {
		shares: uiText("billing.usage.shares"),
		web_published: uiText("billing.usage.webPublished"),
		storage: uiText("billing.usage.storage"),
	};

	const ENTITLEMENT_LABELS: Record<string, string> = {
		max_shares: uiText("billing.entitlement.maxShares"),
		max_members_per_share: uiText("billing.entitlement.maxMembersPerShare"),
		max_web_published: uiText("billing.entitlement.maxWebPublished"),
		max_storage_bytes: uiText("billing.entitlement.maxStorageBytes"),
		// Added by the RU catalogue migration (`018_teamrelay_ru_pricing`) --
		// present on every RU tier, absent from the USD/entire.vc lineup today.
		max_file_size_bytes: uiText("billing.entitlement.maxFileSizeBytes"),
		version_history_days: uiText("billing.entitlement.versionHistoryDays"),
		// `{ enabled: bool }`-shaped, RU "Командный" tier only today.
		roles_enabled: uiText("billing.entitlement.rolesEnabled"),
		closing_docs_edo_enabled: uiText("billing.entitlement.closingDocsEdoEnabled"),
	};

	// Non-numeric entitlements to skip in the plan feature list
	const HIDDEN_ENTITLEMENTS = new Set(["allowed_web_visibility"]);

	async function handleUpgrade(plan: AvailablePlan, priceId: string) {
		checkingOut = true;
		try {
			const client = getClient();
			if (!client) throw new Error(uiText("billing.notConnected"));

			// Smart routing: existing active subscription → change plan, otherwise → new checkout
			if (hasSub && !isCancelled && billingData?.subscription?.id) {
				await client.changePlan(plan.id, priceId);
				// `result.message` is deliberately dropped, same rule as the two
				// paths below. The server has a stub branch here too
				// (billing_service.py: "Plan changed (stub mode)") -- I claimed
				// in an earlier commit that it had none, and that was wrong.
				// It is unreachable today only because stub mode never
				// populates a subscription, so `hasSub` gates this branch off
				// -- i.e. the safety comes from a DIFFERENT subsystem, not from
				// anything here. That is a landmine, not a guarantee.
				new Notice(uiText("billing.planChangedNotice"));
				await loadBillingData();
			} else {
				// Every way `createCheckout` can fail to hand back an openable
				// link -- a non-URL response (the stub marker) AND a thrown
				// error (a live 422 "Invalid billing data" once the RU
				// catalogue moved off stub mode and the payment gateway isn't
				// active yet finding 2) -- degrades to the SAME
				// "being connected" state. Two branches that both mean "no
				// checkout today" must not diverge on what the user sees:
				// that divergence is exactly how the stub-marker fix shipped
				// tested against a scenario the real backend had already
				// stopped producing.
				let result: Awaited<ReturnType<typeof client.createCheckout>> | null = null;
				try {
					result = await client.createCheckout(plan.id, priceId);
				} catch {
					checkoutComingSoon = true;
					new Notice(uiText("billing.checkoutComingSoonNote"));
				}
				if (result) {
					const checkoutUrl = result.checkout_url;
					if (isOpenableUrl(checkoutUrl)) {
						window.open(checkoutUrl);
						new Notice(uiText("billing.openingCheckoutNotice"));
					} else if (typeof checkoutUrl === "string" && checkoutUrl.trim() !== "") {
						// The server answered with something that is not a link --
						// today the stub marker, tomorrow anything else. Announcing
						// a checkout that is not opening would be a lie, so switch
						// the button to its "being connected" state instead.
						//
						// `result.message` is deliberately NOT surfaced: the server
						// says "Billing is in stub mode. Upgrade not available.",
						// and those are internal words. Our own copy ships instead.
						checkoutComingSoon = true;
						new Notice(uiText("billing.checkoutComingSoonNote"));
					} else {
						new Notice(uiText("billing.subscriptionActivatedNotice"));
						await loadBillingData();
					}
				}
			}
		} catch (e: unknown) {
			new Notice(uiText("billing.upgradeFailedNotice", {
				error: e instanceof Error ? e.message : uiText("shared.unknownError"),
			}));
		} finally {
			checkingOut = false;
		}
	}

	async function handleManageSubscription() {
		openingPortal = true;
		try {
			const client = getClient();
			if (!client) throw new Error(uiText("billing.notConnected"));
			const result = await client.createPortalSession();
			// Same guard as checkout above. The stub happens to return a null
			// url here (so plain truthiness would have worked today), but the
			// two paths must not disagree about what counts as openable --
			// that difference is exactly how the checkout bug survived.
			if (isOpenableUrl(result.url)) {
				window.open(result.url);
				new Notice(uiText("billing.openingPortalNotice"));
			} else {
				// Same reason as checkout above: the stub's own message says
				// "Billing is in stub mode. Portal not available." Our copy,
				// not theirs -- internal words must not reach a user.
				new Notice(uiText("billing.portalNotAvailable"));
			}
		} catch (e: unknown) {
			new Notice(uiText("billing.portalFailedNotice", {
				error: e instanceof Error ? e.message : uiText("shared.unknownError"),
			}));
		} finally {
			openingPortal = false;
		}
	}

	async function handleCancel() {
		cancellingSubscription = true;
		try {
			const client = getClient();
			if (!client) throw new Error(uiText("billing.notConnected"));
			await client.cancelSubscription();
			new Notice(uiText("billing.subscriptionCancelledNotice"));
			await loadBillingData();
		} catch (e: unknown) {
			new Notice(uiText("billing.cancelFailedNotice", {
				error: e instanceof Error ? e.message : uiText("shared.unknownError"),
			}));
		} finally {
			cancellingSubscription = false;
		}
	}

	$: isFree = billingData?.plan === "free" || billingData?.plan === "Free" || billingData?.plan === "Relay Free";
	$: hasSub = billingData?.subscription !== null && billingData?.subscription !== undefined;
	$: currentPlanId = resolveCurrentPlanId(billingData, availablePlans);
	$: isCancelled = billingData?.subscription?.cancel_at_period_end === true || billingData?.subscription?.status === "cancelled";
</script>

<div class="evc-billing-view">
	<div class="evc-section-title">{uiText("billing.title")}</div>
	<div class="evc-section-desc">{uiText("billing.onServer", { server: server.name })}</div>

	{#if loading}
		<div class="evc-loading">{uiText("billing.loading")}</div>
	{:else if error}
		<div class="evc-error">{error}</div>
	{:else if billingData}
		<!-- Plan Cards -->
		{#if availablePlans.length > 0}
			<div class="evc-plans-grid">
				{#each availablePlans as plan (plan.id)}
					{@const current = plan.id === currentPlanId}
					{@const isFreeCard = plan.prices?.every(p => p.amount === 0) ?? true}
					<div class="evc-plan-card" class:is-current={current} class:is-pro={!isFreeCard}>
						<!-- Header -->
						<div class="evc-plan-header">
							<div class="evc-plan-name">{plan.name}</div>
							{#if current}
								{#if isCancelled}
									<span class="evc-plan-badge evc-badge-warning">{uiText("billing.badge.cancelling")}</span>
								{:else if hasSub}
									<span class="evc-plan-badge evc-badge-active">{uiText("billing.badge.active")}</span>
								{:else}
									<span class="evc-plan-badge evc-badge-current">{uiText("billing.badge.current")}</span>
								{/if}
							{/if}
						</div>

						<!-- Price -->
						<div class="evc-plan-price">{getPlanPrice(plan)}</div>

						<!-- Entitlements -->
						<div class="evc-plan-features">
							{#each Object.entries(plan.entitlements || {}) as [key, value]}
								{#if !HIDDEN_ENTITLEMENTS.has(key) && ENTITLEMENT_LABELS[key]}
									{@const display = classifyEntitlement(value)}
									{#if display.kind === "limit"}
										<div class="evc-plan-feature">
											<span class="evc-feature-value">
												{BYTE_VALUED_ENTITLEMENTS.has(key)
													? formatBytes(display.limit)
													: formatLimit(display.limit)}
											</span>
											<span class="evc-feature-label">{ENTITLEMENT_LABELS[key]}</span>
										</div>
									{:else if display.kind === "flag" && display.enabled}
										<div class="evc-plan-feature">
											<span class="evc-feature-value">{uiText("billing.entitlement.enabledValue")}</span>
											<span class="evc-feature-label">{ENTITLEMENT_LABELS[key]}</span>
										</div>
									{/if}
									<!-- No `|| key` fallback on the label, and no row at all for
									     display.kind === "unknown" or a disabled flag: an entitlement
									     key with no registered label, or a shape this screen doesn't
									     understand, must NEVER print raw snake_case on a screen headed
									     to a bank -- that silent-key-leak is the bug this block
									     replaces. A key ships a row only once it has both
									     a label (this file) and a recognised shape (../billing/entitlements). -->
								{/if}
							{/each}
						</div>

						<!-- Action -->
						<div class="evc-plan-action">
							{#if current}
								{#if isCancelled}
									{#each plan.prices as price}
										{#if price.amount > 0}
											<button
												class="evc-plan-btn evc-btn-upgrade"
												disabled={checkingOut}
												on:click={() => handleUpgrade(plan, price.id)}
											>
												{checkingOut ? "..." : uiText("billing.resubscribeButton")}
											</button>
										{/if}
									{/each}
								{:else if hasSub}
									<button
										class="evc-plan-btn evc-btn-manage"
										disabled={openingPortal}
										on:click={handleManageSubscription}
									>
										{openingPortal ? "..." : uiText("billing.manageButton")}
									</button>
									<button
										class="evc-plan-btn evc-btn-cancel"
										disabled={cancellingSubscription}
										on:click={handleCancel}
									>
										{cancellingSubscription ? "..." : uiText("billing.cancelSubscriptionButton")}
									</button>
								{:else}
									<div class="evc-plan-btn evc-btn-current">{uiText("billing.currentPlanButton")}</div>
								{/if}
							{:else if !isFreeCard}
								<div class="evc-plan-prices-row">
									{#each plan.prices as price}
										{#if price.amount > 0}
											<button
												class="evc-plan-btn evc-btn-upgrade"
												class:is-coming-soon={checkoutComingSoon}
												disabled={checkingOut || checkoutComingSoon}
												on:click={() => handleUpgrade(plan, price.id)}
											>
												{#if checkingOut}
													...
												{:else if checkoutComingSoon}
													{uiText("billing.comingSoonButton")}
												{:else}
													{formatPrice(price.amount, price.currency, price.billing_period)}
												{/if}
											</button>
										{/if}
									{/each}
								</div>
							{/if}
						</div>

						{#if current && isCancelled && billingData.subscription?.current_period_end}
							<div class="evc-plan-note">
								{uiText("billing.accessUntil", { date: new Date(billingData.subscription.current_period_end).toLocaleDateString() })}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if checkoutComingSoon}
			<div class="evc-checkout-note">{uiText("billing.checkoutComingSoonNote")}</div>
		{/if}

		<!-- Usage -->
		<div class="evc-usage-section">
			<div class="evc-usage-title">{uiText("billing.usageTitle")}</div>
			{#each Object.entries(billingData.usage) as [key, usage]}
				{@const percent = getUsagePercent(usage)}
				{@const usageClass = getUsageClass(percent)}
				<div class="evc-usage-item">
					<div class="evc-usage-label">
						<span>{USAGE_LABELS[key] || key}</span>
						<span class="evc-usage-count">
							{#if key === "storage"}
								{usage.current !== null && usage.current !== undefined
									? formatBytes(usage.current)
									: "—"} / {formatBytes(usage.max)}
							{:else}
								{usage.current} / {formatLimit(usage.max)}
							{/if}
						</span>
					</div>
					<div class="evc-usage-bar">
						<div
							class="evc-usage-fill {usageClass}"
							style="width: {usage.max == null ? 0 : percent}%"
						></div>
					</div>
					{#if percent >= 80 && usage.max != null}
						<div class="evc-usage-hint {usageClass}">
							{#if percent >= 100}
								{uiText("billing.limitReached")}
							{:else}
								{uiText("billing.percentUsed", { percent })}
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Refresh -->
		<button class="evc-refresh-btn" on:click={loadBillingData}>
			{uiText("billing.refreshButton")}
		</button>
	{/if}
</div>

<style>
	.evc-billing-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-section-desc {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: -8px;
	}

	.evc-loading {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 8px;
	}

	.evc-error {
		padding: 16px;
		color: var(--text-error);
		background: var(--background-modifier-error);
		border-radius: 8px;
	}

	/* Plan cards grid */
	.evc-plans-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}

	.evc-plan-card {
		display: flex;
		flex-direction: column;
		padding: 16px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		gap: 12px;
	}

	.evc-plan-card.is-current {
		border-color: var(--interactive-accent);
		border-width: 2px;
	}

	.evc-plan-card.is-pro:not(.is-current) {
		border-color: var(--text-faint);
	}

	.evc-plan-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.evc-plan-name {
		font-weight: 700;
		font-size: 1.05em;
	}

	.evc-plan-badge {
		font-size: 0.7em;
		padding: 2px 8px;
		border-radius: 12px;
		font-weight: 600;
		white-space: nowrap;
	}

	.evc-badge-current {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	.evc-badge-active {
		background: var(--background-modifier-success, #dcfce7);
		color: var(--text-success, #166534);
	}

	.evc-badge-warning {
		background: var(--background-modifier-error);
		color: var(--text-warning, #b08800);
	}

	.evc-plan-price {
		font-size: 1.4em;
		font-weight: 700;
		color: var(--text-normal);
	}

	.evc-plan-features {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
	}

	.evc-plan-feature {
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 0.85em;
	}

	.evc-feature-value {
		font-weight: 600;
		min-width: 50px;
	}

	.evc-feature-label {
		color: var(--text-muted);
	}

	.evc-plan-action {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: auto;
	}

	.evc-plan-prices-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		width: 100%;
	}

	.evc-plan-btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.85em;
		font-weight: 600;
		cursor: pointer;
		text-align: center;
		border: none;
	}

	.evc-btn-current {
		background: var(--background-modifier-border);
		color: var(--text-muted);
		cursor: default;
		width: 100%;
	}

	.evc-btn-upgrade {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		flex: 1;
	}

	.evc-btn-upgrade:hover { opacity: 0.9; }
	.evc-btn-upgrade:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-btn-manage {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		flex: 1;
	}

	.evc-btn-manage:hover { opacity: 0.9; }
	.evc-btn-manage:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-btn-cancel {
		background: transparent;
		color: var(--text-error);
		border: 1px solid var(--text-error);
	}

	.evc-btn-cancel:hover { background: var(--background-modifier-error); }
	.evc-btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-plan-note {
		font-size: 0.8em;
		color: var(--text-muted);
	}

	/* Reads as a state, not a failure: muted text, no error colouring. */
	.evc-checkout-note {
		font-size: 0.85em;
		color: var(--text-muted);
		padding: 8px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.evc-btn-upgrade.is-coming-soon {
		background: var(--background-modifier-border);
		color: var(--text-muted);
		cursor: default;
	}

	/* Usage section */
	.evc-usage-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.evc-usage-title {
		font-weight: 600;
		font-size: 0.95em;
	}

	.evc-usage-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.evc-usage-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.9em;
	}

	.evc-usage-count {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.evc-usage-bar {
		height: 6px;
		background: var(--background-modifier-border);
		border-radius: 3px;
		overflow: hidden;
	}

	.evc-usage-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.evc-usage-fill.evc-usage-ok { background: var(--interactive-accent); }
	.evc-usage-fill.evc-usage-warning { background: var(--text-warning, #b08800); }
	.evc-usage-fill.evc-usage-full { background: var(--text-error); }

	.evc-usage-hint { font-size: 0.8em; }
	.evc-usage-hint.evc-usage-warning { color: var(--text-warning, #b08800); }
	.evc-usage-hint.evc-usage-full { color: var(--text-error); }

	.evc-refresh-btn {
		padding: 4px 12px;
		background: transparent;
		color: var(--text-muted);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8em;
		align-self: flex-start;
	}

	.evc-refresh-btn:hover { color: var(--text-normal); }
</style>
