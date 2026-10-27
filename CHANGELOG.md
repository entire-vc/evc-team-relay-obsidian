# Changelog

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
