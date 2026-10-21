/**
 * Regression: GH #5 — `TypeError: Cannot read properties of null (reading
 * 'resourceAddress')` thrown from bringOnline(). dismantle() nulls `_parent`,
 * so a reconnect/retry firing afterwards dereferenced `this.vaultShare.resourceAddress`
 * on null. A dismantled entry must report "not connected" instead of throwing.
 */
import { describe, test, expect } from "@jest/globals";
import { AttachmentFile } from "../src/AttachmentFile";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";

function dismantled<T extends object>(proto: T): T {
	const obj = Object.create(proto) as Record<string, unknown>;
	obj._parent = null;
	return obj as T;
}

describe("bringOnline() on a dismantled entry", () => {
	test.each([
		["AttachmentFile", AttachmentFile.prototype],
		["Document", Document.prototype],
		["CanvasDocument", CanvasDocument.prototype],
	])("%s resolves false instead of throwing", async (_n, proto) => {
		const entry = dismantled(proto) as { bringOnline(): Promise<boolean> };
		await expect(entry.bringOnline()).resolves.toBe(false);
	});
});
