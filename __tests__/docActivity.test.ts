/**
 * Unit tests: DocActivityChannel
 *
 * Two real Y.Docs stand in for two clients' copies of one folder doc,
 * exchanging updates the way the relay would. Covers:
 *   (a) a local edit is announced to the OTHER client, debounced, with the
 *       fingerprint of the text at the end of the burst
 *   (b) a client never hears its own announcement
 *   (c) a continuous burst still publishes by PUBLISH_MAX_WAIT_MS
 *   (d) destroy() cancels pending announcements and stops listening
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import * as Y from "yjs";
import { DocActivityChannel, textFingerprint, type ActivityTimers } from "src/docActivity";

class FakeTimers implements ActivityTimers {
	time = 0;
	private next = 1;
	private timers = new Map<number, { at: number; cb: () => void }>();
	setTimeout = (cb: () => void, ms: number): number => {
		const id = this.next++;
		this.timers.set(id, { at: this.time + ms, cb });
		return id;
	};
	clearTimeout = (id: number): void => {
		this.timers.delete(id);
	};
	now = (): number => this.time;
	advance(ms: number): void {
		this.time += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.time) {
				this.timers.delete(id);
				timer.cb();
			}
		}
	}
}

function linkedFolderDocs(): [Y.Doc, Y.Doc] {
	const a = new Y.Doc();
	const b = new Y.Doc();
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(b, update, "relay");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(a, update, "relay");
	});
	return [a, b];
}

describe("DocActivityChannel", () => {
	let timers: FakeTimers;
	let sender: DocActivityChannel;
	let receiver: DocActivityChannel;
	let heardBySender: jest.Mock<(guid: string, fp: string) => void>;
	let heardByReceiver: jest.Mock<(guid: string, fp: string) => void>;

	beforeEach(() => {
		timers = new FakeTimers();
		const [a, b] = linkedFolderDocs();
		sender = new DocActivityChannel(a, timers);
		receiver = new DocActivityChannel(b, timers);
		heardBySender = jest.fn();
		heardByReceiver = jest.fn();
		sender.subscribeRemote(heardBySender);
		receiver.subscribeRemote(heardByReceiver);
	});

	test("announces a local edit to the other client, once, with the final text's fingerprint", () => {
		let text = "a";
		sender.noteLocalEdit("doc-1", () => text);
		timers.advance(500);
		text = "ab";
		sender.noteLocalEdit("doc-1", () => text);
		expect(heardByReceiver).not.toHaveBeenCalled();

		timers.advance(1_000);
		expect(heardByReceiver).toHaveBeenCalledTimes(1);
		expect(heardByReceiver).toHaveBeenCalledWith("doc-1", textFingerprint("ab"));
		expect(heardBySender).not.toHaveBeenCalled();
	});

	test("a continuous burst is still announced within the max wait", () => {
		for (let i = 0; i < 20; i++) {
			sender.noteLocalEdit("doc-1", () => `v${i}`);
			timers.advance(400);
		}
		// 8s of typing with 400ms gaps: the 1s debounce alone would never fire.
		expect(heardByReceiver.mock.calls.length).toBeGreaterThanOrEqual(1);
	});

	test("the same text is not re-announced", () => {
		sender.noteLocalEdit("doc-1", () => "same");
		timers.advance(1_000);
		sender.noteLocalEdit("doc-1", () => "same");
		timers.advance(1_000);
		expect(heardByReceiver).toHaveBeenCalledTimes(1);
	});

	test("destroy() cancels pending announcements and stops listening", () => {
		sender.noteLocalEdit("doc-1", () => "x");
		sender.destroy();
		timers.advance(5_000);
		expect(heardByReceiver).not.toHaveBeenCalled();

		const [a, b] = linkedFolderDocs();
		const liveSender = new DocActivityChannel(a, timers);
		const destroyedReceiver = new DocActivityChannel(b, timers);
		const heard = jest.fn();
		destroyedReceiver.subscribeRemote(heard);
		destroyedReceiver.destroy();
		liveSender.noteLocalEdit("doc-2", () => "y");
		timers.advance(1_000);
		expect(b.getMap("docactivity_v0").get("doc-2")).toBe(textFingerprint("y"));
		expect(heard).not.toHaveBeenCalled();
	});

	test("fingerprints differ for different text and match for equal text", () => {
		expect(textFingerprint("hello")).toBe(textFingerprint("hello"));
		expect(textFingerprint("hello")).not.toBe(textFingerprint("hellp"));
		expect(textFingerprint("")).not.toBe(textFingerprint(" "));
	});
});
