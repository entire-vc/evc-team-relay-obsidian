import type { Clock } from "./Clock";

type LogLevel = "debug" | "warn" | "log" | "error";

// Dependency-injection seams so the logger doesn't hard-depend on Obsidian's
// Vault/Notice APIs — swapped out in tests / non-plugin contexts.
export interface LogNotifier {
	notify(message: string): void;
}

export interface LogFileAdapter {
	appendText(path: string, content: string): Promise<void>;
	statFile(path: string): Promise<{ size: number } | null>;
	fileExists(path: string): Promise<boolean>;
	removeFile(path: string): Promise<void>;
	moveFile(oldPath: string, newPath: string): Promise<void>;
	writeContent(path: string, content: string): Promise<void>;
	readText(path: string): Promise<string>;
}

export const instanceLabels = new WeakMap();
let debugging = false;

export function setVerboseLogging(debug: boolean): void {
	debugging = debug;
}

interface LogWriterConfig {
	maxLogFileBytes: number;
	maxBackupFiles: number;
	suppressConsoleMirror: boolean;
	flushIntervalMs: number;
	maxWriteRetries: number;
	includeStackTraces: boolean;
}

const DEFAULT_LOG_CONFIG: LogWriterConfig = {
	maxLogFileBytes: 1024 * 1024, // 1MB
	maxBackupFiles: 5,
	suppressConsoleMirror: false,
	flushIntervalMs: 1000, // 1 second
	maxWriteRetries: 3,
	includeStackTraces: false, // false by default to avoid retaining stack strings
};

type LogEntry = {
	timestamp: string;
	level: LogLevel;
	message: string;
	callerInfo: string;
};

let logConfig: LogWriterConfig = DEFAULT_LOG_CONFIG;
let logFileAdapter: LogFileAdapter;
let activeLogPath: string;
const pendingEntries: LogEntry[] = [];

export function startLogWriter(
	adapter: LogFileAdapter,
	timeProvider: Clock,
	logFilePath: string,
	config?: Partial<LogWriterConfig>,
): void {
	logFileAdapter = adapter;
	activeLogPath = logFilePath;
	if (config) {
		logConfig = { ...logConfig, ...config };
	}
	timeProvider.scheduleInterval(() => {
		void flushPendingLogs();
	}, logConfig.flushIntervalMs);
}

export async function flushPendingLogs(): Promise<void> {
	if (pendingEntries.length === 0) return;

	const batch = pendingEntries.splice(0, pendingEntries.length);

	for (let attempt = 0; attempt < logConfig.maxWriteRetries; attempt++) {
		try {
			await rotateLogIfNeeded();
			const content = batch.map(formatLogEntry).join("\n") + "\n";
			await logFileAdapter.appendText(activeLogPath, content);
			return;
		} catch (error: unknown) {
			console.error(`Failed to write logs (attempt ${attempt + 1}):`, error);
			if (attempt === logConfig.maxWriteRetries - 1) {
				console.error("giving up on this batch, its log entries are being dropped");
			}
		}
	}
}

function backupPath(index: number): string {
	return `${activeLogPath}.${index}`;
}

async function rotateLogIfNeeded(): Promise<void> {
	const stat = await logFileAdapter.statFile(activeLogPath);
	if (!stat || stat.size <= logConfig.maxLogFileBytes) return;

	for (let i = logConfig.maxBackupFiles; i > 0; i--) {
		const oldFile = backupPath(i);
		if (!(await logFileAdapter.fileExists(oldFile))) continue;

		if (i === logConfig.maxBackupFiles) {
			await logFileAdapter.removeFile(oldFile);
		} else {
			await logFileAdapter.moveFile(oldFile, backupPath(i + 1));
		}
	}

	if (await logFileAdapter.fileExists(activeLogPath)) {
		await logFileAdapter.moveFile(activeLogPath, backupPath(1));
	}

	await logFileAdapter.writeContent(activeLogPath, "");
}

function formatLogEntry(entry: LogEntry): string {
	return `${entry.timestamp} :: ${entry.level.toUpperCase()} :: ${entry.message}\n    (from ${entry.callerInfo})`;
}

