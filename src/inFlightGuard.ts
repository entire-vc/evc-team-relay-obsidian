/**
 * Lets at most one async operation per key run at a time; a second call for a
 * key that is already busy is dropped, not queued.
 *
 * The key is taken SYNCHRONOUSLY, before the first `await` of the guarded
 * operation. A guard that is only set after an await (e.g. once a server-info
 * fetch has come back) leaves a window in which a fast second click passes it
 * too -- for the sign-in button that meant two loopback OAuth servers, one of
 * which nothing could cancel any more.
 */
export class InFlightGuard<K> {
	private readonly busy = new Set<K>();

	/** True while an operation for `key` is running. */
	has(key: K): boolean {
		return this.busy.has(key);
	}

	/**
	 * Runs `op` unless one is already running for `key`. Returns false (and does
	 * not call `op`) when dropped. The key is released when `op` settles, also
	 * when it throws.
	 */
	async run(key: K, op: () => Promise<void>): Promise<boolean> {
		if (this.busy.has(key)) return false;
		this.busy.add(key);
		try {
			await op();
			return true;
		} finally {
			this.busy.delete(key);
		}
	}
}
