// Shared Svelte compiler config for both the esbuild bundle (esbuild.config.mjs)
// and svelte-check (CI job `svelte-check`, package.json script `typecheck:svelte`).
// Keeping ONE preprocess definition here — rather than a second inline
// `sveltePreprocess()` call in esbuild.config.mjs — means the two can't drift:
// svelte-check parsing <script lang="ts"> with different preprocessing than
// the real build would make its type errors (or its clean passes) describe a
// program that isn't actually what ships.
import sveltePreprocess from "svelte-preprocess";

export default {
	preprocess: sveltePreprocess(),
	// Shared with the DOM regression test (scripts/test/svelteDOM.cjs).
	// Components are mounted through src/svelteMount.ts (Svelte 5 mount/unmount).
	compilerOptions: { css: "injected" },
};
