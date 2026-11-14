/** @jest-environment node */
import path from "node:path";
import type { Component as SvelteComponentType } from "svelte";
import * as obsidian from "obsidian";

import { loadSvelteComponent } from "../scripts/test/svelteDOM.cjs";

// The real page, compiled with the production preprocessor and rendered in a
// DOM. Only the Obsidian host API is replaced; the share registry and vault
// are plain fixtures because the page only reads them while rendering.
let Component: SvelteComponentType<Record<string, unknown>>;
let mountComponent: typeof import("../src/svelteMount").mountComponent;
let component: ReturnType<typeof mountComponent> | undefined;
let doc: Document;
let closeDom: () => void;

beforeAll(async () => {
	const loaded = loadSvelteComponent(
		path.resolve(__dirname, "../src/components/SyncedFolderManager.svelte"),
		{
			obsidian: { ...obsidian, requireApiVersion: () => true },
			"../wording/uiText": await import("../src/wording/uiText"),
			"src/stuckUploads": await import("../src/stuckUploads"),
			"src/VaultShare": {},
		},
	);
	closeDom = () => loaded.dom.window.close();
	doc = loaded.dom.window.document;
	Component = loaded.default;
	mountComponent = loaded.mountComponent;
});
afterAll(() => closeDom?.());
afterEach(() => {
	component?.destroy();
	component = undefined;
	doc.body.innerHTML = "";
	(obsidian.getLanguage as jest.Mock).mockReturnValue("en");
});

function mount(language: string, opts: { folderMissing: boolean; stuck?: string[]; pending?: number }) {
	(obsidian.getLanguage as jest.Mock).mockReturnValue(language);
	const stuck = opts.stuck ?? [];
	const syncedFolder = {
		path: "Проекты/Общая",
		folderLabel: "Общая",
		folderMissing: opts.folderMissing,
		pendingUploadCount: () => opts.pending ?? stuck.length,
		stuckUploadPaths: () => stuck,
		retryPendingUploads: async () => undefined,
	};
	const live = {
		shareRegistry: {
			relinkTargets: () => ["Проекты/Другая"],
			relink: jest.fn(),
			delete: jest.fn(),
		},
		pluginVault: { getFolderByPath: () => null },
		app: { fileManager: { trashFile: jest.fn() }, vault: { createFolder: jest.fn() } },
	};
	component = mountComponent(Component, { target: doc.body, props: { live, syncedFolder } });
	// Markup line breaks are layout, not copy.
	return (doc.body.textContent ?? "").replace(/\s+/g, " ");
}

const ENGLISH_MISSING_PAGE = [
	"Folder not found",
	"Recreate folder",
	"Re-link to another folder",
	"Remove from this device",
	"Irreversible actions",
	"Delete metadata",
	"Delete from vault",
	"Move to trash",
	"Shared Folder",
];

describe("synced folder page in Russian", () => {
	test("missing folder: no English strings, Russian keys rendered", () => {
		const text = mount("ru", { folderMissing: true });
		for (const english of ENGLISH_MISSING_PAGE) expect(text).not.toContain(english);
		for (const russian of [
			"Папка не найдена",
			"Создать папку заново",
			"Создаёт папку Проекты/Общая заново",
			"Привязать другую папку",
			"Удалить с этого устройства",
			"Необратимые действия",
			"Удалить метаданные",
		]) {
			expect(text).toContain(russian);
		}
		expect([...doc.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual([
			"Создать заново",
			"Привязать",
			"Удалить",
			"Удалить метаданные",
		]);
	});

	test("ordinary share with files not uploaded: the whole page is Russian", () => {
		const text = mount("ru", { folderMissing: false, stuck: ["a.png", "b.png"], pending: 5 });
		// "Relay" is the product name and stays Latin; nothing else may.
		expect(text.replace(/Relay/g, "")).not.toMatch(/[A-Za-z]{3,}/);
		expect(text).toContain("Этот общий доступ не размещён на сервере Relay");
		expect(text).toContain("Файлы не загружены");
		expect(text).toContain("Файлов не загружено дольше 7 дней: 2");
		expect(text).toContain("Ещё файлов ждут загрузки: 3");
		expect(text).toContain("Удалить из хранилища");
		expect(text).toContain("Переместить в корзину");
	});

	test("ordinary share with only fresh pending files: Russian pending line", () => {
		const text = mount("ru", { folderMissing: false, pending: 4 });
		expect(text).toContain("Не загружено файлов: 4.");
		expect(text).not.toContain("not uploaded yet");
	});
});

describe("Delete from vault on a missing folder", () => {
	test("missing folder: no 'Delete from vault' row, 'Delete metadata' stays", () => {
		const text = mount("en", { folderMissing: true });
		expect(text).not.toContain("Move to trash");
		expect(text).not.toContain("Delete from vault");
		expect(text).toContain("Delete metadata");
	});

	test("folder present: 'Delete from vault' row is shown", () => {
		const text = mount("en", { folderMissing: false });
		expect(text).toContain("Delete from vault");
		expect(text).toContain("Move to trash");
		expect(text).toContain("Delete metadata");
	});
});

describe("English copy is unchanged", () => {
	test("pending and stuck counts keep their English plural forms", () => {
		expect(mount("en", { folderMissing: false, pending: 1 })).toContain(
			"1 file not uploaded yet. They stay on this device",
		);
		component?.destroy();
		expect(mount("en", { folderMissing: false, stuck: ["a.png"], pending: 3 })).toMatch(
			/1 file not uploaded for more than 7 days[\s\S]*2 more files waiting to upload/,
		);
	});
});
