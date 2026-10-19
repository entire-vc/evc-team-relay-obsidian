// ESLint config matching ObsidianReviewBot expectations
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.js",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...tseslint.configs.recommendedTypeChecked,
	{
		plugins: {
			obsidianmd: obsidianmd,
		},
		rules: {
			// eslint-plugin-obsidianmd >=0.4's configs.recommended is a full
			// flat-config ARRAY (its own eslint/typescript-eslint/import/SDL
			// preset) meant to be spread at the top level, not an object of
			// rule severities to spread into `rules`. This file is curated
			// to match what ObsidianReviewBot itself flags, so set the
			// obsidianmd/* severities directly instead of adopting the
			// package's full preset (which would also pull in the SDL/
			// import/depend/json/no-unsanitized/eslint-comments plugins this
			// file was never validated against).
			"obsidianmd/commands/no-command-in-command-id": "warn",
			"obsidianmd/commands/no-command-in-command-name": "warn",
			"obsidianmd/commands/no-default-hotkeys": "warn",
			"obsidianmd/commands/no-plugin-id-in-command-id": "warn",
			"obsidianmd/commands/no-plugin-name-in-command-name": "warn",
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "error",
			"obsidianmd/settings-tab/require-display": "warn",
			"obsidianmd/settings-tab/prefer-setting-definitions": "warn",
			"obsidianmd/settings-tab/prefer-update-over-display": "warn",
			"obsidianmd/settings-tab/no-deprecated-display": "warn",
			"obsidianmd/vault/iterate": "warn",
			"obsidianmd/detach-leaves": "error",
			"obsidianmd/editor-drop-paste": "warn",
			"obsidianmd/hardcoded-config-path": "warn",
			"obsidianmd/no-forbidden-elements": "error",
			"obsidianmd/no-global-this": "warn",
			"obsidianmd/no-sample-code": "error",
			"obsidianmd/no-tfile-tfolder-cast": "warn",
			"obsidianmd/no-static-styles-assignment": "error",
			"obsidianmd/object-assign": "warn",
			"obsidianmd/platform": "error",
			"obsidianmd/prefer-get-language": "warn",
			"obsidianmd/prefer-abstract-input-suggest": "warn",
			"obsidianmd/prefer-window-timers": "warn",
			"obsidianmd/prefer-active-doc": "off",
			"obsidianmd/regex-lookbehind": "error",
			"obsidianmd/sample-names": "error",
			"obsidianmd/validate-manifest": "warn",
			"obsidianmd/validate-license": ["warn"],
			"obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true }],
			// Typed-linting-dependent rules — safe here, this config enables projectService
			"obsidianmd/no-plugin-as-component": "error",
			"obsidianmd/no-view-references-in-plugin": "error",
			"obsidianmd/no-unsupported-api": "error",
			"obsidianmd/prefer-create-el": "warn",
			"obsidianmd/prefer-file-manager-trash-file": "warn",
			"obsidianmd/prefer-instanceof": "warn",
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Suppress rules the bot didn't flag
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/await-thenable": "off",
			// Keep the rules the bot DID flag
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/restrict-template-expressions": "error",
			"@typescript-eslint/unbound-method": "error",
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/prefer-promise-reject-errors": "error",
			"no-prototype-builtins": "error",
		},
	},
	// Bot doesn't apply @typescript-eslint/unbound-method to JS files
	{
		files: ["**/*.js"],
		rules: {
			"@typescript-eslint/unbound-method": "off",
		},
	},
	{
		ignores: [
			"node_modules/",
			"main.js",
			"*.config.js",
			"*.config.mjs",
			"esbuild.config.mjs",
		],
	},
);
