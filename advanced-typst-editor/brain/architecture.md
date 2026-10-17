---
type: reference
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f (advanced-typst-editor/ working tree)
covers: advanced-typst-editor/server, advanced-typst-editor/src, advanced-typst-editor/Dockerfile, advanced-typst-editor/docker-compose.yml
description: How Typst Studio fits together: one Bun process (REST, SSE, MCP, backup, watcher), the workspace registry in settings.json, the in-browser compile worker, per-page preview, the server-side typst CLI used by MCP and PDF export, own-write suppression, and data flow for a save, an MCP edit and a workspace switch.
---
# Architecture

Contents: Processes, Data on disk, Server wiring, Change propagation, Compile paths, Frontend, MCP, Backup, Data flows.

## Processes

One server process (`bun server/index.ts`) does everything on the backend: REST (`/api/*`), SSE (`/api/events`), MCP (`/mcp`), static hosting of `dist/`, the file watcher and backups. The browser runs the React app and compiles Typst itself in a Web Worker.

- **Deployed:** Docker container `typst-studio`, host `127.0.0.1:8090` mapped to container `8080`. See [environment](environment.md).
- **Dev:** `bun --watch server/index.ts` on 8090 plus Vite on 5173, which proxies `/api` and `/mcp` ([vite.config.ts](../vite.config.ts)).
- **Desktop shell (separate app):** `../launcher` is a Tauri tray launcher that starts a compiled server sidecar. Built from `scripts/build-sidecar.ts`. Whether it is in use today is unconfirmed ([open questions](open-questions.md)).

## Data on disk

`DATA_DIR` (`./data` in dev, `/data` in the container). Contents are the user's private documents; do not read them.

```
data/settings.json        the registry: workspaces, groups (folders), folderMeta, backup, typstCli, redaction
data/workspaces/<Name>/   library workspaces: main.typ, assets/, fonts/, workspace.json (optional)
data/trash/<stamp>/       deleted library workspaces (moved, never unlinked)
```

A workspace is a plain folder. Images are `assets/**`, fonts are `fonts/*`, and `workspace.json` holds per-image crop, blur and size plus per-font family. Typst paths are `/assets/...` and `/fonts/...`. A workspace can also be an external folder (`library: false`), registered by absolute path and never moved or deleted by the app. Spec: [design](../docs/superpowers/specs/2026-09-03-typst-studio-design.md) section 3.

**The registry self-heals paths.** `settings.json` records absolute paths. A library entry whose folder is missing is re-pointed to `<workspacesDir>/<name>` when that exists, so one `data/` works under Windows paths and under `/data` ([settings.ts](../server/settings.ts) `scanLibrary()`).

**Folders are paths.** A sidebar folder id is its path (`School/ECE-2300L`), max depth 4. `WorkspaceEntry.group` is that path or null. Helpers are shared by browser and server in [folder-tree.ts](../src/lib/folder-tree.ts).

## Server wiring

[server/index.ts](../server/index.ts) builds the pieces in order and passes them as plain dependencies (no globals): `loadConfig` -> `createEventBus` -> `createSettingsStore` -> `createWatcher` -> `createWorkspaceService` (then `service.boot()`) -> `createCompiler` -> `createBackup` -> `createMcp` -> `createHandler` -> `Bun.serve`.

| Piece | Job |
|---|---|
| `settings.ts` | registry in memory, written atomically; `get()` re-reads only when the file's mtime moves; `touchWorkspace()` writes `openedAt` after 2 s quiet; SIGINT/SIGTERM flush it |
| `service.ts` | all workspace operations; emits every change on the bus; owns validation (folder depth, collisions) |
| `workspace.ts` | `openWorkspace(root)` returns a `WorkspaceFs`: files, assets, `workspace.json`, reference rewriting |
| `workspace-index.ts` | in-memory snapshot of a folder (files, meta, assets, etag); rebuilt after 30 s or when told |
| `watcher.ts` | recursive `fs.watch` per workspace, 200 ms debounce, own-write suppression |
| `router.ts` | `/api` routes, bearer auth (`APP_TOKEN`), ETag/304 on detail and file reads |
| `mcp.ts`, `mcp-tools.ts` | MCP over Streamable HTTP, sessions with a 30 min TTL; the tool catalogue |
| `mcp-stdio.ts` | stdio bridge that forwards to `/mcp`, for Claude Desktop |
| `compile.ts`, `bake.ts` | typst CLI compile, preview PNG, PDF export with redactions baked by jimp |
| `backup/` | mirror and snapshots |

