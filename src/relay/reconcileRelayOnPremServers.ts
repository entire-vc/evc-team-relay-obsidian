import type { RelayOnPremServer } from "../RelayOnPremConfig";

export interface RelayOnPremServerSnapshot {
	controlPlaneUrl: string;
	name: string;
}

export type RelayOnPremServerSnapshotMap = Map<string, RelayOnPremServerSnapshot>;

export function snapshotRelayOnPremServers(
	servers: RelayOnPremServer[] | undefined,
): RelayOnPremServerSnapshotMap {
	return new Map(
		(servers || []).map((s) => [s.id, { controlPlaneUrl: s.controlPlaneUrl, name: s.name }]),
	);
}

export interface RelayOnPremServerDiff {
	added: RelayOnPremServer[];
	removedIds: string[];
	/** Servers present both before and after whose controlPlaneUrl or name
	 * actually changed — the only ones whose token provider needs replacing. */
	updated: RelayOnPremServer[];
}

/**
 * Diff a previous server snapshot against the current server list.
 *
 * A per-server RelayOnPremTokenProvider is long-lived and never re-reads
 * settings on its own, so a server whose controlPlaneUrl changed needs a
 * freshly constructed provider — but relayOnPremSettings.subscribe()
 * fires on ANY settings write (e.g. toggling a different server's default
 * featureKey), so without this diff every known provider was torn down and
 * reconstructed on every unrelated settings write, dropping in-flight
 * TokenRequestThrottle queues for servers nothing actually changed on.
 */
export function diffRelayOnPremServers(
	prevServers: RelayOnPremServerSnapshotMap,
	currentServers: RelayOnPremServer[],
): RelayOnPremServerDiff {
	const currentIds = new Set(currentServers.map((s) => s.id));
	const added: RelayOnPremServer[] = [];
	const updated: RelayOnPremServer[] = [];

	for (const server of currentServers) {
		const prev = prevServers.get(server.id);
		if (!prev) {
			added.push(server);
		} else if (
			prev.controlPlaneUrl !== server.controlPlaneUrl ||
			prev.name !== server.name
		) {
			updated.push(server);
		}
	}

	const removedIds = [...prevServers.keys()].filter((id) => !currentIds.has(id));

	return { added, removedIds, updated };
}
