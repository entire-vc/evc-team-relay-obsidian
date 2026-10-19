import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidianPlugin from "eslint-plugin-obsidianmd";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            obsidianmd: obsidianPlugin,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                sourceType: "module",
            },
        },
        rules: {
            // eslint-plugin-obsidianmd >=0.4's configs.recommended is a full
            // flat-config ARRAY (its own eslint/typescript-eslint/import/SDL
            // preset), meant to be spread at the top level -- not an object
            // of rule severities to spread into `rules`. Its TS block also
            // requires parserOptions.project (typed linting), which this repo
            // doesn't enable. So instead of adopting that array wholesale, set
            // the obsidianmd/* severities directly, matching the untyped
            // subset the package itself uses for non-type-checked files
            // (its internal recommendedPluginRulesConfigBase).
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
            // These rules require parserOptions.project (typed linting) — not enabled in this config
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-view-references-in-plugin": "off",
            "obsidianmd/no-unsupported-api": "off",
            "obsidianmd/prefer-create-el": "off",
            "obsidianmd/prefer-file-manager-trash-file": "off",
            "obsidianmd/prefer-instanceof": "off",
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrorsIgnorePattern: "^_" }],
            "@typescript-eslint/ban-ts-comment": "off",
            "no-prototype-builtins": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "fs",
                            message: "Do not use Node's fs module.",
                        },
                        {
                            name: "path",
                            message: "Do not use Node's path module.",
                        },
                        {
                            name: "http",
                            message: "Do not use Node's http module.",
                        },
                        {
                            name: "crypto",
                            message: "Do not use Node's crypto module.",
                        },
                    ],
                },
            ],
        },
    },
    {
        // Test and build files need Node.js built-ins and have different conventions
        files: ["__tests__/**/*", "esbuild.config.mjs", "version-bump.mjs", "scripts/**/*"],
        rules: {
            "no-restricted-imports": "off",
            "@typescript-eslint/no-unused-vars": "warn",
            "no-empty": "warn",
            "obsidianmd/hardcoded-config-path": "off",
        },
    },
    {
        files: ["scripts/test/**/*.cjs", "__tests__/**/*.cjs"],
        languageOptions: {
            sourceType: "commonjs",
        },
        rules: {
            // CommonJS helpers use require because they run under Jest's CJS runtime.
            "@typescript-eslint/no-require-imports": "off",
        },
    },
    {
        files: ["__tests__/**/*.cjs"],
        languageOptions: {
            globals: globals.jest,
        },
    },
    {
        ignores: ["node_modules/", "main.js", "*.config.js"],
    }
);
