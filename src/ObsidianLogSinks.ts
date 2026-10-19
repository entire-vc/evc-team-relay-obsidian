import { Notice, Vault } from "obsidian";
import type { LogFileAdapter, LogNotifier } from "./logging";

export class NoticeSink implements LogNotifier {
	notify(message: string): void {
		new Notice(message);
	}
}

/** Thin passthrough onto Obsidian's DataAdapter — exists only to satisfy LogFileAdapter. */
export class VaultFileSink implements LogFileAdapter {
	constructor(private readonly vault: Vault) {}

	appendText(path: string, content: string): Promise<void> {
		return this.vault.adapter.append(path, content);
	}

	statFile(path: string): Promise<{ size: number } | null> {
		return this.vault.adapter.stat(path);
	}

	fileExists(path: string): Promise<boolean> {
		return this.vault.adapter.exists(path);
	}

	removeFile(path: string): Promise<void> {
		return this.vault.adapter.remove(path);
	}

	moveFile(oldPath: string, newPath: string): Promise<void> {
		return this.vault.adapter.rename(oldPath, newPath);
	}

	writeContent(path: string, content: string): Promise<void> {
		return this.vault.adapter.write(path, content);
	}

	readText(path: string): Promise<string> {
		return this.vault.adapter.read(path);
	}
}
