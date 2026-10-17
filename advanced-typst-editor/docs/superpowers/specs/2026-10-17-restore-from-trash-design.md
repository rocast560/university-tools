# Restore from trash

Date: 2026-10-17. Status: requested by the user ("add a restore from trash button"); details are the lead's calls.

## Why

Since 2026-10-17 nothing in Typst Studio is erased: deleting a document moves its folder into `data/trash/<stamp>/`, and deleting a file or asset moves it into `data/trash/<stamp>/<workspace folder>/<relative path>` (`server/service.ts` `remove`, `server/workspace.ts` trash move). There is no way back from inside the app; today a restore means moving folders by hand. The user wants a button.

## Rules (from `brain/data-safety.md`)

- Restoring is a move back out of the trash, never a copy-then-delete that could lose the only copy. Cross-drive falls back to copy, then remove the trash copy only after the copy succeeded (same pattern as the trash move in `server/workspace.ts`).
- A restore never overwrites anything. If the original location is taken, restore under a free name (`<name> (restored)`, then `(restored 2)` ...).
- There is **no "empty trash" and no permanent delete**. Out of scope on purpose.

## What the trash holds

Two kinds of item under `data/trash/<stamp>/`:

- **Document:** a whole workspace folder, recognised by the `workspace.json` (`META_FILE` in `server/workspace.ts`) at its top.
- **Files:** `<workspace folder name>/<relative path>` for one or more deleted files or assets of a workspace, with no `workspace.json` at that level.

Six items already exist from before this change and have no metadata. They must still be listable and restorable.

### Metadata going forward

When something is moved to the trash, write a sidecar `data/trash/<stamp>/.trash.json` describing what went in:
- kind;
- original absolute path, or the workspace id plus relative paths for files;
- deleted at;
- for a document, its full registry entry: name, group, parent, appearance, library flag.

One stamp folder can hold several items (a bulk delete in the same millisecond is unlikely but possible), so the sidecar holds a list. Writes use `writeAtomic` (`server/fsx.ts`).

### Legacy items (no sidecar)

- A top-level folder with `workspace.json` is a document. Its original location is `data/workspaces/<folder>`, with no group, parent or appearance.
- Anything else is files of the workspace whose folder name matches. If no live workspace has that folder name, show the item but disable Restore with the reason "its document isn't in the app; restore the document first".

## Behaviour

**List.** `GET /api/trash` returns items newest first: id (stamp plus item name), kind, display name, the workspace it belongs to (for files), deleted at (from the sidecar, else parsed from the stamp), size, file count, and whether it can be restored and why not.

**Restore a document**, via `POST /api/trash/:id/restore`:
1. Move the folder back to its original path, or under a free name next to it if that path is taken.
2. Register it as a workspace: original group (recreated if that folder no longer exists), and appearance.
3. Re-attach the original parent only if that workspace still exists.
4. Fire the usual `workspaces.changed` event.

**Restore files.** Move each file back to `<workspace>/<relative path>`, taking a free name if that path is taken. Fire the usual `workspace.changed` event for that workspace.

**Clean-up after a restore.** Update or remove that item's sidecar entry. Remove the stamp folder only if it's then empty: `rmdir` of an empty directory, never recursive.

**UI.**
- A **Trash** row in the sidebar footer, under the MCP and backup status rows, with a count when non-empty.
- Clicking it opens a dialog in the app's existing dialog style (see `src/components/ui/ConfirmDialog.tsx` and `FolderBrowserDialog.tsx`) listing the items: name, kind icon, "from <document>" for files, relative time, size.
- Each item has a **Restore** button. On success the item leaves the list and a short status line names where it went ("Restored to School/ECE-2300L/Lab 4" or "Restored as 'Lab 4 (restored)'").
- A disabled Restore shows its reason as a tooltip and inline text.
- No other actions.

**MCP:** `list_trash` and `restore_from_trash`, so Claude can recover something the user asks for. Describe them plainly in `server/mcp-tools.ts`.

## Tests (vitest, failing first)

- **Server:**
  - listing finds sidecar items and both legacy kinds;
  - a document restore re-registers with its group, appearance and existing parent;
  - a taken original path gets a "(restored)" name;
  - a files restore puts files back and never overwrites;
  - a legacy files item with no matching workspace is listed with `canRestore: false`;
  - the stamp folder is removed only when empty;
  - nothing in the trash is deleted except by moving it out.
- **UI:**
  - the footer row shows the count and opens the dialog;
  - Restore calls the API, then removes the item and shows the status;
  - a disabled item shows its reason.

## Left to the builder

The dialog layout, icons, how sizes and times are formatted, and whether the item id is the stamp plus the item name or a hash of it, as long as it's stable and path-safe.

## Out of scope

Emptying the trash, permanent delete, restoring `pre-restore-*` backup folders, and restoring `settings.json`.
