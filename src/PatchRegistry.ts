import { around } from "monkey-around";
import { Loggable } from "./logging";

// Extend window interface to include our debugging property
declare global {
	interface Window {
		evcTeamRelayPatches?: Array<() => void>;
	}
}

interface PatchRecord {
	target: object;
	methods: string[];
	unpatch: () => void;
}

/**
 * Singleton manager for every monkey-around patch this plugin installs.
 *
 * Each `install()` call is tracked by an incrementing id in a single map, which
 * doubles as both the cleanup list and the source for conflict detection —
 * rather than keeping cleanup functions and patched-method bookkeeping in two
 * separate structures that have to be kept in sync by hand.
 */
export class PatchRegistry extends Loggable {
	private static singleton: PatchRegistry | null = null;
	private nextId = 0;
	private records = new Map<number, PatchRecord>();
	private patchedMethodsByTarget = new WeakMap<object, Set<string>>();

	private constructor() {
		super("PatchRegistry");
		// Initialize window.evcTeamRelayPatches for debugging
		if (typeof window !== "undefined") {
			if (window.evcTeamRelayPatches && window.evcTeamRelayPatches.length > 0) {
				console.warn(
					`Found ${window.evcTeamRelayPatches.length} existing unsubscribers on window.evcTeamRelayPatches at startup - possible memory leak or incomplete cleanup`,
				);
			}
			window.evcTeamRelayPatches = [];
		}
	}

	/**
	 * Get the singleton instance
	 */
	static access(): PatchRegistry {
		if (!PatchRegistry.singleton) {
			PatchRegistry.singleton = new PatchRegistry();
		}
		return PatchRegistry.singleton;
	}

	/**
	 * Create a monkeypatch and register its cleanup function.
	 * Prevents duplicate patches of the same method on the same instance.
	 */
	install<T extends object>(target: T, patches: Record<string, object>): () => void {
		const alreadyPatched = this.patchedMethodsByTarget.get(target) ?? new Set<string>();
		const requested = Object.keys(patches);
		const conflicts = requested.filter((method) => alreadyPatched.has(method));

		if (conflicts.length > 0) {
			this.warn(
				`Methods [${conflicts.join(", ")}] already patched on ${(target as { constructor?: { name?: string } }).constructor?.name}, skipping duplicates`,
			);

			const nonConflicting = requested.filter((method) => !conflicts.includes(method));
			if (nonConflicting.length === 0) {
				this.debug("All methods conflicted, returning no-op unsubscriber");
				return () => {}; // No-op if all methods conflict
			}

			const filtered: Record<string, object> = {};
			for (const method of nonConflicting) {
				filtered[method] = patches[method];
			}
			patches = filtered;
		}

		const methods = Object.keys(patches);
		methods.forEach((method) => alreadyPatched.add(method));
		this.patchedMethodsByTarget.set(target, alreadyPatched);

		// Apply patch using type assertion required for monkey-around's generic constraint
		const unpatch = around(
			target as unknown as Record<string, object>,
			patches as Parameters<typeof around>[1],
		);

		const id = this.nextId++;
		this.records.set(id, { target, methods, unpatch });

		// Also store on window for debugging
		window.evcTeamRelayPatches?.push(unpatch);

		this.debug("Applied monkeypatch", {
			target: (target as { constructor?: { name?: string } }).constructor?.name,
			methods,
			patchCount: this.records.size,
		});

		return () => this.release(id);
	}

	private release(id: number): void {
		const record = this.records.get(id);
		if (!record) return;

		const tracked = this.patchedMethodsByTarget.get(record.target);
		if (tracked) {
			record.methods.forEach((method) => tracked.delete(method));
			if (tracked.size === 0) {
				this.patchedMethodsByTarget.delete(record.target);
			}
		}

		this.records.delete(id);

		if (window.evcTeamRelayPatches) {
			const index = window.evcTeamRelayPatches.indexOf(record.unpatch);
			if (index >= 0) window.evcTeamRelayPatches.splice(index, 1);
		}

		record.unpatch();
	}

	/**
	 * Get the total number of registered cleanups
	 */
	patchCount(): number {
		return this.records.size;
	}

	/**
	 * Cleanup all registered monkeypatches and resources.
	 * Called during plugin unload.
	 */
	private teardown(): void {
		const count = this.records.size;
		this.debug("Starting cleanup of monkeypatches", { count });

		let cleaned = 0;
		for (const record of this.records.values()) {
			try {
				record.unpatch();
				cleaned++;
				this.debug("Cleaned up monkeypatch", { index: cleaned, total: count });
			} catch (error: unknown) {
				this.error("Error during monkeypatch cleanup", { index: cleaned + 1, error });
			}
		}
		this.records.clear();

		// Clear window.evcTeamRelayPatches as well
		if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
			window.evcTeamRelayPatches.length = 0;
		}

		this.log("Completed cleanup of monkeypatches", { cleanedCount: count });
	}

	/**
	 * Destroy the singleton instance and cleanup all monkeypatches.
	 * Follows the repo's standard destroy() pattern.
	 */
	static shutdown(): void {
		if (PatchRegistry.singleton) {
			PatchRegistry.singleton.teardown();
			PatchRegistry.singleton = null;
		}
		// Clear window.evcTeamRelayPatches even if instance is null
		if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
			window.evcTeamRelayPatches.length = 0;
		}
	}

	/**
	 * Check if any monkeypatches are currently registered
	 */
	hasPatches(): boolean {
		return this.records.size > 0;
	}
}

/**
 * Convenience function to get the singleton instance
 */
export const getPatchRegistry = (): PatchRegistry => PatchRegistry.access();
