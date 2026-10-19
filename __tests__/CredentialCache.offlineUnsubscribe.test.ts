import { CredentialCache } from "../src/CredentialCache";
import { MockClock } from "./mocks/MockClock";
import { describe, expect, test } from "@jest/globals";

// A doc that went offline must stop re-issuing its relay token on every
// expiry sweep. Before the fix subscriberCallbacks was never cleared, so each
// document ever synced kept refreshing (~every 4 min) and saturated the
// 25/min token throttle during the first sync of a large vault.
interface TestToken {
	token: string;
}

const MINUTE_MS = 60 * 1000;
const TTL_MS = 5 * MINUTE_MS;

function buildStore(clock: MockClock, counter: { count: number }) {
	return new CredentialCache<TestToken>(
		{
			logMessage: () => undefined,
			refreshToken: (_id: string, onSuccess: (t: TestToken) => void) => {
				counter.count++;
				onSuccess({ token: (clock.now() + TTL_MS).toString() });
			},
			getClock: () => clock,
			getTokenExpiry: (t) => parseInt(t.token, 10),
		},
		1,
	);
}

// MockClock's interval re-arming is unreliable across many ticks, so run one
// sweep per simulated minute explicitly (startSweeping sweeps immediately).
function runSweeps(store: CredentialCache<TestToken>, clock: MockClock, minutes: number) {
	for (let i = 0; i < minutes * 2; i++) {
		clock.setTime(clock.now() + MINUTE_MS / 2);
		store.startSweeping();
		store.stopSweeping();
	}
}

describe("CredentialCache offline unsubscribe", () => {
	test("a dropped (offline) doc is not refreshed by the sweep", async () => {
		const clock = new MockClock();
		const counter = { count: 0 };
		const store = buildStore(clock, counter);
		await store.acquireToken("doc1", "doc1", () => undefined);
		store.dropFromQueue("doc1");

		const before = counter.count;
		runSweeps(store, clock, 20);
		expect(counter.count - before).toBe(0);
	});

	test("re-acquiring after offline resubscribes, so the doc is refreshed again", async () => {
		const clock = new MockClock();
		const counter = { count: 0 };
		const store = buildStore(clock, counter);
		await store.acquireToken("doc1", "doc1", () => undefined);
		store.dropFromQueue("doc1");
		await store.acquireToken("doc1", "doc1", () => undefined);

		const before = counter.count;
		runSweeps(store, clock, 20);
		expect(counter.count - before).toBeGreaterThan(0);
	});

	test("reacquiring while a refresh is in flight resubscribes the doc", async () => {
		const clock = new MockClock();
		const counter = { count: 0 };
		const pending: Array<(t: TestToken) => void> = [];
		const store = new CredentialCache<TestToken>(
			{
				logMessage: () => undefined,
				refreshToken: (_id: string, onSuccess: (t: TestToken) => void) => {
					counter.count++;
					pending.push(onSuccess);
				},
				getClock: () => clock,
				getTokenExpiry: (t) => parseInt(t.token, 10),
			},
			1,
		);
		const first = store.acquireToken("doc1", "doc1", () => undefined);
		store.dropFromQueue("doc1"); // goes offline mid-refresh
		const received: string[] = [];
		const second = store.acquireToken("doc1", "doc1", (t) => received.push(t.token));
		pending[0]({ token: (clock.now() + TTL_MS).toString() });
		await Promise.all([first, second]);
		expect(received.length).toBe(1); // the new subscriber was notified

		const before = counter.count;
		store.startSweeping();
		store.stopSweeping();
		clock.setTime(clock.now() + TTL_MS - 30 * 1000);
		store.startSweeping();
		store.stopSweeping();
		expect(counter.count - before).toBeGreaterThan(0); // still swept
	});

	test("a failed refresh does not unsubscribe a doc that is still in use", async () => {
		const clock = new MockClock();
		let fail = false;
		const received: string[] = [];
		const store = new CredentialCache<TestToken>(
			{
				logMessage: () => undefined,
				refreshToken: (
					_id: string,
					onSuccess: (t: TestToken) => void,
					onError: (e: Error) => void,
				) => {
					if (fail) onError(new Error("boom"));
					else onSuccess({ token: (clock.now() + TTL_MS).toString() });
				},
				getClock: () => clock,
				getTokenExpiry: (t) => parseInt(t.token, 10),
			},
			1,
		);
		await store.acquireToken("doc1", "doc1", (t) => received.push(t.token));
		clock.setTime(clock.now() + TTL_MS - 30 * 1000);
		fail = true;
		await store.requestRefresh("doc1").catch(() => undefined);
		fail = false;
		store.startSweeping();
		store.stopSweeping();
		expect(received.length).toBeGreaterThanOrEqual(2); // sweep still reached the subscriber
	});
});
