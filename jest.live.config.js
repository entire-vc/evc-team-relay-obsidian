/**
 * Jest config for the LIVE relay harness (`__tests__/live/`).
 *
 * Separate from jest.config.js on purpose:
 *  - `npm test` must stay hermetic and green with no server running, so
 *    jest.config.js ignores `__tests__/live/` outright (the suite/test
 *    baseline of 40/453 is unchanged by this harness);
 *  - the live run needs `obsidian` mapped to a boundary adapter whose
 *    `requestUrl` performs REAL HTTP (see __tests__/live/obsidianLive.ts),
 *    instead of the unit-test `jest.fn()`;
 *  - it needs a much longer per-test timeout (real sockets, real backoff).
 *
 * Run:  LIVE_RELAY=1 npx jest --config jest.live.config.js
 */
const base = require("./jest.config");

module.exports = {
	...base,
	moduleNameMapper: {
		...base.moduleNameMapper,
		"^obsidian$": "<rootDir>/__tests__/live/obsidianLive.ts",
	},
	// Deliberately drops the base config's `__tests__/live/` exclusion.
	testPathIgnorePatterns: [
		"/__tests__/mocks/",
		"/__tests__/jest.setup.js",
	],
	testMatch: ["<rootDir>/__tests__/live/*.test.ts"],
	testTimeout: 60_000,
	forceExit: true,
};
