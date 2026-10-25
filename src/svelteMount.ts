import { flushSync, mount, unmount, type Component } from "svelte";
import { SvelteMap } from "svelte/reactivity";

/**
 * A component mounted with Svelte 5's `mount()`, plus the two operations the
 * removed Svelte 4 class API (set / destroy) used to provide.
 */
export interface MountedComponent<P> {
	/** Replaces the listed props; the component re-renders on the next flush. */
	update(patch: Partial<P>): void;
	destroy(): void;
}

/**
 * Mounts `component` and keeps its props updatable from plain TypeScript.
 *
 * `mount()` reads props once unless they are reactive. Each prop lives in a
 * `SvelteMap` entry, so `update()` re-renders only what changed and values
 * are passed through as-is (no deep `$state` proxy around plugin objects,
 * Yjs awareness, Sets...). Keys absent at mount (e.g. `initialPath`) are
 * tracked too and can be set later.
 *
 * Pending effects are flushed right after mounting, as `new Component()`
 * did, so `onMount` callbacks have run by the time this returns.
 */
export function mountComponent<P extends Record<string, unknown>>(
	component: Component<P>,
	options: { target: Element; anchor?: Node; props: P },
): MountedComponent<P> {
	const values = new SvelteMap<string | symbol, unknown>(Object.entries(options.props));
	const props = new Proxy({} as P, {
		get: (_, key) => values.get(key),
		has: (_, key) => values.has(key),
		ownKeys: () => [...values.keys()],
		getOwnPropertyDescriptor: (_, key) =>
			values.has(key)
				? { value: values.get(key), writable: true, enumerable: true, configurable: true }
				: undefined,
	});
	const instance = mount(component, {
		target: options.target,
		anchor: options.anchor,
		props,
	});
	flushSync();
	return {
		update(patch) {
			for (const [key, value] of Object.entries(patch)) {
				values.set(key, value);
			}
		},
		destroy() {
			void unmount(instance);
		},
	};
}
