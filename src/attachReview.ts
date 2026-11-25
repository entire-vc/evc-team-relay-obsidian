/**
 * The check before a local folder is attached to a shared folder that
 * already exists on the server (GH #114).
 *
 * Before this, the first sync of such a folder let every differing local
 * note replace the shared note for everyone: the server text survived only
 * as a "(relay conflict ...)" copy on the device that connected. Now the
 * folder is held until the user chooses:
 *
 *   - keep both (default): the shared note keeps the server text, the local
 *     text is kept as a local copy next to it;
 *   - keep server: the server text is written to disk, the local text goes
 *     to the backup folder;
 *   - keep local: the local text becomes the shared note for everyone, the
 *     server text goes to the backup folder (needs write access);
 *   - cancel: the folder is not connected.
 *
 * Kept free of Obsidian imports: VaultShare supplies the entries and the
 * write ports, the UI supplies the decision. The overwritten side is always
 * saved first; a file whose copy could not be written is left as it is on
 * both sides (fail closed).
 */

export type AttachChoice = "keep-both" | "keep-server" | "keep-local";

/** How the attach started: a click in the UI, or the startup auto-connect. */
export type AttachEntryPoint = "manual" | "auto";

/** Documents compared with the server at once. */
export const ATTACH_REVIEW_CONCURRENCY = 4;
/** Paths listed by name in the dialog before "+K more". */
export const ATTACH_REVIEW_MAX_PATHS = 10;
/** Vault-root folder that receives the overwritten versions. */
export const ATTACH_BACKUP_ROOT = "Team Relay backups";

/**
 * Is `vaultPath` (vault-relative, not share-relative) inside the backup
 * folder? Backups are local files: syncing them would hand every participant
 * one device's private copies. Checked wherever recovery copies are
 * (isConflictCopyPath), so a share of the vault root skips them too.
 */
export function isAttachBackupPath(vaultPath: string): boolean {
	return vaultPath === ATTACH_BACKUP_ROOT || vaultPath.startsWith(`${ATTACH_BACKUP_ROOT}/`);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** `Team Relay backups/<folder> <YYYY-MM-DD HH-mm>` in local time. */
export function attachBackupFolder(folderName: string, now: Date): string {
	const stamp =
		`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
		`${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
	const name = folderName.replace(/[\\/]/g, " ").trim() || "Vault";
	return `${ATTACH_BACKUP_ROOT}/${name} ${stamp}`;
}

/** Label of the local copy keep both writes next to a note; isConflictCopyPath matches it. */
export function keepBothCopyLabel(now: Date): string {
	return `relay conflict local ${now.toISOString().replace(/[:.]/g, "-")}`;
}

/** One note that exists both on disk and on the server. */
export interface AttachEntry {
	readonly vpath: string;
	/** The file on disk now; null when it could not be read (never "": that is an empty note). */
	readLocal(): Promise<string | null>;
	/** The relay's text now; null when it could not be read (offline, timeout). */
	readServer(): Promise<string | null>;
	/** Same content? Line endings never count as a difference. */
	same(local: string, server: string): boolean;
}

export interface AttachDifference {
	entry: AttachEntry;
	local: string;
	server: string;
}

export interface CompareOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
	isCancelled?: () => boolean;
	/** Called for every note whose two sides already agree. */
	onAgreed?: (entry: AttachEntry, text: string) => Promise<void>;
}

export interface CompareOutcome {
	differing: AttachDifference[];
	agreed: AttachEntry[];
	/** One side could not be read (disk or relay): the folder stays held. */
	unreadable: AttachEntry[];
	cancelled: boolean;
}

/** Runs `fn` over `items`, at most `limit` at a time, in input order of start. */
export async function forEachLimited<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
	isCancelled: () => boolean = () => false,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length && !isCancelled()) {
			const item = items[next++];
			await fn(item);
		}
	};
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
	await Promise.all(workers);
}

/**
 * Reads both sides of every entry and sorts them. Writes nothing to disk
 * and nothing to the shared note.
 */
export async function compareWithServer(
	entries: readonly AttachEntry[],
	options: CompareOptions = {},
): Promise<CompareOutcome> {
	const outcome: CompareOutcome = {
		differing: [],
		agreed: [],
		unreadable: [],
		cancelled: false,
	};
	const isCancelled = options.isCancelled ?? (() => false);
	let done = 0;
	options.onProgress?.(0, entries.length);
	await forEachLimited(
		entries,
		options.concurrency ?? ATTACH_REVIEW_CONCURRENCY,
		async (entry) => {
			const [local, server] = await Promise.all([entry.readLocal(), entry.readServer()]);
			if (isCancelled()) return;
			if (local === null || server === null) {
				outcome.unreadable.push(entry);
			} else if (entry.same(local, server)) {
				await options.onAgreed?.(entry, server);
				outcome.agreed.push(entry);
			} else {
				outcome.differing.push({ entry, local, server });
			}
			done++;
			options.onProgress?.(done, entries.length);
		},
		isCancelled,
	);
	outcome.cancelled = isCancelled();
	const byPath = (a: { vpath: string }, b: { vpath: string }) => a.vpath.localeCompare(b.vpath);
	outcome.differing.sort((a, b) => byPath(a.entry, b.entry));
	return outcome;
}

