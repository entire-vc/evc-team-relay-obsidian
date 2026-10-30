/**
 * Fail-closed isolation for the M3 sync scenario (see README.md).
 *
 * The scenario drives the real sync/pull code, so nothing but this module
 * keeps it away from a working relay or vault. Every check throws
 * `IsolationError` BEFORE any connection is opened or any byte is written;
 * a caller that skips the check gets no endpoint and no path to use.
 *
 *   endpoint: only the one loopback origin the disposable relay listens on.
 *   path:     only inside a disposable root this module created (marker file
 *             in a fresh directory under the OS temp dir), after resolving
 *             `..` and symlinks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export class IsolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IsolationError";
	}
}

const MARKER = ".m3-disposable";

/** A fresh, empty directory under the OS temp dir, marked as disposable. */
export function createDisposableRoot(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "m3-")));
	fs.writeFileSync(path.join(root, MARKER), randomBytes(8).toString("hex"));
	return root;
}

export function removeDisposableRoot(root: string): void {
	assertDisposableRoot(root);
	fs.rmSync(root, { recursive: true, force: true });
}

function assertDisposableRoot(root: string): void {
	let real: string;
	try {
		real = fs.realpathSync(root);
	} catch {
		throw new IsolationError("disposable root does not exist");
	}
	const tmp = fs.realpathSync(os.tmpdir());
	if (!real.startsWith(tmp + path.sep)) throw new IsolationError("disposable root is outside the temp dir");
	if (!fs.existsSync(path.join(real, MARKER))) throw new IsolationError("directory is not marked disposable");
}

/** Resolve `target` through symlinks even when its tail does not exist yet. */
function resolveThroughSymlinks(target: string): string {
	const absolute = path.resolve(target);
	let existing = absolute;
	const tail: string[] = [];
	while (!fs.existsSync(existing)) {
		tail.unshift(path.basename(existing));
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return path.join(fs.realpathSync(existing), ...tail);
}

/** Returns the resolved absolute path, or throws before anything is touched. */
export function assertDisposablePath(root: string, target: string): string {
	assertDisposableRoot(root);
	const realRoot = fs.realpathSync(root);
	const resolved = resolveThroughSymlinks(path.isAbsolute(target) ? target : path.join(realRoot, target));
	if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
		throw new IsolationError("path is outside the disposable root");
	}
	return resolved;
}

/**
 * Only the disposable relay's own loopback origin passes. A host name is never
 * resolved here: `localhost`, a DNS name or a LAN address could point anywhere.
 */
export function assertDisposableEndpoint(url: string, allowedOrigin: string): URL {
	let parsed: URL;
	let allowed: URL;
	try {
		parsed = new URL(url);
		allowed = new URL(allowedOrigin);
	} catch {
		throw new IsolationError("endpoint is not a URL");
	}
	const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (!/^(ws|http):$/.test(parsed.protocol) || !loopback) {
		throw new IsolationError("endpoint is not a loopback address");
	}
	if (parsed.host !== allowed.host) throw new IsolationError("endpoint is not the disposable relay");
	return parsed;
}

/**
 * Defence in depth: while installed, the global WebSocket and fetch refuse any
 * other origin, so a code path that bypasses `assertDisposableEndpoint` still
 * cannot open a connection. Returns the restore function.
 */
export function installNetworkGuard(allowedOrigin: string): () => void {
	const g = globalThis as unknown as { WebSocket: typeof WebSocket; fetch: typeof fetch };
	const realWebSocket = g.WebSocket;
	const realFetch = g.fetch;
	g.WebSocket = class GuardedWebSocket extends realWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			assertDisposableEndpoint(String(url), allowedOrigin);
			super(url, protocols);
		}
	} as typeof WebSocket;
	g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assertDisposableEndpoint(input instanceof Request ? input.url : String(input), allowedOrigin);
		return realFetch(input, init);
	}) as typeof fetch;
	return () => {
		g.WebSocket = realWebSocket;
		g.fetch = realFetch;
	};
}
