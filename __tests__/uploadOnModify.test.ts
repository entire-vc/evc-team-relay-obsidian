/**
 * uploadsOnModify: a vault edit to a shared document is pushed through the
 * upload lane unless an editor bound to the document already writes it.
 */

import { describe, test, expect } from "@jest/globals";
import { holdsOnlySyncedText, uploadsOnModify } from "../src/uploadOnModify";

describe("uploadsOnModify", () => {
	test("a closed note that a background pull holds connected still uploads its edit", () => {
		expect(uploadsOnModify({ isOnline: true, editLock: false })).toBe(true);
	});

	test("a disconnected note uploads its edit, open in an editor or not", () => {
		expect(uploadsOnModify({ isOnline: false, editLock: false })).toBe(true);
		expect(uploadsOnModify({ isOnline: false, editLock: true })).toBe(true);
	});

	test("a connected note bound to an editor leaves the edit to the editor", () => {
		expect(uploadsOnModify({ isOnline: true, editLock: true })).toBe(false);
	});
});

describe("holdsOnlySyncedText", () => {
	test("a file holding the Y.Doc's text (a pull's own write) has nothing to upload", async () => {
		expect(await holdsOnlySyncedText({ content: "relay text" }, async () => "relay text")).toBe(true);
	});

	test("a file with an edit the Y.Doc lacks is uploaded", async () => {
		expect(await holdsOnlySyncedText({ content: "relay text" }, async () => "relay text\nedit")).toBe(false);
	});

	test("a failed read uploads rather than risk dropping an edit", async () => {
		expect(await holdsOnlySyncedText({ content: "x" }, () => Promise.reject(new Error("gone")))).toBe(false);
	});
});
