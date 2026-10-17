---
type: reference
status: active
updated: 2026-10-17
verified: 2026-10-17
source: audit of server/, server/backup/, src/lib/, Dockerfile, docker-compose.yml and server/test-util.ts on 2026-10-17 (no git sha; read-only audit)
covers: advanced-typst-editor/server, advanced-typst-editor/src/lib, advanced-typst-editor/docker-compose.yml
description: Data-safety rule of thumb for Typst Studio, where user data lives, how every delete and overwrite works today and the way back, an audit table with risk levels, a one-minute checklist for disk and registry changes, and when to call the typst-data-guard agent.
---
# Data safety

Contents: Rule of thumb, Where data lives, How deletion works today, Audit table, Dev-process hazards, Checklist, When to call the guard agent.

## Rule of thumb

The user asked that nothing in this app be deleted, and that development not slow to a crawl over it. So this is a habit, not a gate.

- A delete should move to a place the user can reach (trash, snapshot, `_trash`), not unlink.
- An overwrite of user content should leave a way back: an earlier copy, a snapshot, or a write-then-rename so a crash cannot leave half a file.
- Registry (`settings.json`) writes go through `writeAtomic`. Never write it with a bare `writeFileSync`.
- Tests use `tmpDir()` from `server/test-util.ts`. Never point anything at `data/`.
- If a change touches the server's fs, the registry, backup or an MCP write tool, spend one minute on the checklist below.
- If you find a destructive path while working, note it in [open questions](open-questions.md). Don't stop to fix it unless it is your change.
- UI-only work needs none of this.

## Where data lives

| What | Where | Notes |
|---|---|---|
| Registry: workspaces, folders (`groups`), `folderMeta` (icon, colour), backup destinations, redaction defaults | `data/settings.json` (+ `.bak`, `.corrupt-<stamp>`) | losing it loses folders and folder looks, not documents; `.bak` is the previous good copy |
| Sidebar logos (uploaded PNG, JPEG, WebP, SVG, 512 KB max) | `data/logos/<random>.<ext>` | written with `writeAtomic`, never deleted: clearing or replacing a logo only unlinks it in the registry (`appearance.logo`, `folderMeta[path].logo`); not in the backup mirror or snapshots (they live outside workspace folders) |
| Documents: `main.typ` and other files | `data/workspaces/<Name>/` | plain folders; external workspaces live anywhere and are never moved or deleted by the app |
| Assets and fonts | `<ws>/assets/**`, `<ws>/fonts/*` | originals; crop and blur are never baked into them |
| Crop, blur, size, font family | `<ws>/workspace.json` | atomic writes; losing it loses framing and redactions, not the images |
| Trash | `data/trash/<stamp>/<WorkspaceName>/` | whole deleted library workspaces, and single deleted files or assets at their relative path inside it; no restore UI or API, restore is a manual move (plus a registry add for a workspace) |
| Backup mirror | each destination (`/host` in Docker) | latest copy, `_trash/<stamp>/` for stale items, marker `.typst-studio-backup.json` |
| Snapshots | `<dest>/snapshots/*.zip` | sha256 per file, newest `keepSnapshots` (30) kept |
| Pre-restore copies | `data/pre-restore-<stamp>/` | copy of `workspaces/` made before a snapshot restore; never pruned |
| Browser prefs | localStorage `tfs-active-workspace`, `tfs-collapsed-groups`, `tfs-sidebar-collapsed`, `tfs-preview-lock`, pane layout, `tfs-perf` | layout only; losing them costs nothing important |

## How deletion works today, and the way back

- **Delete a library workspace** (`service.remove`): the folder is renamed into `data/trash/<stamp>/`, then the registry entry is dropped. An external folder is only forgotten. Way back: manual move out of trash.
- **Delete a sidebar folder** (`removeGroup`): members become loose; the folder's icon and colour are dropped. Documents untouched.
- **Delete an asset or a file** (`toTrash` in `workspace.ts`): moved to `data/trash/<stamp>/<WorkspaceName>/<relative path>`. Way back: move it back by hand. If `openWorkspace` is given no `trash` option, delete throws instead of unlinking.
- **Overwrite a source file** (`set_source`, `edit_source`, autosave, REST PUT): atomic write, no history. Way back: snapshots (hourly, only when content changed) and the mirror (latest copy only). There is no per-save undo on disk.
- **Backup mirror**: never unlinks; stale items move to `_trash/<stamp>/`. Changed files are overwritten in place by design.
- **Snapshot prune**: unlinks zips beyond the newest 30.
- **Snapshot restore**: copies `workspaces/` to `data/pre-restore-<stamp>/` first, then overwrites files in matching workspaces. Does not copy `settings.json`.

## Audit table (2026-10-17)

Risk: none, low, real. Line numbers are from this audit and drift.

