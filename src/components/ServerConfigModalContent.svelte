<script lang="ts">
	import { createEventDispatcher, onMount } from "svelte";
	import type TeamRelayPlugin from "../main";
	import AddTenantForm from "./AddTenantForm.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import TenantCard from "./TenantCard.svelte";
	import { validateEndpointUrl, describeCaughtError } from "./endpointUrlValidation";

	export let live: TeamRelayPlugin;

	const dispatch = createEventDispatcher();

	let newTenantUrl = "";
	let isValidating = false;
	let validationState = { isValid: true, error: "" };
	let errorMessage = "";
	let showInputError = false;
	let previousTenantUrl = ""; // remembers the last value so we can tell real edits from no-ops
	let hasChanges = false; // flips true once the user changes something

	// Settings are reactive; bump refreshTrigger to force a recompute
	let refreshTrigger = 0;

	// Pull the latest settings snapshot and derive the tenant list. `readValue()`
	// isn't itself reactive, so `refreshTrigger` is referenced (and voided) purely
	// to give Svelte a dependency to re-run this on forceUpdate().
	$: currentSettings = (() => {
		void refreshTrigger;
		return live.tenantEndpointSettings.readValue();
	})();
	$: tenants = currentSettings.tenants || [];
	$: activeTenantId = currentSettings.activeTenantId;

	// Resolve default URLs baked into the build configuration
	const defaultUrls = live.authSession.resolveTenantRegistry().resolveDefaultUrls();

	// Cached branding info for the default tenant (logo, customer name)
	let defaultTenantInfo: { customer?: string; logo?: string; environment?: string } | null =
		null;

	function forceUpdate() {
		refreshTrigger++;
	}

	function dismissError() {
		errorMessage = "";
		showInputError = false;
	}

	// Only clear errors if the user actually typed something new (not on
	// initial error setting) -- and only actually reassign when there's a
	// real value to clear, so an unrelated keystroke doesn't re-trigger
	// every reactive statement that depends on these two.
	function updateValidationState(url: string): void {
		const isDevelopment = live.authSession.resolveTenantRegistry().isDevBuild();
		validationState = validateEndpointUrl(url, isDevelopment);
		if (url !== previousTenantUrl && previousTenantUrl !== "") {
			if (showInputError) showInputError = false;
			if (errorMessage) errorMessage = "";
		}
		previousTenantUrl = url;
	}
	$: updateValidationState(newTenantUrl);

	// Handle the "add tenant" flow
	async function addTenant() {
		if (!newTenantUrl.trim() || !validationState.isValid) {
			return;
		}

		isValidating = true;
		try {
			const result = await live.authSession.resolveTenantRegistry().registerTenant(newTenantUrl);

			if (!result.success) {
				console.log("addTenant() returned a failure:", result.error);
				errorMessage = result.error || "Failed to add tenant";
				showInputError = true;
				forceUpdate(); // repaint so the error banner appears
				return;
			}

			newTenantUrl = "";
			errorMessage = "";
			showInputError = false;
			forceUpdate(); // Trigger UI refresh
			hasChanges = true;
			// Once added, jump straight to the newly created tenant
			if (result.tenantId) {
				await switchToTenant(result.tenantId);
			}
		} catch (error: unknown) {
			errorMessage = describeCaughtError("adding tenant", error);
			showInputError = true;
		} finally {
			isValidating = false;
		}
	}

	// Handle switching the active tenant
	async function switchToTenant(tenantId: string) {
		try {
			const result = await live.authSession.resolveTenantRegistry().activateTenant(tenantId);
			if (result.success) {
				hasChanges = true;
				forceUpdate(); // Trigger UI refresh
			} else {
				errorMessage = result.error || "Failed to switch tenant";
			}
		} catch (error: unknown) {
			errorMessage = describeCaughtError("switching tenant", error);
		}
	}

	// Handle deleting a tenant
	async function removeTenant(tenantId: string) {
		try {
			const success = await live.authSession.resolveTenantRegistry().deleteTenant(tenantId);
			if (success) {
				hasChanges = true;
				forceUpdate(); // Trigger UI refresh
			} else {
				errorMessage = "Failed to remove tenant";
			}
		} catch (error: unknown) {
			errorMessage = describeCaughtError("removing tenant", error);
		}
	}

	// Reset back to the built-in default tenant
	async function useDefaultTenant() {
		await live.tenantEndpointSettings.mutateValue((current) => ({
			...current,
			activeTenantId: undefined,
		}));
		live.authSession.resolveTenantRegistry().resetValidatedEndpoints();
		hasChanges = true;
		forceUpdate(); // Trigger UI refresh
	}

	// Fetch default-tenant branding from the license endpoint
	async function loadDefaultTenantInfo() {
		try {
			const endpointManager = live.authSession.resolveTenantRegistry();
			defaultTenantInfo = await endpointManager.resolveDefaultTenantInfo();
		} catch (error: unknown) {
			console.log("loadDefaultTenantInfo() threw:", error);
			defaultTenantInfo = null;
		}
	}

	function handleApplyOrClose() {
		dispatch(hasChanges ? "apply" : "close");
	}

	// Kick off the default-tenant info fetch on mount
	onMount(() => {
		loadDefaultTenantInfo();
	});
</script>

<div class="evc-endpoint-config-modal">
	<div class="setting-item-description" style="margin-bottom: 16px;">
		<p>
			Manage your organization's enterprise Relay tenants. Add tenants to
			switch between different enterprise deployments.
		</p>
	</div>

	<AddTenantForm
		bind:url={newTenantUrl}
		urlValid={validationState.isValid}
		{showInputError}
		invalidTitle={validationState.error}
		{isValidating}
		onAddTenant={addTenant}
	/>

	{#if errorMessage && errorMessage.trim()}
		<ErrorBanner {errorMessage} onDismiss={dismissError} />
	{/if}

	<div class="evc-tenant-list-section">
		<div class="setting-item-name">Available Tenants</div>
		<div class="evc-tenant-list">
			<TenantCard
				tenantName={defaultTenantInfo?.customer || "Default Tenant"}
				url={defaultUrls.authUrl}
				environment={defaultTenantInfo?.environment || defaultUrls.environment}
				logo={defaultTenantInfo?.logo}
				logoAlt={defaultTenantInfo?.customer || "Default Tenant"}
				active={!activeTenantId}
				cardTitle="Click to use default tenant"
				onActivate={useDefaultTenant}
			/>

			{#each tenants as tenant (tenant.id)}
				<TenantCard
					tenantName={tenant.name}
					url={tenant.tenantUrl}
					environment={tenant.environment}
					logo={tenant.logo}
					logoAlt={tenant.name}
					active={tenant.id === activeTenantId}
					cardTitle="Click to switch to this tenant"
					onActivate={() => switchToTenant(tenant.id)}
					onRemove={() => removeTenant(tenant.id)}
				/>
			{/each}
		</div>
	</div>

	<div class="evc-apply-section">
		<button class="mod-cta evc-apply-btn" on:click={handleApplyOrClose}>Apply</button>
	</div>
</div>

<style>
	.evc-endpoint-config-modal {
		padding: 0;
	}

	.evc-tenant-list-section {
		margin: 16px 0;
	}

	.evc-apply-section {
		display: flex;
		justify-content: flex-end;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.evc-apply-btn {
		padding: 8px 20px;
		font-size: 0.9em;
	}
</style>