The router is keyed on the path segments, decoded one by one, so `/api/groups/School%2FLabs` arrives as the single segment `School/Labs`.

## Change propagation

Every write ends on the event bus ([events.ts](../server/events.ts)) as `workspace.changed {id, paths, origin}`. `origin` is the REST caller's `x-client-id`, `'mcp'`, or `'disk'`. Other events: `workspaces.changed` (registry), `backup.state`, `mcp.clients`. The bus feeds three listeners:

1. **SSE** (`GET /api/events`, 25 s keepalive) to every open tab. The client reconnects with backoff ([events.ts](../src/api/events.ts)).
2. **The workspace index**, which patches or invalidates its snapshot.
3. **The backup scheduler**, which mirrors after a quiet period.

**Own-write suppression.** Before the server writes a file it calls `watcher.markOwnWrite()`, so the filesystem echo is not reported again as a disk change. The mark matches by path, then by resulting mtime, for 1.5 s ([watcher.ts](../server/watcher.ts)). Without it every autosave would bounce back as "changed on disk".

**Reference rewrites have no author.** When an asset rename, move or folder change rewrites `.typ` sources, the `meta` part keeps the caller's origin but the rewritten files go out with `origin: null`, so every tab, including the caller's, treats them as external. Reason is the long comment above `rewrote()` in [service.ts](../server/service.ts).

## Compile paths

Two independent compilers, same Typst version family (typst.ts 0.7 in the browser, typst CLI 0.14.2 on the server).

- **Browser (what the user sees):** `typst-compiler.ts` talks to a module Web Worker (`typst-compiler.worker.ts`) that owns one typst.ts compiler and renderer (`typst-compiler.driver.ts`). One wasm instance per page. Fonts swap with `setFonts` instead of rebuilding. Calls are serialised and a superseded preview returns `superseded` without work. Without `Worker` (jsdom) the driver runs inline. Browser PDF export uses `compileTypstPdf`.
- **Server (MCP and REST):** `compile.ts` runs `typst compile --root <ws> --ignore-system-fonts --font-path <ws>/fonts`. Used by MCP `compile`, `export_pdf`, `render_preview`, and by `POST /api/workspaces/:id/compile` and `/export-pdf`. `export_pdf` first copies the workspace to a temp folder and bakes crop and blur into PNG/JPEG images (`bake.ts`), because the CLI cannot apply them. GIF, WebP and SVG with crop or blur are refused (HTTP 422) rather than exported unredacted.

Only the fonts in `public/fonts` (Libertinus Serif, New Computer Modern, DejaVu Sans Mono) plus a workspace's `fonts/` exist for both compilers ([gotchas](gotchas.md)).

## Frontend

React 19, zustand, Tailwind 4, CodeMirror 6 (lazy chunk). Entry: [App.tsx](../src/App.tsx), state: [stores/index.ts](../src/stores/index.ts).

