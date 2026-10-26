import * as fs from "fs";
import * as path from "path";

/**
 * Guards the web_folder_items storm fix: every "sync folder structure" push
 * must go through WebSyncManager.syncFolderStructureToWeb (or its scheduler),
 * which enforces the per-share minimum interval, backoff, single in-flight
 * PATCH and the unchanged-list skip. A caller that PATCHes the list directly
 * bypasses all of that — the share modal, share detail view and full-sync
 * paths each did until they were routed through WebSyncManager.
 *
 * Allowed outside WebSyncManager.ts: the fallback branches for when no
 * WebSyncManager exists (they sit after a `webSyncManager &&` branch) and the
 * publish toggle, which sends the list together with web_published before
 * the share is registered for auto-sync (`updatePayload.web_folder_items`).
 */
const SRC = path.join(__dirname, "..", "src");
const DIRECT_PUSH = /updateShare\([^)]*web_folder_items/;

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sourceFiles(full);
		return e.isFile() && /\.(ts|svelte)$/.test(e.name) ? [full] : [];
	});
}

/** Collapse each updateShare(...) call onto one line so multi-line calls match too. */
function flatten(source: string): string {
	return source.replace(/\s+/g, " ");
}

describe("web_folder_items pushes", () => {
	it("are not sent directly unless a webSyncManager branch comes first", () => {
		const offenders = sourceFiles(SRC)
			.filter((file) => !file.endsWith(`${path.sep}WebSyncManager.ts`))
			.flatMap((file) => {
				const flat = flatten(fs.readFileSync(file, "utf8"));
				const hits: string[] = [];
				let match: RegExpExecArray | null;
				const re = new RegExp(DIRECT_PUSH.source, "g");
				while ((match = re.exec(flat)) !== null) {
					// The nearest preceding branch must route through WebSyncManager.
					const before = flat.slice(Math.max(0, match.index - 1200), match.index);
					const routed = /webSyncManager\s*&&[^]*syncFolderStructureToWeb/.test(before)
						|| /if \(this\.webSyncManager\) \{ await this\.webSyncManager\.syncFolderStructureToWeb/.test(before);
					if (!routed) hits.push(`${path.relative(SRC, file)}: ${flat.slice(match.index, match.index + 80)}`);
				}
				return hits;
			});
		expect(offenders).toEqual([]);
	});
});