const SENSITIVE_KEYS = ["token", "authorization", "email", "key"];

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	return SENSITIVE_KEYS.some((sk) => lower.includes(sk));
}

function serializeErrorValue(err: Error): {
	name: string;
	message: string;
	stack?: string;
} {
	return {
		name: err.name,
		message: err.message,
		stack: err.stack
			?.split("\n")
			.map((line) => line.trim())
			.join(" "),
	};
}

function jsonReplacer(seen: WeakSet<object>) {
	return (key: string, value: unknown): unknown => {
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
		}
		if (typeof key === "string" && isSensitiveKey(key)) return "[REDACTED]";
		if (value instanceof Error) return serializeErrorValue(value);
		return value;
	};
}

function serializeArg(arg: unknown): string {
	if (typeof arg !== "object" || arg === null) return String(arg);

	try {
		return JSON.stringify(arg, jsonReplacer(new WeakSet()), 2);
	} catch (error: unknown) {
		if (!(error instanceof Error)) return "[Unknown Error]";
		if (error instanceof RangeError) {
			// Circular/deeply-nested structures blow the stack during stringify.
			return `<object too deep to serialize: ${Object.prototype.toString.call(arg)}>`;
		}
		return `<could not serialize arg: ${error.message}>`;
	}
}

const CONSOLE_STYLES: Record<"warn" | "error", string> = {
	warn: "color: #ff8c00; background: rgba(255, 140, 0, 0.1); font-weight: normal; padding: 1px 4px; border-radius: 2px;",
	error:
		"color: #ff5555; background: rgba(255, 85, 85, 0.1); font-weight: normal; padding: 1px 4px; border-radius: 2px;",
};

function emitToConsole(level: LogLevel, entry: LogEntry): void {
	const text = formatLogEntry(entry);

	if (logConfig.includeStackTraces || level === "debug" || level === "log") {
		if (level === "warn") console.warn(text);
		else if (level === "error") console.error(text);
		else console.debug(text);
		return;
	}

	// warn/error without stack traces: dim, styled one-liner instead of a raw trace.
	console.debug(`%c${text}`, CONSOLE_STYLES[level]);
}

function captureCallerInfo(): string {
	const stack = new Error().stack;
	return stack ? (stack.split("\n")[2]?.trim() ?? "") : "";
}

export function namedLogger(initialText: string, level: LogLevel = "log") {
	return (...args: unknown[]): void => {
		if (!debugging) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message: `${initialText}: ${args.map(serializeArg).join(" ")}`,
			callerInfo: captureCallerInfo(),
		};

		if (!logConfig.suppressConsoleMirror) {
			emitToConsole(level, entry);
		}

		pendingEntries.push(entry);
	};
}

async function existingLogFiles(): Promise<string[]> {
	const files: string[] = [];
	if (await logFileAdapter.fileExists(activeLogPath)) {
		files.push(activeLogPath);
	}
	for (let i = 1; i <= logConfig.maxBackupFiles; i++) {
		const backup = backupPath(i);
		if (await logFileAdapter.fileExists(backup)) {
			files.push(backup);
		}
	}
	return files;
}

export async function listLogFiles(): Promise<string[]> {
	return existingLogFiles();
}

export async function readAllLogs(): Promise<string> {
	const files = await existingLogFiles();
	const contents = await Promise.all(files.map((f) => logFileAdapter.readText(f)));
	return contents.reverse().join("\n");
}

export class Loggable {
	protected debug!: (...args: unknown[]) => void;
	protected log!: (...args: unknown[]) => void;
	protected warn!: (...args: unknown[]) => void;
	protected error!: (...args: unknown[]) => void;

	constructor(context?: string) {
		this.setLoggers(context || this.constructor.name);
	}

	protected setLoggers(context: string): void {
		this.debug = namedLogger(`<${context}>`, "debug");
		this.log = namedLogger(`<${context}>`, "log");
		this.warn = namedLogger(`<${context}>`, "warn");
		this.error = namedLogger(`<${context}>`, "error");
	}
}