/** What the dialog shows. */
export interface AttachReviewModel {
	folderName: string;
	count: number;
	/** The first ATTACH_REVIEW_MAX_PATHS paths. */
	paths: string[];
	/** How many more paths are not listed ("+K more"). */
	more: number;
	/** Keep local needs write access to the shared folder. */
	canKeepLocal: boolean;
	/** Where keep server / keep local put the overwritten side. */
	backupFolder: string;
}

export function buildAttachReviewModel(
	folderName: string,
	differing: readonly AttachDifference[],
	canWrite: boolean,
	backupFolder: string,
	maxPaths: number = ATTACH_REVIEW_MAX_PATHS,
): AttachReviewModel {
	const all = differing.map((d) => d.entry.vpath);
	const paths = all.slice(0, maxPaths);
	return {
		folderName,
		count: all.length,
		paths,
		more: all.length - paths.length,
		canKeepLocal: canWrite,
		backupFolder,
	};
}

/** Writes the chosen outcome. Every method may throw; a throw leaves that file unresolved. */
export interface AttachApplyPorts {
	/** Overwrites the file on disk. */
	writeDisk(entry: AttachEntry, text: string): Promise<void>;
	/** Writes a local copy next to the note; returns its share-relative path. */
	writeLocalCopy(entry: AttachEntry, text: string): Promise<string>;
	/** Writes `text` to the backup folder under the note's relative path; returns the path. */
	writeBackup(entry: AttachEntry, text: string): Promise<string>;
	/**
	 * Makes `local` the shared note's text. Must hand the relay's current
	 * text to `preserve` before overwriting it and skip the overwrite when
	 * `preserve` throws. Returns whether the shared note was rewritten.
	 */
	replaceServer(
		entry: AttachEntry,
		local: string,
		preserve: (serverText: string) => Promise<void>,
	): Promise<boolean>;
	/** Records that disk and server agree on `text` (sync base, server ack). */
	markAgreed(entry: AttachEntry, text: string): Promise<void>;
}

export interface ApplyOutcome {
	choice: AttachChoice;
	/** Notes settled by the choice (or found equal at apply time). */
	resolved: string[];
	/** Notes left untouched because their copy could not be saved, or the server could not be read. */
	unresolved: string[];
	/** Local copies keep both wrote next to the notes. */
	copies: string[];
	/** Backups keep server / keep local wrote. */
	backups: string[];
}

/**
 * Applies one choice to every differing note, against the text the relay
 * and the disk hold now (a participant may have edited meanwhile).
 */
export async function applyAttachChoice(
	choice: AttachChoice,
	differing: readonly AttachDifference[],
	ports: AttachApplyPorts,
	concurrency: number = ATTACH_REVIEW_CONCURRENCY,
): Promise<ApplyOutcome> {
	const outcome: ApplyOutcome = { choice, resolved: [], unresolved: [], copies: [], backups: [] };
	await forEachLimited(differing, concurrency, async ({ entry }) => {
		const settled = await applyOne(choice, entry, ports, outcome).catch(() => false);
		(settled ? outcome.resolved : outcome.unresolved).push(entry.vpath);
	});
	outcome.resolved.sort();
	outcome.unresolved.sort();
	outcome.copies.sort();
	outcome.backups.sort();
	return outcome;
}

async function applyOne(
	choice: AttachChoice,
	entry: AttachEntry,
	ports: AttachApplyPorts,
	outcome: ApplyOutcome,
): Promise<boolean> {
	const [local, server] = await Promise.all([entry.readLocal(), entry.readServer()]);
	// Either side unreadable: nothing is applied, the note stays as it is.
	if (local === null || server === null) return false;
	if (entry.same(local, server)) {
		await ports.markAgreed(entry, server);
		return true;
	}
	switch (choice) {
		case "keep-both": {
			// The copy first: if it cannot be written, the file is not touched.
			const copy = await ports.writeLocalCopy(entry, local);
			outcome.copies.push(copy);
			await ports.writeDisk(entry, server);
			await ports.markAgreed(entry, server);
			return true;
		}
		case "keep-server": {
			const backup = await ports.writeBackup(entry, local);
			outcome.backups.push(backup);
			await ports.writeDisk(entry, server);
			await ports.markAgreed(entry, server);
			return true;
		}
		case "keep-local": {
			const replaced = await ports.replaceServer(entry, local, async (serverText) => {
				outcome.backups.push(await ports.writeBackup(entry, serverText));
			});
			if (!replaced) return false;
			await ports.markAgreed(entry, local);
			return true;
		}
	}
}

/**
 * Auto-connect pairs the user cancelled in the check, stored in the plugin
 * settings as "<shareId>:<path>". The share id is the server's share id,
 * which is also the local VaultShare's guid.
 */
export function declinedAttachKey(shareId: string, path: string): string {
	return `${shareId}:${path}`;
}

export function isAttachDeclined(declined: readonly string[] | undefined, shareId: string, path: string): boolean {
	return (declined ?? []).includes(declinedAttachKey(shareId, path));
}

export function withDeclinedAttach(declined: readonly string[] | undefined, shareId: string, path: string): string[] {
	const list = [...(declined ?? [])];
	const key = declinedAttachKey(shareId, path);
	return list.includes(key) ? list : [...list, key];
}

export function withoutDeclinedAttach(declined: readonly string[] | undefined, shareId: string, path: string): string[] {
	const key = declinedAttachKey(shareId, path);
	return (declined ?? []).filter((k) => k !== key);
}
