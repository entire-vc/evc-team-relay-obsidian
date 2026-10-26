# Changelog

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
