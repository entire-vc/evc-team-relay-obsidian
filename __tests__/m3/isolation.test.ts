/**
 * AC2: the isolation fails closed. Every RED case must throw before a
 * connection is opened or a byte is written; every positive control proves the
 * guard lets the disposable endpoint and path through (so a RED is not just a
 * guard that rejects everything).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, expect } from "@jest/globals";
import { DisposableRelay } from "./DisposableRelay";
import {
	IsolationError,
	assertDisposableEndpoint,
	assertDisposablePath,
	createDisposableRoot,
	installNetworkGuard,
	removeDisposableRoot,
} from "./isolation";
import { runM3Scenario, SYNTHETIC_FIXTURE } from "./scenario";

describe("M3 isolation: endpoint", () => {
	const origin = "ws://127.0.0.1:41000";

	test("positive control: the disposable relay's own origin passes", () => {
		expect(assertDisposableEndpoint(`${origin}/doc?token=x`, origin).host).toBe("127.0.0.1:41000");
	});

	test.each([
		["a prod-like https host", "https://relay.example.com/doc"],
		["a prod-like wss host", "wss://relay.example.com/doc"],
		["localhost by name", "ws://localhost:41000/doc"],
		["loopback on another port", "ws://127.0.0.1:41001/doc"],
		["a LAN address", "ws://192.168.1.10:41000/doc"],
		["userinfo hiding the real host", "ws://127.0.0.1:41000@relay.example.com/doc"],
		["not a URL", "not a url"],
	])("RED: %s is rejected", (_name, url) => {
		expect(() => assertDisposableEndpoint(url, origin)).toThrow(IsolationError);
	});

	test("RED: the network guard refuses a foreign origin before any socket is opened", async () => {
		const relay = new DisposableRelay("t");
		await relay.start();
		const restore = installNetworkGuard(relay.origin);
		try {
			expect(() => new WebSocket("wss://relay.example.com/doc")).toThrow(IsolationError);
			expect(() => new WebSocket(`ws://127.0.0.1:1/doc`)).toThrow(IsolationError);
			await expect(fetch("https://relay.example.com/health")).rejects.toThrow(IsolationError);
			expect(relay.upgrades).toBe(0);
		} finally {
			restore();
			await relay.stop();
		}
	});
});

describe("M3 isolation: path", () => {
	test("positive control: a path inside the disposable root passes", () => {
		const root = createDisposableRoot();
		try {
			expect(assertDisposablePath(root, "vault/note.md")).toBe(path.join(fs.realpathSync(root), "vault", "note.md"));
		} finally {
			removeDisposableRoot(root);
		}
	});

	test("RED: outside paths are rejected and nothing is written", () => {
		const root = createDisposableRoot();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "m3-outside-"));
		fs.symlinkSync(outside, path.join(root, "link"));
		fs.symlinkSync(path.join(outside, "not-yet"), path.join(root, "dangling"));
		try {
			for (const bad of ["../escape.md", path.join(outside, "x.md"), "/etc/m3-escape", "link/x.md", "dangling", "dangling/x.md", "vault/../../x.md"]) {
				expect(() => assertDisposablePath(root, bad)).toThrow(IsolationError);
			}
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			removeDisposableRoot(root);
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("RED: a directory that is not a marked disposable root is rejected", () => {
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), "m3-plain-"));
		try {
			expect(() => assertDisposablePath(plain, "x.md")).toThrow(IsolationError);
			expect(() => removeDisposableRoot(plain)).toThrow(IsolationError);
			expect(() => assertDisposablePath(path.join(os.homedir(), "Documents"), "x.md")).toThrow(IsolationError);
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("M3 isolation: the scenario itself", () => {
	test("RED: a grant that points at a foreign endpoint aborts the run before any connection", async () => {
		await expect(
			runM3Scenario(SYNTHETIC_FIXTURE, { grantUrlOverride: "wss://relay.example.com" }),
		).rejects.toThrow(IsolationError);
	}, 60_000);

	test("RED: a vault path outside the disposable root aborts the run before any write", async () => {
		await expect(runM3Scenario(SYNTHETIC_FIXTURE, { vaultPathOverride: "../../outside" })).rejects.toThrow(IsolationError);
	}, 60_000);
});
