import * as fs from "fs";
import * as path from "path";
import { openSettingsAt, SettingsPathRouter, type SettingsWindow } from "../src/settingsNavigation";

/**
 * Deep links into the plugin's settings (Fix folder, "share settings" in the
 * folder menu, the ribbon...) all go through `showSettingsTab(path)`.
 *
 * Obsidian keys a plugin's settings tab by its manifest id and
 * `openTabById()` ignores an unknown id, so a hard-coded id that no longer
 * matches manifest.json leaves the window on Settings > General and the
 * requested page never appears (the 0.1.34 candidate shipped
 * `openTabById("team-relay")` while the manifest id is `team-relay-sync`).
 */

const ROOT = path.join(__dirname, "..");
const MANIFEST_ID: string = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).id;

/** Mirrors Obsidian: tabs are registered by id; an unknown id is a no-op. */
function fakeSettingsWindow(pluginTabIds: string[]) {
	const state = { open: false, activeTab: "general" };
	const setting: SettingsWindow = {
		open: async () => {
			if (!state.open) state.activeTab = "general";
			state.open = true;
		},
		openTabById: async (id: string) => {
			if (pluginTabIds.includes(id)) state.activeTab = id;
		},
	};
	return { setting, state };
}

function recordingPanel() {
	const paths: (string | undefined)[] = [];
	return { paths, update: (patch: { initialPath?: string }) => paths.push(patch.initialPath) };
}

describe("openSettingsAt", () => {
	it("opens the tab Obsidian registered under the manifest id", async () => {
		const { setting, state } = fakeSettingsWindow([MANIFEST_ID]);
		const shown: string[] = [];
		await openSettingsAt(setting, MANIFEST_ID, { showPath: (p) => shown.push(p) }, "/shared-folders?id=abc");
		expect(state.activeTab).toBe(MANIFEST_ID);
		expect(shown).toEqual(["/shared-folders?id=abc"]);
	});

	it("also switches tabs when Settings is already open on another tab", async () => {
		const { setting, state } = fakeSettingsWindow([MANIFEST_ID]);
		await setting.open();
		state.activeTab = "appearance";
		await openSettingsAt(setting, MANIFEST_ID, { showPath: () => {} }, "/");
		expect(state.activeTab).toBe(MANIFEST_ID);
	});

	// Positive control for the fake: the defect's shape really leaves General up.
	it("a stale id leaves Settings on General (the 0.1.34 defect)", async () => {
		const { setting, state } = fakeSettingsWindow([MANIFEST_ID]);
		await openSettingsAt(setting, "team-relay", { showPath: () => {} }, "/");
		expect(MANIFEST_ID).not.toBe("team-relay");
		expect(state.activeTab).toBe("general");
	});
});

describe("SettingsPathRouter", () => {
	it("routes a mounted panel straight away", () => {
		const router = new SettingsPathRouter();
		const panel = recordingPanel();
		router.attach(panel);
		router.show("/shared-folders?id=abc");
		expect(panel.paths.at(-1)).toBe("/shared-folders?id=abc");
	});

	it("holds a path requested before the panel mounts and applies it on mount", () => {
		const router = new SettingsPathRouter();
		router.show("/shared-folders?id=abc");
		const panel = recordingPanel();
		router.attach(panel);
		expect(panel.paths).toEqual(["/shared-folders?id=abc"]);
	});

	it("does not send a path to a torn-down panel and does not replay it on a later plain open", () => {
		const router = new SettingsPathRouter();
		const old = recordingPanel();
		router.attach(old);
		router.detach();
		router.show("/shared-folders?id=abc");
		expect(old.paths).toEqual([]);
		const next = recordingPanel();
		router.attach(next);
		expect(next.paths).toEqual(["/shared-folders?id=abc"]);
		router.detach();
		const later = recordingPanel();
		router.attach(later);
		expect(later.paths).toEqual([]);
	});

	it("re-routes when asked again for the path the panel was opened on", () => {
		const router = new SettingsPathRouter();
		const panel = recordingPanel();
		router.attach(panel);
		router.show("/shared-folders?id=abc");
		router.show("/shared-folders?id=abc");
		// Each request resets then sets, so the panel's reactive path changes every time.
		expect(panel.paths).toEqual([undefined, "/shared-folders?id=abc", undefined, "/shared-folders?id=abc"]);
	});
});

describe("plugin id call sites in src/", () => {
	function codeOf(file: string): string {
		return fs
			.readFileSync(path.join(ROOT, "src", file), "utf8")
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join("\n");
	}

	function sourceFiles(dir: string): string[] {
		return fs.readdirSync(path.join(ROOT, "src", dir), { withFileTypes: true }).flatMap((e) => {
			const rel = path.join(dir, e.name);
			if (e.isDirectory()) return sourceFiles(rel);
			return /\.(ts|svelte)$/.test(e.name) ? [rel] : [];
		});
	}

	it("showSettingsTab opens the tab by this.manifest.id", () => {
		const main = codeOf("main.ts");
		const body = main.slice(main.indexOf("async showSettingsTab("), main.indexOf("installWebviewerPatch("));
		expect(body).toMatch(/openSettingsAt\([^;]*?\.setting,\s*this\.manifest\.id,/);
	});

	it("no tab/plugin lookup takes a literal id", () => {
		const offenders = sourceFiles(".").flatMap((file) =>
			codeOf(file)
				.split("\n")
				.filter((l) => /(openTabById|disablePlugin|enablePlugin|getPlugin)\(\s*["'`]/.test(l))
				.map((l) => `${file}: ${l.trim()}`),
		);
		expect(offenders).toEqual([]);
	});
});
