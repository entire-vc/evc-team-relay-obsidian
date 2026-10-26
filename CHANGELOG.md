# Changelog

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