- **Tab layout:** `TypstView` = editor | preview | assets rail. The editor is driven only through [typst-editor-bridge.ts](../src/components/typst/typst-editor-bridge.ts) so no one else imports CodeMirror.
- **Source text:** `use-workspace-file.ts` loads, edits locally, autosaves 500 ms after the last change, on blur and on pagehide. An external `workspace.changed` for the open file reloads it when clean, or raises `DiskChangeBar` when dirty.
- **Preview:** `TypstPreview` debounces 350 ms, compiles to one SVG, and `typst-pages.ts` splits it into per-page fragments. Pages mount lazily inside a shadow root with its own small stylesheet; unchanged pages keep their DOM. A failed compile shows a banner over the last good render.
- **Click to source:** `TypstPreview` hit-tests the clicked `tsel` run (typst.ts emits a hidden text layer) and hands `onRevealSource` a `SourceClick`: page, run index, the page's runs, the previous match as a hint, and the old candidate list as a lazy fallback. `typst-source-map.ts` `resolveSourceClick` first runs `resolveClick`: `projectSource` (memoised per source text) turns the source into its visible text with a source offset per character (a hand-written scanner, no CodeMirror; `#set`/`#let`/comments dropped, `--` and quotes folded, `#var`, helper calls, math, `@ref` and `{{X}}` as wildcards, design-statement text in a second layer), then a banded local alignment of the clicked run plus neighbours against it, seeded by a 4-gram index, picks the place by context (widening the window and then a position prior break ties). If that finds nothing it falls back to `findSourceRange`, the old progressive text search. Measured hit rate 98.3% against 83.5% for the old search on the fixture corpus, about 0.4 ms per click ([research](../docs/research/2026-10-17-preview-source-mapping.md), [spec](../docs/superpowers/specs/2026-10-17-preview-source-mapping-phase1-design.md), [decisions](decisions.md) D11, D27). Real source spans are still not available from this compile path.
- **Assets:** `typst-assets.ts` fetches bytes, applies crop and blur on a canvas, and mounts the result into the compiler's virtual filesystem under the asset's own path. `typst-mount.ts` decides which files mount.
- **Switching:** `workspace-cache.ts` keeps detail, text and last render per workspace; `prefetch.ts` warms them on hover (80 ms intent) and when idle. Revalidation uses ETag/If-None-Match. Details: [features](features.md).

## MCP

Server name `typst-figure-studio`, endpoint `/mcp`. Tools are plain objects in `TOOLS` ([mcp-tools.ts](../server/mcp-tools.ts)) with Zod schemas, registered per session. Groups: workspaces (`list_workspaces`, `get_workspace`, `create_workspace`, `rename_workspace`, `move_workspace`, `delete_workspace`), source (`get_source`, `set_source`, `edit_source`), figure slots (`list_slots`, `add_slot`, `place_image`, `clear_slot`, `set_slot_height`), assets (`list_assets`, `upload_asset`, `add_font`, `rename_asset`, `move_asset`, `update_asset`, `delete_asset`), build (`compile`, `export_pdf`, `render_preview`), backup (`backup_status`, `run_backup`, `list_snapshots`). All MCP writes carry `origin: 'mcp'`. **Path arguments (`upload_asset`, `add_font`, `export_pdf`) are read or written by the server process, so in Docker they are container paths** ([gotchas](gotchas.md)). A figure slot is a call to the `image-placeholder` helper ([typst-placeholders.ts](../src/lib/typst-placeholders.ts)); the starter document defines it ([template.ts](../src/template.ts)).

## Backup

[backup/index.ts](../server/backup/index.ts) subscribes to the bus and, after 1.5 s quiet (10 s max wait), runs:
- **Mirror** (`mirror.ts`): per destination, folders nested like the sidebar. A destination is accepted only if empty or carrying the marker file `.typst-studio-backup.json`. Nothing is ever unlinked; stale items move to `_trash/<stamp>/`. Images are the originals (redactions are not baked). The registry (`settings.json`) and `data/logos/` go to `.typst-studio/` at the mirror root (reserved name, so a folder called that becomes `.typst-studio (2)`); a changed copy moves to `_trash/<stamp>/` first.
- **Snapshots** (`snapshot.ts`): a zip plus manifest with sha256 per file, every `snapshotIntervalMin` (default 60) when the content digest changed, newest `keepSnapshots` (default 30) kept. Snapshots also hold `.typst-studio/` (manifest `registry`, checksummed). Restore copies the current library to `pre-restore-<stamp>` first, then copies back any missing logo its workspaces reference; `settings.json` is never restored automatically.

## Data flows

**A keystroke:** editor -> `useWorkspaceFile` (500 ms) -> `PUT /api/workspaces/:id/files/main.typ` -> `service.writeFile` (marks own write, emits `workspace.changed` with the tab's client id) -> SSE echo is ignored by that tab; other tabs reload; index patches one file; backup schedules.

**An MCP edit:** `edit_source` -> `service.writeFile(..., 'mcp')` -> same bus event with origin `mcp` -> open tabs reload the file (or show the disk-change bar if dirty) -> preview recompiles.

**A workspace click:** `selectWorkspace` shows cached detail at once, revalidates with the etag, restores the cached render, compiles once when assets are mounted (`ready`). Revisits were measured at under 100 ms to 0.3 s ([spec](../docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md) section 6).
