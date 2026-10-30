# M3 isolated sync scenario

Runs the real sync/pull code (`Document`, `ProviderBacked`, `YSweetProvider`
over real sockets, `LocalDocumentStore`, `TransferQueue.pullIfUnchanged`,
`preserveBeforeTrash`) against a **disposable loopback relay** and proves, with
no working relay and no prod connection:

- two completed syncs on distinct connections (counted by the relay),
- a peer edit changes the file's content on disk,
- a local, never-uploaded edit is kept as a conflict copy.

Only external boundaries are stand-ins: the relay (`DisposableRelay.ts`), the
token request, the vault (plain files under the disposable root). Nothing in
the sync path is mocked.

```bash
npx jest __tests__/m3                                   # also part of `npm test` and CI
M3_RECEIPT_OUT=/tmp/m3-receipt.json npx jest __tests__/m3/m3SyncScenario.test.ts
```

The receipt names the commit (`head`), a SHA-256 over every file in `src/`
(`src_sha256`) and, per run, sizes and 8-hex digests only.

## Isolation (fails closed, `isolation.ts`)

- Endpoint: only the relay's own `ws://127.0.0.1:<port>` origin. A host name,
  another port, `wss://`, userinfo tricks are rejected before a connection; the
  global `WebSocket`/`fetch` are also guarded for the duration of a run.
- Path: only inside a fresh directory this tool creates under the OS temp dir
  (marker file, `..` and symlinks resolved). Anything else is rejected before a
  write.
- `isolation.test.ts` holds the RED cases and the positive controls.

## Running it with the private copy

The owner of the private copy puts a fixture file **on the machine that runs
it** (never in the repo, a card or a comment):

```json
{ "entryPath": "folder/note.md", "agreedText": "...", "peerAppend": "...", "localEdit": "..." }
```

`agreedText` is the last text the client and relay agreed on, `peerAppend` what
the peer added, `localEdit` an optional unuploaded edit. Then:

```bash
M3_FIXTURE=/path/to/fixture.json M3_RECEIPT_OUT=/path/to/receipt.json \
  npx jest __tests__/m3/m3SyncScenario.test.ts
```

The scenario copies nothing out of the fixture: the vault, the relay and the
local store are all created fresh and deleted at the end of the run.

## Output limits

Share only the receipt file: it holds the commit, the source digest, outcomes
(`history-gap`, `flushed`), counts, character counts and 8-hex digests. Do not
paste the fixture, the Jest log of a failing assertion (it can quote texts) or
the vault directory. If a run fails, report the test name and the receipt.

This receipt does not replace the live MacBook AC4 and does not authorise a stable
release.
