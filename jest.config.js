//module.exports = {
//  preset: 'ts-jest',
//  testEnvironment: 'node',
//};
//
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	// [...]
	preset: "ts-jest/presets/default-esm", // or other ESM presets
	// polyfill window.* browser APIs in Node.js test environment
	setupFiles: ["<rootDir>/__tests__/jest.setup.js"],
	forceExit: true,
	// uuid (v11+), jose (v6+), eventsource (v5+), and pocketbase are all
	// ESM-only ("type": "module"/no CJS build — pocketbase ships only
	// dist/pocketbase.es.mjs); eventsource-parser (eventsource's own
	// dependency) is ESM-only too and surfaces the same error once eventsource
	// itself is unignored. Jest here runs in CJS despite the ESM preset (no
	// NODE_OPTIONS=--experimental-vm-modules in the "test" script), so their
	// "export" syntax needs to be transformed like our own source instead of
	// being treated as an opaque CJS dependency.
	transformIgnorePatterns: ["node_modules/(?!(uuid|jose|eventsource|eventsource-parser|pocketbase)/)"],
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
		"^src/(.*)$": "<rootDir>/src/$1",
		"^obsidian$": "<rootDir>/__tests__/mocks/obsidian.ts",
	},
	// Ignore editor/tool scratch directories (they may hold nested checkouts that
	// would otherwise inflate the suite counters).
	// __tests__/live/ holds the LIVE relay harness: it talks to a real
	// control-plane + relay-server over real sockets and is meaningless (and
	// red) without that stack running. It is excluded here so `npm test` stays
	// hermetic and the 40-suite/453-test baseline is unaffected; run it with
	// `LIVE_RELAY=1 npx jest --config jest.live.config.js`, which re-includes it.
	testPathIgnorePatterns: ["/__tests__/mocks/", "/__tests__/jest.setup.js", "/__tests__/live/"],
    globals: {
        "BUILD_TYPE": "production",
        "GIT_TAG": "test",
        // Match esbuild.config.mjs: this build compiles both empty (relay-onprem
        // only, no legacy cloud backend) — see .
        "API_URL": "",
        "AUTH_URL": "",
    },
	transform: {
		".js": [
			"ts-jest",
			{
				isolatedModules: true,
				useESM: true,
				allowJs: true,
			},
		],
		".ts": [
			"ts-jest",
			{
				// Note: We shouldn't need to include `isolatedModules` here because it's a deprecated config option in TS 5,
				// but setting it to `true` fixes the `ESM syntax is not allowed in a CommonJS module when
				// 'verbatimModuleSyntax' is enabled` error that we're seeing when running our Jest tests.
				isolatedModules: true,
				useESM: true,
			},
		],
	},
};
