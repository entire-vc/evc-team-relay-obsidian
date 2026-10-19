/**
 * Authentication Provider Factory
 *
 * `createAuthProvider`/`createAuthProviderForServer`/`PocketBaseAuthAdapter`
 * (the cloud-backend / PocketBase branch this file used to also build) were
 * removed as dead code: both functions had zero callers anywhere
 * in the tree, and the PocketBase branch they guarded is unreachable in the
 * shipped relay-onprem-only build in the first place (AuthSession never
 * constructs a PocketBase client when relay-onprem mode is enabled, which it
 * always is by default). RelayOnPremAuthProvider is constructed directly by
 * its own callers (MultiServerAuthManager) rather than through this factory.
 */

import type { RelayOnPremSettings } from "../RelayOnPremConfig";

/**
 * Check if relay-onprem mode is enabled
 * For Team Relay, this is always true (we don't support the hosted cloud backend)
 */
export function isRelayOnPremMode(settings: RelayOnPremSettings): boolean {
	// Always return true if enabled, even without servers configured
	// This ensures the relay-onprem UI is shown so users can add servers
	return settings.enabled;
}