| Operation | Where | Destroys | Way back | Risk |
|---|---|---|---|---|
| Delete library workspace (REST, MCP `delete_workspace`) | `service.ts:247` | nothing (moved to trash) | `data/trash` (manual) | none |
| Delete external workspace | `service.ts:247` | registry entry only | re-add by path | none |
| Rename workspace | `service.ts:172` | nothing; `uniqueDirName` avoids collision | rename back | none |
| Delete sidebar folder | `settings.ts:262` | folder, icon, colour | none for the look | low |
| Delete asset or font (`delete_asset`, REST) | `workspace.ts` `deleteAsset` | its crop/blur entry only; the file moves to `data/trash/<stamp>/<ws>/<path>` | trash (manual move back; crop/blur must be redone) | low (fixed 2026-10-17) |
| Delete file (REST `DELETE .../files/*`) | `workspace.ts` `deleteFile` | nothing; the file moves to the same trash path (also for `main.typ`) | trash | none (fixed 2026-10-17) |
| Delete asset folder | `workspace.ts:372` | nothing; contents are renamed up first, then empty dir removed | none needed | none |
| Overwrite source (`set_source`, `edit_source`, autosave) | `workspace.ts:402` | previous text | snapshot, mirror | low |
| `clear_slot`, `place_image` | `mcp-tools.ts:90,96` | one slot's `path:` in the source | snapshot, mirror | low |
| `update_asset` | `mcp-tools.ts:113` | previous crop/blur values | none | low |
| Move or rename asset, move asset folder | `workspace.ts:327` | nothing; rewrites `.typ` references | rename back | none |
| Reference rewrite across `.typ` files | `service.ts` `rewrote()` | old text of every file that mentions the asset | snapshot, mirror | low |
| Registry rewrite (`write`) | `settings.ts` `write` | previous registry | `settings.json.bak` (one rolling copy, taken only if the current file parses) | low (fixed 2026-10-17) |
| Registry read of a corrupt file | `settings.ts` `load` | nothing; the bad file is copied to `settings.json.corrupt-<stamp>`, then `settings.json.bak` is tried, then `{}` | `.corrupt-*` and `.bak` beside `settings.json` | low (fixed 2026-10-17) |
| `export_pdf` `to` path | `compile.ts` `checkExportTarget` | an existing `.pdf` at that path only; non-`.pdf` and `data/trash` targets get a 400 | previous PDF is gone (re-export) | none (fixed 2026-10-17) |
| Mirror write over changed files | `backup/mirror.ts:144` | the previous backup copy | snapshots | low |
| Mirror trash move | `backup/mirror.ts:120` | nothing | `_trash` | none |
| Snapshot prune | `backup/snapshot.ts:94` | zips older than the newest 30 | none | low |
| Snapshot restore | `backup/snapshot.ts:122` | current text of matching files | `pre-restore-<stamp>` | low |
| `pre-restore-*` and `trash/` | `backup/snapshot.ts`, `service.ts` | nothing; never pruned | n/a | none (grows) |
| Legacy import | `legacy-import.ts` | creates only | n/a | none |
| Temp dir cleanup (`rmSync` in compile, fonts) | `compile.ts`, `fonts.ts` | temp copies only | n/a | none |
| localStorage prefs | `src/lib/*` | layout and flags | n/a | none |

### The real risks (all three fixed 2026-10-17; text kept for history)

1. **Corrupt `settings.json` reads as empty, then gets overwritten.** `readJson` returns `{}` on a parse error, `normalise` makes an empty registry, and the first write (even a 2 s `openedAt` touch) saves it. Folders, folder looks and backup destinations are lost. Library workspaces come back through `scanLibrary`, ungrouped; external ones do not. No backup of the registry exists, and snapshots do not contain it. Likely triggers: a hand edit, or the dev backend and the container writing at once.
2. **Asset and file delete are permanent unlinks.** `delete_asset` is one MCP call. If no backup destination is set, there is no way back.
3. **`export_pdf` `to` overwrites any absolute path.** In Docker that includes `/data/settings.json` or a workspace file. Only a mistaken argument triggers it.

## Dev-process hazards

- **Tests:** server tests use `tmpDir()` and pass it as `dataDir`; nothing in `server/*.test.ts` or `src/test` reads `loadConfig()` or `./data`. `legacy-import.test.ts` only reads `OLD` (`recovered-from-docker`). Keep it that way.
- **Default `DATA_DIR` is `./data` relative to the cwd.** `bun server/index.ts` from the wrong folder starts on an empty registry in a new folder. Harmless, but confusing.
- **Dev backend and the container share `data/`.** Both write `settings.json` (path forms differ). Never run both on 8090. See [gotchas](gotchas.md).
- **`docker compose down -v`:** the compose file uses bind mounts, not named volumes, so `-v` does not delete `./data`. Still do not run `docker volume prune` or `rm -rf data`.
- **`bash` from PowerShell or Node is WSL.** A test once wiped a WSL home. Use the Git Bash tool only.
- **MCP paths are container paths.** A host path passed to `export_pdf` writes inside the container.

## Before you ship a change that touches disk or the registry

A minute, not a review:

1. Does anything here unlink, `rmSync`, or rename over an existing path? If yes, can it move to trash instead?
2. Does it overwrite user content? Is there a snapshot, mirror copy or earlier file to get back to?
3. Does a registry write go through `writeAtomic` and keep unknown fields? Could a bad read turn into an empty write?
4. Could a path argument point outside the workspace? Is it checked with `resolveInside`?
5. Does an old `settings.json` or `workspace.json` still load unchanged?
6. Do the tests use `tmpDir()` and never `data/`?

## When to call the guard agent

Run `typst-data-guard` (user-level agent) on a diff that touches the server's fs code, the registry (`settings.ts`), `backup/`, migrations, any delete or overwrite path, or the MCP write tools. Give it the diff or the paths. Not for UI-only work, copy changes, styling or tests of pure `src/lib` math. It returns SAFE, SAFE WITH NOTES or RISK and never edits.
