import * as Y from "yjs";
import { FolderIndex } from "../src/FolderIndex";
import {
	ItemKind,
	isDocumentRecord,
	isFolderRecord,
	makeDocumentRecord,
	makeFileRecord,
	makeFolderRecord,
} from "../src/ItemKinds";

import {
	SettingsScope,
	Settings,
	type PluginDataFile,
} from "../src/SettingsPersistence";
import { describe, jest, beforeEach, test, expect } from "@jest/globals";
import { AttachmentSyncSettings, type AttachmentToggles } from "../src/AttachmentSyncSettings";

jest.mock("../src/Document", () => ({
	Document: class {},
}));

jest.mock("../src/TrackedFolder", () => ({
	TrackedFolder: class {},
}));

jest.mock("../src/logging", () => ({
	Loggable: class MockLoggable {
		debug = console.debug;
		log = console.log;
		warn = console.warn;
		error = console.error;
	},
	instanceLabels: new WeakMap(),
}));

class TestStorageAdapter implements PluginDataFile<any> {
	private data: any = null;

	async loadData() {
		return this.data;
	}

	async saveData(data: any) {
		this.data = data;
	}
}

interface TestSettings {
	sync: AttachmentToggles;
}

const internal = (store: FolderIndex) => store as any;

describe("FolderIndex", () => {
	let ydoc: Y.Doc;
	let store: FolderIndex;
	let storage: TestStorageAdapter;
	let settings: Settings<TestSettings>;
	let syncSettings: SettingsScope<AttachmentToggles>;
	let syncSettingsManager: AttachmentSyncSettings;

	beforeEach(async () => {
		ydoc = new Y.Doc();
		storage = new TestStorageAdapter();
		settings = new Settings(storage, {});
		syncSettings = new SettingsScope(settings, "sync");
		syncSettingsManager = syncSettings.childScope<
			Record<keyof AttachmentToggles, boolean>,
			AttachmentSyncSettings
		>("sync", (settings, path) => new AttachmentSyncSettings(settings, path));

		await settings.hydrate();
		store = new FolderIndex(
			ydoc,
			"/test",
			new Map<string, string>(),
			syncSettingsManager,
		);
	});

	describe("Old client operations", () => {
		test("creates document in root folder", () => {
			const guid = "doc-123";
			const path = "test.md";

			store.upgradeEntry(guid, path);

			// Check overlay
			const overlayMeta = internal(store).stagedWrites.get(path);
			expect(overlayMeta).toBeDefined();
			expect(overlayMeta?.id).toBe(guid);
			expect(overlayMeta?.type).toBe("markdown");

			// Before commit, shouldn't be in main storage
			expect(internal(store).records.has(path)).toBeFalsy();

			// After commit, should be in main storage
			store.applyStaged();
			expect(internal(store).records.get(path)?.id).toBe(guid);
			expect(internal(store).records.get(path)?.type).toBe("markdown");
		});

		test("creates document in nested folder", () => {
			const guid = "doc-456";
			const path = "folder1/folder2/test.md";

			store.upgradeEntry(guid, path);

			// Check that folders were created in overlay
			expect(internal(store).stagedWrites.get("folder1")?.type).toBe("folder");
			expect(internal(store).stagedWrites.get("folder1/folder2")?.type).toBe(
				"folder",
			);
			expect(internal(store).stagedWrites.get(path)?.type).toBe("markdown");

			// After commit, folders and document should exist
			store.applyStaged();
			expect(isFolderRecord(store.recordFor("folder1"))).toBeTruthy();
			expect(isFolderRecord(store.recordFor("folder1/folder2"))).toBeTruthy();
			expect(isDocumentRecord(store.recordFor(path))).toBeTruthy();
		});

		test("migrates legacy documents", async () => {
			// Setup legacy data
			internal(store).flatIdMap.set("old1.md", "guid1");
			internal(store).flatIdMap.set("folder/old2.md", "guid2");

			store.upgradeLegacy();

			// Check that documents were migrated
			expect(isDocumentRecord(store.recordFor("old1.md")));
			expect(isDocumentRecord(store.recordFor("folder/old2.md"))).toBeTruthy();
			expect(isFolderRecord(store.recordFor("folder"))).toBeTruthy();
		});

		// Regression: an inbound-synced entry can carry a full path (namespace
		// included) instead of a virtual path, which makes requireVirtualPath throw.
		// It used to throw out of the flatIdMap.forEach and abort the whole
		// migration — inside a Y.Doc transact, so it surfaced as an uncaught
		// "Expected virtual path" and wedged the plugin (dead UI, e.g. the
		// per-share "+ Create key" button no longer responding).
		test("one invalid legacy vpath does not abort the migration", () => {
			const badVPath = "/test/Entire VC/Spark/docs/reports/funnel.md";

			internal(store).flatIdMap.set("good1.md", "guid1");
			internal(store).flatIdMap.set(badVPath, "guid-bad");
			internal(store).flatIdMap.set("folder/good2.md", "guid2");

			expect(() => store.upgradeLegacy()).not.toThrow();
			store.applyStaged();

			// The bad entry is skipped, not migrated. Asserted on meta/overlay
			// rather than tracks(), which also reports the planted flatIdMap entry.
			expect(internal(store).records.has(badVPath)).toBeFalsy();
			expect(internal(store).stagedWrites.has(badVPath)).toBeFalsy();

			// ...and every other entry still migrated, whichever order the
			// flatIdMap map happened to iterate in.
			expect(isDocumentRecord(store.recordFor("good1.md"))).toBeTruthy();
			expect(isDocumentRecord(store.recordFor("folder/good2.md"))).toBeTruthy();
			expect(isFolderRecord(store.recordFor("folder"))).toBeTruthy();
		});

		test("an invalid legacy vpath does not throw out of a transact", () => {
			// The wedge shape from the field report: upgradeLegacy runs from the
			// flatIdMap observer, so a throw escapes Y.Doc.transact uncaught
			// rather than failing a single file.
			store.observe();

			expect(() => {
				ydoc.transact(() => {
					internal(store).flatIdMap.set(
						"/test/Entire VC/Spark/docs/reports/funnel.md",
						"guid-bad",
					);
				});
			}).not.toThrow();
		});

		test("legacy client folder rename updates paths for all file types", () => {
			// Set up initial state with both legacy docs and new files
			// Legacy client only knows about markdown files
			internal(store).flatIdMap.set("old_folder/document.md", "doc-guid");

			// New client knows about all files including images
			store.upgradeLegacy();
			store.applyStaged();

			// Add some non-markdown files that legacy client doesn't track
			store.put(
				"old_folder/image.png",
				makeFileRecord(ItemKind.Image, "img-guid", "image/png", "asdf-hash"),
			);
			store.put(
				"old_folder/data.pdf",
				makeFileRecord(ItemKind.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
			);

			// Simulate legacy client renaming the folder
			// They only update the path for the markdown file they know about
			internal(store).flatIdMap.delete("old_folder/document.md");
			internal(store).flatIdMap.set("new_folder/document.md", "doc-guid");

			// Run migration to update folder structure
			store.upgradeLegacy();
			store.applyStaged();
			store.clearAliases();

			// Verify folder was renamed
			expect(store.tracks("old_folder")).toBeFalsy();
			expect(isFolderRecord(store.recordFor("new_folder"))).toBeTruthy();

			// Verify markdown file moved correctly
			expect(store.tracks("old_folder/document.md")).toBeFalsy();
			expect(
				isDocumentRecord(store.recordFor("new_folder/document.md")),
			).toBeTruthy();
			expect(store.recordFor("new_folder/document.md")?.id).toBe("doc-guid");

			// Verify other files were also moved
			expect(store.tracks("old_folder/image.png")).toBeFalsy();
			expect(store.tracks("old_folder/data.pdf")).toBeFalsy();

			expect(store.recordFor("new_folder/image.png")?.id).toBe("img-guid");
			expect(store.recordFor("new_folder/data.pdf")?.id).toBe("pdf-guid");
		});

		test("knownGuids remains consistent during folder moves", () => {
			// Set up initial state
			internal(store).flatIdMap.set("old_folder/document.md", "doc-guid");

			store.upgradeLegacy();
			store.applyStaged();

			// Add some non-markdown files
			store.put(
				"old_folder/image.png",
				makeFileRecord(ItemKind.Image, "img-guid", "image/png", "asdf-hash"),
			);
			store.put(
				"old_folder/data.pdf",
				makeFileRecord(ItemKind.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
			);

			// Capture initial set of knownGuids
			const initialIds = Array.from(store.knownGuids);

			// Simulate legacy client renaming the folder
			internal(store).flatIdMap.delete("old_folder/document.md");
			internal(store).flatIdMap.set("new_folder/document.md", "doc-guid");

			store.upgradeLegacy();
			store.applyStaged();

			// Capture final set of knownGuids
			const finalIds = Array.from(store.knownGuids);

			// IDs should be the same before and after move
			expect(finalIds).toHaveLength(initialIds.length);
			expect(new Set(finalIds)).toEqual(new Set(initialIds));

			// Verify each specific ID is still present
			expect(finalIds).toContain("doc-guid");
			expect(finalIds).toContain("img-guid");
			expect(finalIds).toContain("pdf-guid");
		});
	});

	test("new client folder moves preserve all file metadata", () => {
		// Set up initial folder structure using only new client operations
		store.put("old_folder", makeFolderRecord("folder-guid"));
		store.put("old_folder/doc.md", makeDocumentRecord("doc-guid"));
		store.put(
			"old_folder/image.png",
			makeFileRecord(ItemKind.Image, "img-guid", "image/png", "asdf-hash"),
		);
		store.put(
			"old_folder/data.pdf",
			makeFileRecord(ItemKind.PDF, "pdf-guid", "application/pdf", "asdf-hash2"),
		);

		// Perform folder move using new client move operation
		store.repath("old_folder", "new_folder");
		store.clearAliases();

		// Verify folder was moved
		expect(store.tracks("old_folder")).toBeFalsy();
		expect(store.tracks("new_folder")).toBeTruthy();
		expect(store.recordFor("new_folder")?.id).toBe("folder-guid");

		// Verify all files were moved and maintain their IDs
		expect(store.recordFor("new_folder/doc.md")?.id).toBe("doc-guid");
		expect(store.recordFor("new_folder/image.png")?.id).toBe("img-guid");
		expect(store.recordFor("new_folder/data.pdf")?.id).toBe("pdf-guid");

		// Verify old paths don't exist
		expect(store.tracks("old_folder/doc.md")).toBeFalsy();
		expect(store.tracks("old_folder/image.png")).toBeFalsy();
		expect(store.tracks("old_folder/data.pdf")).toBeFalsy();
	});

	test("detects folder rename from parallel create/delete operations", () => {
		// Initial setup - folder with multiple files
		store.put("wub", makeFolderRecord("folder-guid"));
		store.put("wub/rename.md", makeDocumentRecord("doc-guid"));
		store.put(
			"wub/frogadog 1.png",
			makeFileRecord(ItemKind.Image, "img1-guid", "image/png", "asdf-hash"),
		);
		store.put(
			"wub/Pasted image 20241031171351.png",
			makeFileRecord(ItemKind.Image, "img2-guid", "image/png", "asdf-hash2"),
		);

		// Capture initial IDs
		const initialIds = Array.from(store.knownGuids);

		// Simulate parallel create/delete operations
		store.put("sub", makeFolderRecord("folder-guid")); // Same folder ID
		store.put("sub/rename.md", store.recordFor("wub/rename.md")!);
		store.put("sub/frogadog 1.png", store.recordFor("wub/frogadog 1.png")!);
		store.put(
			"sub/Pasted image 20241031171351.png",
			store.recordFor("wub/Pasted image 20241031171351.png")!,
		);

		store.delete("wub/frogadog 1.png");
		store.delete("wub/Pasted image 20241031171351.png");
		store.delete("wub/rename.md");
		store.delete("wub");

		// Verify IDs are preserved
		const finalIds = Array.from(store.knownGuids);
		expect(new Set(finalIds)).toEqual(new Set(initialIds));

		// Verify all files exist at new location with same IDs
		expect(store.recordFor("sub")?.id).toBe("folder-guid");
		expect(store.recordFor("sub/rename.md")?.id).toBe("doc-guid");
		expect(store.recordFor("sub/frogadog 1.png")?.id).toBe("img1-guid");
		expect(store.recordFor("sub/Pasted image 20241031171351.png")?.id).toBe(
			"img2-guid",
		);

		// Verify old locations are gone
		expect(store.tracks("wub")).toBeFalsy();
		expect(store.tracks("wub/rename.md")).toBeFalsy();
		expect(store.tracks("wub/frogadog 1.png")).toBeFalsy();
		expect(store.tracks("wub/Pasted image 20241031171351.png")).toBeFalsy();
	});

	test("legacy client folder rename generates only renames", () => {
		// Setup initial state
		store.put("grub", makeFolderRecord("folder-guid"));
		store.put("grub/nested", makeFolderRecord("nested-guid"));
		store.put("grub/rename.md", makeDocumentRecord("doc-guid"));
		store.put(
			"grub/Pasted image 20241031171351.png",
			makeFileRecord(ItemKind.Image, "img1-guid", "image/png", "asdf-hash"),
		);
		store.put(
			"grub/nested/frogadog 1.png",
			makeFileRecord(ItemKind.Image, "img2-guid", "image/png", "asdf-hash2"),
		);

		// Simulate legacy client renaming folder
		internal(store).flatIdMap.delete("grub/rename.md");
		internal(store).flatIdMap.set("bub/rename.md", "doc-guid");

		store.upgradeLegacy();
		store.applyStaged();
		store.clearAliases();

		// Verify everything moved (no recreates)
		expect(store.recordFor("bub")?.id).toBe("folder-guid");
		expect(store.recordFor("bub/rename.md")?.id).toBe("doc-guid");
		expect(store.recordFor("bub/Pasted image 20241031171351.png")?.id).toBe(
			"img1-guid",
		);
		expect(store.recordFor("bub/nested/frogadog 1.png")?.id).toBe("img2-guid");

		// Old paths should be gone
		expect(store.tracks("grub")).toBeFalsy();
		expect(store.tracks("grub/nested")).toBeFalsy();
		expect(store.tracks("grub/rename.md")).toBeFalsy();
		expect(store.tracks("grub/Pasted image 20241031171351.png")).toBeFalsy();
		expect(store.tracks("grub/nested/frogadog 1.png")).toBeFalsy();
	});

	describe("New client operations", () => {
		test("sync folder operations don't affect legacy data", () => {
			// Setup legacy document
			internal(store).flatIdMap.set("old.md", "legacy-guid");

			// New client creates a folder
			store.put("new-folder", makeFolderRecord("folder-guid"));

			// Legacy data should remain unchanged
			expect(internal(store).flatIdMap.get("old.md")).toBe("legacy-guid");
			expect(store.recordFor("old.md")).toBeDefined();
		});

		test("sync file operations don't affect legacy data", () => {
			// Setup legacy document
			internal(store).flatIdMap.set("old.md", "legacy-guid");

			// New client creates a file
			store.put(
				"new-file.pdf",
				makeFileRecord(
					ItemKind.PDF,
					"file-guid",
					"application/pdf",
					"asdf-hash1",
				),
			);

			// Legacy data should remain unchanged
			expect(internal(store).flatIdMap.get("old.md")).toBe("legacy-guid");
			expect(store.recordFor("old.md")).toBeDefined();
		});
	});

	describe("Basic CRUD operations", () => {
		test("creates new markdown document", () => {
			const path = "test.md";
			store.new(path);
			expect(store.tracks(path)).toBeTruthy();
		});

		test("creates new binary file", () => {
			const path = "test.pdf";
			store.new(path);
			expect(store.tracks(path)).toBeTruthy();
		});

		test("clearPendingUpload discards a locally-minted guid without touching meta", () => {
			const path = "test.md";
			const localGuid = store.new(path);
			expect(internal(store).mintedGuids.get(path)).toBe(localGuid);

			store.clearPendingUpload(path);

			expect(internal(store).mintedGuids.has(path)).toBeFalsy();
			expect(store.tracks(path)).toBeFalsy();
		});

		test("clearPendingUpload does not remove an already-published meta entry for the same path", () => {
			const path = "test.md";
			const winnerGuid = "winner-guid";
			store.recordUpload(path, makeDocumentRecord(winnerGuid));

			// A stray local pendingUpload write for the same path (e.g. this
			// client lost an upload-claim race but still called new() before
			// realizing it) must not disturb the already-published meta entry.
			internal(store).mintedGuids.set(path, "loser-guid");
			store.clearPendingUpload(path);

			expect(store.tracks(path)).toBeTruthy();
			expect(store.guidFor(path)).toBe(winnerGuid);
		});

		test("creates new folder", () => {
			const path = "folder1";
			store.new(path);
			store.recordUpload(path, makeFolderRecord(path));

			expect(isFolderRecord(store.recordFor(path))).toBeTruthy();
			expect(store.tracks(path)).toBeTruthy();
		});

		test("moves files correctly", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const guid = store.new(oldPath);
			store.recordUpload(oldPath, makeFolderRecord(guid));

			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(store.tracks(oldPath)).toBeFalsy();
			expect(store.tracks(newPath)).toBeTruthy();
		});

		test("deletes files correctly", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.recordUpload(path, makeFolderRecord(guid));

			store.delete(path);

			expect(store.tracks(path)).toBeFalsy();
			expect(store.recordFor(path)).toBeUndefined();
		});
	});

	describe("Delete Set functionality", () => {
		test("stagedDeletes prevents access to marked paths", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.recordUpload(path, makeDocumentRecord(guid));

			internal(store).stagedDeletes.add(path);

			expect(store.tracks(path)).toBeFalsy();
			expect(store.recordFor(path)).toBeUndefined();
		});

		test("applyStaged clears stagedDeletes", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.recordUpload(path, makeDocumentRecord(guid));
			internal(store).stagedDeletes.add(path);

			store.applyStaged();

			expect(internal(store).stagedDeletes.size).toBe(0);
		});
	});

	describe("Remote ID handling", () => {
		test("knownGuids returns correct set of IDs", () => {
			console.warn(store.knownGuids);
			const guid1 = store.new("test1.md");
			store.recordUpload("test1.md", makeDocumentRecord(guid1));

			const guid2 = store.new("test2.md");
			store.recordUpload("test2.md", makeDocumentRecord(guid2));

			const guid3 = store.new("folder");
			store.recordUpload("folder", makeFolderRecord(guid3));

			const knownGuids = store.knownGuids;

			console.warn(knownGuids);
			expect(knownGuids.size).toBe(3);
			expect(knownGuids.has(guid1)).toBeTruthy();
			expect(knownGuids.has(guid2)).toBeTruthy();
			expect(knownGuids.has(guid3)).toBeTruthy();
		});

		test("knownGuids excludes deleted items", () => {
			const guid1 = store.new("test1.md");
			store.recordUpload("test1.md", makeDocumentRecord(guid1));

			const guid2 = store.new("test2.md");
			store.recordUpload("test2.md", makeDocumentRecord(guid2));

			store.delete("test2.md");

			const knownGuids = store.knownGuids;
			expect(knownGuids.size).toBe(1);
			expect(knownGuids.has(guid1)).toBeTruthy();
			expect(knownGuids.has(guid2)).toBeFalsy();
		});
	});

	describe("Path handling", () => {
		test("handles paths with special characters", () => {
			const path = "folder/test with spaces.md";
			const guid = store.new(path);
			const meta = makeDocumentRecord(guid);
			store.recordUpload(path, meta);

			expect(store.tracks(path)).toBeTruthy();
			expect(store.guidFor(path)).toEqual(guid);
			expect(store.recordFor(path)).toEqual(meta);
		});
	});
	describe("Metadata cleanup", () => {
		test("delete removes metadata entry", () => {
			const path = "test.md";
			const guid = store.new(path);
			store.recordUpload(path, makeDocumentRecord(guid));

			expect(store.recordFor(path)).toBeDefined();
			store.delete(path);
			expect(store.recordFor(path)).toBeUndefined();
		});

		test("move operation preserves metadata for new path only", () => {
			const oldPath = "test.md";
			const newPath = "folder/test.md";
			const guid = store.new(oldPath);
			const meta = makeDocumentRecord(guid);
			store.recordUpload(oldPath, meta);

			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(store.recordFor(oldPath)).toBeUndefined();
			expect(store.recordFor(newPath)).toEqual(meta);
		});

		test("new operations replace old metadata completely", () => {
			const path = "test.md";
			const guid1 = store.new(path);
			store.recordUpload(path, makeDocumentRecord(guid1));

			const guid2 = store.new(path);
			const meta2 = makeDocumentRecord(guid2);
			store.recordUpload(path, meta2);

			expect(store.recordFor(path)).toEqual(meta2);
		});

		test("metadata entries are consistent", () => {
			const guid1 = store.new("test1.md");
			store.recordUpload("test1.md", makeDocumentRecord(guid1));

			const guid2 = store.new("test2.md");
			store.recordUpload("test2.md", makeDocumentRecord(guid2));

			const folderGuid = store.new("folder");
			store.recordUpload("folder", makeFolderRecord(folderGuid));

			const guid3 = store.new("folder/test3.md");
			store.recordUpload("folder/test3.md", makeDocumentRecord(guid3));

			store.delete("test2.md");

			const expectedPaths = ["test1.md", "folder", "folder/test3.md"];

			expectedPaths.forEach((path) => {
				expect(store.recordFor(path)).toBeDefined();
			});

			let count = 0;
			store.eachRecord(() => count++);
			expect(count).toBe(3);
		});
		describe("Legacy file tree operations", () => {
			test("maintains parent folders when migrating nested documents", () => {
				// Setup legacy data - simulating nested files without folder entries
				internal(store).flatIdMap.set("folder/subfolder/doc1.md", "guid1");
				internal(store).flatIdMap.set("folder/subfolder/doc2.md", "guid2");

				// Trigger migration
				store.upgradeLegacy();
				store.applyStaged();

				// Verify all folders exist in metadata
				expect(isFolderRecord(store.recordFor("folder"))).toBeTruthy();
				expect(
					isFolderRecord(store.recordFor("folder/subfolder")),
				).toBeTruthy();

				// And documents exist
				expect(
					isDocumentRecord(store.recordFor("folder/subfolder/doc1.md")),
				).toBeTruthy();
				expect(
					isDocumentRecord(store.recordFor("folder/subfolder/doc2.md")),
				).toBeTruthy();
			});

			test("retains parent folders during partial tree operations", () => {
				// Setup initial tree
				internal(store).flatIdMap.set("folder/subfolder/doc1.md", "guid1");
				internal(store).flatIdMap.set("folder/subfolder/doc2.md", "guid2");

				store.upgradeLegacy();
				store.applyStaged();

				// Add new document through legacy path
				internal(store).flatIdMap.set("folder/subfolder/doc3.md", "guid3");

				store.upgradeLegacy();
				store.applyStaged();

				// Verify folder structure remains intact
				expect(isFolderRecord(store.recordFor("folder"))).toBeTruthy();
				expect(
					isFolderRecord(store.recordFor("folder/subfolder")),
				).toBeTruthy();

				// And all documents exist
				expect(
					isDocumentRecord(store.recordFor("folder/subfolder/doc1.md")),
				).toBeTruthy();
				expect(
					isDocumentRecord(store.recordFor("folder/subfolder/doc2.md")),
				).toBeTruthy();
				expect(
					isDocumentRecord(store.recordFor("folder/subfolder/doc3.md")),
				).toBeTruthy();
			});

			test("forEach returns all entries including folders", () => {
				// Setup legacy data with nested structure
				internal(store).flatIdMap.set("folder1/subfolder/doc1.md", "guid1");
				internal(store).flatIdMap.set("folder1/subfolder/doc2.md", "guid2");

				store.upgradeLegacy();
				store.applyStaged();

				// Collect all paths returned by forEach
				const paths: string[] = [];
				store.eachRecord((meta, path) => {
					paths.push(path);
				});

				// Should include both files and folders
				expect(paths).toContain("folder1");
				expect(paths).toContain("folder1/subfolder");
				expect(paths).toContain("folder1/subfolder/doc1.md");
				expect(paths).toContain("folder1/subfolder/doc2.md");
				expect(paths.length).toBe(4);
			});
			test("maintains folder entries for existing files", () => {
				// Simulate legacy client creating files without folder entries
				internal(store).flatIdMap.set("Untitled 4/new note 3.md", "guid1");
				internal(store).flatIdMap.set("Untitled 4/Untitled 4.md", "guid2");

				store.upgradeLegacy();
				store.applyStaged();

				// Verify folder exists in metadata after migration
				expect(isFolderRecord(store.recordFor("Untitled 4"))).toBeTruthy();

				// And files exist
				expect(
					isDocumentRecord(store.recordFor("Untitled 4/new note 3.md")),
				).toBeTruthy();
				expect(
					isDocumentRecord(store.recordFor("Untitled 4/Untitled 4.md")),
				).toBeTruthy();
			});
		});
	});

	describe("move operations", () => {
		test("basic move operation", () => {
			const oldPath = "test.md";
			const newPath = "renamed.md";
			const guid = store.new(oldPath);
			store.recordUpload(oldPath, makeDocumentRecord(guid));

			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(store.tracks(oldPath)).toBeFalsy();
			expect(store.tracks(newPath)).toBeTruthy();
			expect(store.guidFor(newPath)).toBe(guid);
		});

		test("move handles pending uploads", () => {
			const oldPath = "upload.md";
			const newPath = "new-upload.md";
			const guid = store.new(oldPath); // This puts it in pendingUpload

			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(internal(store).mintedGuids.has(oldPath)).toBeFalsy();
			expect(internal(store).mintedGuids.get(newPath)).toBe(guid);
		});

		test("move preserves metadata in overlay", () => {
			const oldPath = "doc.md";
			const newPath = "new-doc.md";
			const meta = makeDocumentRecord("test-guid");

			internal(store).stagedWrites.set(oldPath, meta);
			internal(store).flatIdMap.set(oldPath, "test-guid");
			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(internal(store).stagedWrites.get(newPath)).toEqual(meta);
			expect(internal(store).stagedWrites.has(oldPath)).toBeFalsy();
		});

		test("repath updates stagedDeletes entries", () => {
			const oldPath = "delete-me.md";
			const newPath = "also-delete-me.md";

			internal(store).stagedDeletes.add(oldPath);
			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(internal(store).stagedDeletes.has(oldPath)).toBeFalsy();
			expect(internal(store).stagedDeletes.has(newPath)).toBeTruthy();
		});

		test("move handles folder paths", () => {
			const oldPath = "folder/doc.md";
			const newPath = "new-folder/doc.md";
			const guid = store.new(oldPath);
			store.recordUpload(oldPath, makeDocumentRecord(guid));

			store.repath(oldPath, newPath);
			store.clearAliases();

			expect(store.tracks(oldPath)).toBeFalsy();
			expect(store.tracks(newPath)).toBeTruthy();
			expect(store.guidFor(newPath)).toBe(guid);
		});

		test("move handles fs delays", () => {
			const oldPath = "folder/doc.md";
			const newPath = "new-folder/doc.md";
			const guid = store.new(oldPath);
			store.recordUpload(oldPath, makeDocumentRecord(guid));

			store.repath(oldPath, newPath);

			expect(store.tracks(oldPath)).toBeTruthy();
			expect(store.tracks(newPath)).toBeTruthy();
			expect(store.guidFor(newPath)).toBe(guid);

			store.clearAlias(oldPath);

			expect(store.tracks(oldPath)).toBeFalsy();
		});
	});
});
