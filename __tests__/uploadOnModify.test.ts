import { needsUploadOnModify } from "../src/uploadOnModify";

describe("needsUploadOnModify", () => {
	test("a closed note connected by a background pull is still uploaded", () => {
		// Live under load: the edit landed while a background pull held the
		// note's socket, was skipped as "connected", and reached the relay only
		// 43-73 s later when the next background pass found it.
		const doc = { editLock: false, isOnline: true };
		expect(needsUploadOnModify(doc)).toBe(true);
	});

	test("a closed, disconnected note is uploaded", () => {
		expect(needsUploadOnModify({ editLock: false })).toBe(true);
	});

	test("a note bound to an open editor is left to the editor", () => {
		expect(needsUploadOnModify({ editLock: true })).toBe(false);
	});
});
