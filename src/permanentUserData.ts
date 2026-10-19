import * as Y from "yjs";

type UsersObserver = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => void;

/**
 * `Y.PermanentUserData` whose `users` map observer survives a user entry that
 * is already deleted by the time the observer runs.
 *
 * Yjs's `PermanentUserData` observes the `users` map and, for every key in
 * `event.keysChanged`, calls `initUser(users.get(key), key)`. A key that
 * arrives already deleted (a tombstoned entry in a replayed update) is in
 * `keysChanged`, but `users.get(key)` is `undefined`, so `initUser` throws
 * `TypeError: Cannot read properties of undefined (reading 'get')`.
 *
 * The exception escapes from inside `Y.applyUpdate` / `Y.transact`. Yjs applies
 * the update first and rethrows the observer's error afterwards, so the
 * document is intact -- but the throw aborts whatever awaited that call. For
 * `LocalDocumentStore` that is `replayStoredUpdates()`, which runs inside the
 * database-open promise: it rejects, `synced` never becomes true, and every
 * caller gated on `awaitSynced()` (materialising files, tracking new ones)
 * hangs while the share still reports `isOnline`. `setUserMapping` has the
 * same flaw one step later: its observer re-reads the key inside a timeout and
 * dereferences `undefined`.
 *
 * The guard hands the observers a `keysChanged` with the deleted keys removed,
 * and skips them entirely when nothing live is left, so a tombstone reaches no
 * handler that cannot cope with it. Every other event passes through untouched.
 */
export function createPermanentUserData(ydoc: Y.Doc): Y.PermanentUserData {
	const users = ydoc.getMap<unknown>("users");
	const guarded = new Proxy(users, {
		get(target, prop): unknown {
			const value: unknown = Reflect.get(target, prop, target);
			if (prop === "observe") {
				return (observer: UsersObserver) =>
					target.observe((event: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
						const live = new Set<string>();
						const keys: ReadonlySet<unknown> = event.keysChanged;
						for (const key of keys) {
							if (typeof key === "string" && target.has(key)) live.add(key);
						}
						if (live.size === 0) return;
						if (live.size === event.keysChanged.size) {
							observer(event, tr);
							return;
						}
						observer(
							Object.create(event, {
								keysChanged: { value: live },
							}) as Y.YMapEvent<unknown>,
							tr,
						);
					});
			}
			if (typeof value === "function") {
				const bound: unknown = value.bind(target);
				return bound;
			}
			return value;
		},
	});
	return new Y.PermanentUserData(ydoc, guarded);
}
