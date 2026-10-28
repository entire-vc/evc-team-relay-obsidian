# Changelog

## 0.1.30
- Fixed: after both devices restarted, a closed note could become empty on the device that created it, while the other device still had the full text. The plugin no longer writes a note to disk while part of its history is still missing.
- Fixed: a note deleted on one device could come back on every device, as a new note, after the other device restarted offline and then came back online. A shared folder now reads its stored records before it connects.
- Fixed: a note edited while this device was offline could stay out of date for a minute or more after reconnecting. Changes announced during the offline period are now fetched as soon as the connection returns.
- Fixed: when the server refuses access to a share, background token renewal no longer retries it every minute; it follows the same backoff as other requests. Shared folders removed from the vault are no longer checked for changes.

## 0.1.29
- Fixed: a note whose content reached the server a few seconds late could stay missing on another device for five minutes. The plugin now checks again after a few seconds, then waits longer between checks.
- Fixed: shared folders that are not in this vault are no longer checked for changes every few seconds. They are checked when the share list loads. Once such a folder is downloaded, it is watched like any other.
- Fixed: when the server refuses access to a share, the plugin no longer requests access again in a tight loop. It waits longer between attempts, and the folder shows that access was refused. Signing in again or "Sync all shares" retries right away.

## 0.1.28
- Fixed: a note deleted on another device while this device was offline came back after this device restarted, on every device and as a new note. A note removed while you were away is now deleted locally after the restart and is no longer uploaded again.

## 0.1.27
- Fixed: during a large import, an edit to a closed note could be reported as sent while its connection was still waiting to open, and then reached other devices only half a minute or more later. The plugin now waits until the connection is ready before sending the edit.

## 0.1.26
- Fixed: an idle vault no longer re-checks every note with the server back to back. The background check of a shared folder now runs at most once every fifteen minutes, which sharply cuts the load one device puts on the server. Changes announced by other devices still arrive right away.

## 0.1.25
- Fixed: during a large import, a change from another device that the server was slow to hand over no longer sits unseen for up to forty seconds. The plugin now asks the server again after a few seconds.

## 0.1.24
- Fixed: an edit to a closed note made while the note was briefly syncing in the background no longer waits up to a minute and a half to reach other devices. It is now sent right away.

## 0.1.23
- Improved: the sync health check now records, for each recent edit to a closed note, how long it took to upload and how long the other device took to fetch it, so slow deliveries can be traced to their cause.

## 0.1.22
- Fixed: during a large import, a folder whose notes are being edited is no longer mistaken for part of the import, so those edits are not held back behind it for up to a minute and a half. A connection attempt that hangs now gives up sooner when connections are normally fast.

## 0.1.21
- Fixed: during a large import or background sync, edits to closed notes and changes from other devices no longer wait up to half a minute to connect behind background connections. Connections for notes in use now go first, and a connection attempt that hangs is retried instead of holding up the rest.

## 0.1.20
- Improved: the sync health check now records how long each step of connecting to the server takes, so slow connections can be traced to their cause.

## 0.1.19
- Fixed: during a large import or background sync, edits to closed notes and changes from other devices now get access to the server ahead of the background work, instead of waiting in line behind it for up to half a minute.

## 0.1.18
- Fixed: while many notes sync at once, for example during a large import, connections to closed notes no longer wait up to a minute for access to the server. The plugin now requests access up to 120 times a minute instead of 25, and slows down on its own if a server answers that it is busy.

## 0.1.17
- Fixed: while edits to closed notes are waiting to sync, a large background import or upload now uses at most one connection at a time, so the edits are no longer slowed down by it. The import speeds back up once the edits are through.
- Fixed: when another device reports a change to a closed note before the server has its text, the plugin now stays connected and receives the text as soon as it arrives, instead of reconnecting for each check.

## 0.1.16
- Fixed: on a computer whose clock runs more than a minute behind the server, the plugin no longer keeps using an expired connection token. Previously the live connection to a shared note was refused about once a minute until the token was renewed.

## 0.1.15
- Fixed: an edit to a closed note that fails to upload while the server is busy is now sent again within seconds, instead of waiting minutes for the next background pass. An edit saved while the same note is still uploading is no longer skipped.
- Fixed: a change from another device that is slow to become visible on the server keeps being checked for up to ten minutes instead of three, so it no longer waits for the next full background pass. While another shared folder receives a large import, these checks and fresh edits to closed notes get a reserved slot, and a fresh edit always comes first.

## 0.1.14
- Fixed: while one shared folder receives a large import from another device, edits to closed notes in other shared folders are no longer left waiting behind it. Some of them could stay missing for many minutes.

## 0.1.13
- Fixed: an edit to a closed note that reaches the server late, for example while the other device is importing hundreds of notes, now still arrives on its own instead of waiting for the next full background pass. Repeat checks for slow notes back off, so they no longer delay other edits.

## 0.1.12
- Fixed: while one shared folder imports a large batch of notes, edits to closed notes in other shared folders are sent first instead of waiting their turn behind the import.

## 0.1.11
- Fixed: an edit to a closed note in one shared folder is no longer held up while another shared folder uploads a large batch of notes (for example an import of hundreds of notes).
- Fixed: when two members add the same note to a shared folder at the same time, no identical "(upload race …)" copy is created anymore.

## 0.1.10
- Fixed: an edit to a closed note in one shared folder now reaches other devices within seconds even while another shared folder is syncing hundreds of notes in the background. Background sync speed is unchanged.

## 0.1.9
- Fixed: a note created or edited while closed is sent within seconds even right after Obsidian starts, when large shared folders still have hundreds of notes queued. Busy folders no longer hold up notes in other folders.
- Fixed: a new note from another device that arrived on the server a little late is now written to disk without restarting Obsidian.

## 0.1.8
- Fixed: a published folder that receives many new or changed notes at once (for example a large first sync) no longer floods the server with updates. Its web index is now refreshed at most once every 30 seconds, always with the latest list, and the plugin backs off when the server asks it to slow down.
- Fixed: a background retry or reconnect that fires after a note has been removed from a shared folder no longer throws an error.

## 0.1.7
- Fixed: edits to notes that are closed on another device now arrive within seconds even in large vaults with several shared folders. A stalled background check can no longer block the others, and busy folders no longer delay updates in small ones.

## 0.1.6
- Fixed: deleting the last note (or every note at once) in a shared folder on one device now removes it on the other devices too. A newly shared, still-empty folder still keeps your existing local notes.

## 0.1.5
- Web-published folders: updates to the folder's page list are now batched instead of sent on every file event. Syncing many notes into a published folder at once no longer floods the server with requests. Failed updates back off and respect the server's `Retry-After`.

## 0.1.4
- Removed a type assertion in the editor status bindings that became redundant with the Svelte 5 mount helper. No functional changes.

## 0.1.3
- Svelte components are now mounted with the Svelte 5 `mount`/`unmount` API instead of the legacy component API; the legacy compatibility mode is turned off. No functional changes.

## 0.1.2
- Removing files and folders (stale copies after a move, discarded folder creations, "Delete local copy") now goes through Obsidian's file manager, so it follows your "Deleted files" setting instead of always using the vault `.trash` folder.
- Internal type cleanups in the local document store. No other functional changes.

## 0.1.1
- Renamed to **Team Relay Sync** with plugin id `team-relay-sync`: the community portal rejected `evc-team-relay` (entry with this ID already exists). No functional changes.

## 0.1.0
- Initial release of Team Relay Sync (published as EVC Team Relay): real-time collaboration, shared folders and web publishing for Obsidian vaults, against a self-hosted or hosted Team Relay server.
