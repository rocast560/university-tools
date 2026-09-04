# Typst Studio: design

Date: 2026-09-03. Status: approved in conversation, ready for an implementation plan.

## 1. Goal

A single-user Windows desktop app for writing Typst reports with figures. It is
the Typst reporting feature of BTCT ("Been There, Conquered That",
`C:\Users\rober\Desktop\cptc-2026\BeenThereConqueredThat`) lifted out into its
own app, rebuilt on the architecture in `../../../../desktop-packaging.md`:

- a compiled Bun server (`tfs-server.exe`) on port 8090 that owns the data,
  the REST API, the MCP endpoint and backups;
- the React UI served by that server and shown in a WebView2 window;
- a Tauri 2 tray launcher ("University Tools") that starts the server at
  login, keeps it warm, and opens the window from a desktop icon.

Sources of truth for the port: BTCT's `src/components/typst/*`, `src/lib/typst-*`,
`src/lib/{asset-folders,asset-image,blur-math,crop-math,image-format,pane-resize}.ts`
and their tests, plus the old standalone "Typst Figure Studio" server recovered
from the `typst-editor:latest` Docker image (storage, router, events, backup,
MCP tool catalogue). BTCT is read-only source material; nothing there changes.

### Non-goals

Collaboration (Yjs), accounts and login, the admin panel, retention pruning, the
AI assistant, notes and pages, attack graphs. Anything in BTCT that is not the
Typst tab or the shared asset pipeline.

## 2. Repository layout

```
university-tools/
  advanced-typst-editor/        the app: server + UI + tests   (this spec lives here)
    server/                     Bun, TypeScript
    src/                        React 19, Vite 8, Tailwind 4, CodeMirror 6, typst.ts 0.7
    scripts/                    build-sidecar, fonts, import-legacy
    docs/superpowers/specs/
  launcher/                     Tauri 2 shell, Rust
    src-tauri/
      src/{main.rs, apps.rs, health.rs, tray.rs}
      binaries/tfs-server-x86_64-pc-windows-msvc.exe
      binaries/typst-x86_64-pc-windows-msvc.exe
      resources/typst/dist/**   the built UI (STATIC_DIR)
      icons/
    scripts/Install-Shortcuts.ps1
```

Product name "Typst Studio". The MCP server name stays `typst-figure-studio` and
the endpoint stays `http://localhost:8090/mcp`, because that is what Claude Code
is already registered against (`claude mcp list`); no re-registration needed.

## 3. Data on disk

Root: `DATA_DIR`, which the launcher sets to `%LOCALAPPDATA%\UniversityTools\typst\`.

```
<DATA_DIR>/
  workspaces/<Name>/            the library: workspaces the app created
  trash/<stamp>/<Name>/         a deleted library workspace (never unlinked)
  pre-restore-<stamp>/          copy of workspaces/ taken before a snapshot restore
  settings.json                 registry + settings (schema below)
  logs/server.log
```

### 3.1 A workspace is a folder

```
<workspace>/
  main.typ                      compile root; the editor opens this first
  *.typ, *.bib, *.csv, ...      any other file: mounted into the compiler, #include works
  assets/                       images. Subfolders allowed; the rail shows them as folders
  fonts/                        .ttf .otf .woff .woff2 .ttc, flat
  workspace.json                per-image crop/blur/size, per-font family (optional)
```

Rules:

- The Typst path of an image is `/assets/<relative path>`; of a font, `/fonts/<file>`.
  The browser compiler mounts the workspace folder as `/`, and the CLI runs with
  `--root <workspace>`, so both resolve paths identically.
- **Rail folders are real subdirectories of `assets/`.** This deliberately differs
  from BTCT, where folders were virtual and paths stayed flat. Moving or renaming
  an image moves the file and rewrites every reference in every `.typ` file
  with `retargetAssetPath()`. Deleting a rail folder moves its contents up one
  level (as in BTCT) and rewrites references the same way.
- Image bytes are never modified by the app. Crop and blur are render-time
  metadata in `workspace.json`, applied in the browser (canvas) and, for CLI
  builds, baked into a temporary copy (see 4.5).
- `workspace.json` is created on first crop, blur or font upload. A folder
  without one is a valid workspace.
- The asset id used by the API, the UI and MCP is the workspace-relative path
  (`assets/findings/login.png`, `fonts/Inter.ttf`); the Typst path is `/` + id.
  `workspace.json` keys are these ids. Byte caches are keyed by id + etag.

`workspace.json`:

```json
{
  "version": 1,
  "assets": {
    "assets/findings/login.png": {
      "crop":   { "x": 0.1, "y": 0, "w": 0.8, "h": 0.28 },
      "blurs":  [ { "x": 0.4, "y": 0.2, "w": 0.2, "h": 0.05, "style": "pixelate", "strength": 1 } ],
      "width":  1920, "height": 1080
    }
  },
  "fonts": { "fonts/Inter-Regular.ttf": { "family": "Inter" } }
}
```

Crop, blur and size semantics are exactly BTCT's `CropRect` / `BlurRegion`
(normalised to the original image; crop carries the figure box's aspect ratio
and may extend outside 0..1; blurs stay inside 0..1).

### 3.2 Registry and settings (`settings.json`)

```json
{
  "version": 1,
  "workspaces": [
    { "id": "uuid", "path": "C:\\Users\\rober\\AppData\\Local\\UniversityTools\\typst\\workspaces\\CPTC Report",
      "name": "CPTC Report", "group": "CPTC 2026", "library": true, "createdAt": 0, "openedAt": 0 },
    { "id": "uuid", "path": "C:\\Users\\rober\\Desktop\\cptc-2026\\cptc-typst-report",
      "name": "cptc-typst-report", "group": null, "library": false, "createdAt": 0, "openedAt": 0 }
  ],
  "backup": {
    "destinations": [
      { "id": "uuid", "path": "D:\\Backups\\typst", "mirror": true, "snapshots": true }
    ],
    "snapshotIntervalMin": 60,
    "keepSnapshots": 30
  },
  "typstCli": null,
  "redaction": { "style": "gaussian", "strength": 1 }
}
```

- `id` is minted at registration and is what the API, the UI and MCP use.
- `library: true` workspaces live under `DATA_DIR/workspaces/`. Renaming one
  renames its folder. Renaming an external one changes only `name`.
- `group` is a flat, one-level label (the old app's "folders"). It drives the
  sidebar grouping and the mirror tree `<dest>/<Group>/<Workspace>/`.
- On startup the server scans `DATA_DIR/workspaces/*` and registers any
  folder that is not in the registry, so a folder copied in by hand appears.
  An external workspace whose path is gone is listed as `missing` with
  "Locate" and "Forget" actions; it is never silently dropped.
- Deleting a library workspace moves its folder to `DATA_DIR/trash/<stamp>/`.
  Deleting an external workspace only forgets it.

## 4. Server (`advanced-typst-editor/server`, Bun + TypeScript)

Configured by environment only, as the packaging doc requires:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8090 | must stay 8090 for the MCP registration |
| `HOST` | 127.0.0.1 | loopback only, always |
| `DATA_DIR` | `./data` | see section 3 |
| `STATIC_DIR` | unset = API only | the built UI |
| `TYPST_CLI` | unset = auto | path to `typst.exe`; auto = sidecar next to the server exe, else `typst` on PATH |
| `APP_TOKEN` | unset = open | optional bearer for `/api` and `/mcp` |

The entry point is the only file that touches `Bun.serve`; every module is
plain `node:*` so it runs under Vitest.

### 4.1 Modules

| Module | One purpose |
|---|---|
| `config.ts` | env parsing, paths |
| `settings.ts` | `settings.json` read/write (atomic write-then-rename), registry ops, library scan |
| `workspace.ts` | one workspace folder: tree listing, file read/write/delete, `workspace.json` read/write, asset upload/rename/move/delete with reference rewriting, folder ops |
| `events.ts` | in-process bus; every writer emits; SSE route drains it |
| `watcher.ts` | `fs.watch` per registered workspace, 200 ms debounce, echo suppression for the server's own writes, emits `workspace.changed` |
| `compile.ts` | typst CLI driver: `compile` (diagnostics as JSON), `exportPdf` (bakes crop/blur into a temp copy first) |
| `bake.ts` | server-side crop/blur with `jimp` (pure JS), same maths as `src/lib/blur-math.ts` and `crop-math.ts` |
| `fonts.ts` | minimal `name`-table parser for ttf/otf/ttc family names (woff/woff2 need the family passed in) |
| `backup/mirror.ts` | plan + reconcile the mirror tree (ported from the old `backup.ts`, generalised to absolute destinations) |
| `backup/snapshot.ts` | zip snapshots (`fflate`), manifest with sha256, keep-last-N, restore |
| `backup/index.ts` | destinations, scheduling (debounce 1.5 s quiet / 10 s max after a change; snapshot timer), status |
| `fs-browse.ts` | drive + directory listing for the in-app folder picker |
| `mcp.ts` | official `@modelcontextprotocol/sdk` server over Streamable HTTP with sessions, so the UI can show connected clients |
| `mcp-stdio.ts` | the old stdio bridge, unchanged in spirit (for Claude Desktop) |
| `router.ts` | REST routes below |
| `static.ts` | serves `STATIC_DIR` with immutable cache headers for hashed assets |
| `index.ts` | wiring + `Bun.serve` |
| `cli.ts` | `import-legacy <dir>` (section 8) |

### 4.2 REST API

All JSON unless noted. `:id` is a workspace id; `*path` is a forward-slash path
relative to the workspace root and is rejected if it escapes.

```
GET    /api/health
GET    /api/events                                   SSE: workspace.changed, backup.state, mcp.clients
GET    /api/workspaces                               registry entries + status (ok | missing)
POST   /api/workspaces                               { name, group?, source? }   create in library
POST   /api/workspaces/open                          { path, name? }             register an external folder
PATCH  /api/workspaces/:id                           { name?, group? }
DELETE /api/workspaces/:id                           library: folder -> trash; external: forget
GET    /api/workspaces/:id                           entry + workspace.json + file tree (path, size, mtime)
GET    /api/workspaces/:id/files/*path               bytes, ETag = "<mtime>-<size>"
PUT    /api/workspaces/:id/files/*path               body = bytes; used by autosave
DELETE /api/workspaces/:id/files/*path
POST   /api/workspaces/:id/assets?filename=&folder=&kind=   body = bytes; returns the stored id
PATCH  /api/workspaces/:id/assets/*id                { crop?, blurs?, width?, height?, family?, stem?, folder? }
POST   /api/workspaces/:id/asset-folders             { path }
PATCH  /api/workspaces/:id/asset-folders             { path, newPath }
DELETE /api/workspaces/:id/asset-folders?path=       contents move up a level
POST   /api/workspaces/:id/compile                   { file? }        -> { ok, diagnostics[] }
POST   /api/workspaces/:id/export-pdf                { file?, to? }   -> { path, baked } or the PDF bytes when `to` is absent
GET    /api/settings          PATCH /api/settings     typstCli, redaction, layout
GET    /api/backup            PATCH /api/backup       destinations, interval, keep
POST   /api/backup/run                               mirror + snapshot now
GET    /api/backup/snapshots?destination=
POST   /api/backup/restore                           { destination, snapshot }
GET    /api/fs/browse?path=                          "" = drives; else subdirectories (+ isEmpty, isBackupRoot)
GET    /api/mcp/status
POST   /mcp   GET /mcp   DELETE /mcp
```

Uploads: max 25 MB; filename sanitised; extension corrected to match the bytes
(BTCT's `reconcileImageName`); de-duplicated within the target folder.

### 4.3 Reference rewriting

`retargetAssetPath()` from `src/lib/typst-placeholders.ts` is applied to every
`.typ` file in the workspace on asset rename, move and folder rename/delete.
The response reports how many references changed. The extension is never
renameable (Typst picks its decoder from it).

### 4.4 Change propagation

Every write (REST, MCP, watcher) ends up on the bus as
`workspace.changed { id, paths[], origin }` where `origin` is the REST caller's
`X-Client-Id`, `mcp`, or `disk`. The watcher suppresses events for a path the
server itself wrote within the last second (by path + resulting mtime) so an
autosave does not bounce back as a "changed on disk". The mirror scheduler
subscribes to the bus.

### 4.5 CLI compile and PDF export

- `compile`: `typst compile --root <ws> --font-path <ws>/fonts --ignore-system-fonts --diagnostic-format short <file> <tmp>.pdf`.
  `--ignore-system-fonts` keeps parity with the browser compiler, which sees
  only the bundled faces plus `fonts/`. Diagnostics are parsed into
  `{ severity, message, file, line, col }`.
- `exportPdf`: if any referenced image has a crop or blurs, the workspace is
  copied to a temp dir with those images baked (jimp), compiled there, and the
  temp dir removed. The result reports `baked: n` so a caller can see that
  redactions were applied. Without a CLI the route returns 409 with a message;
  the browser export path (typst.ts, identical to the preview) is unaffected.
- typst 0.14.2 is the pinned CLI (matches typst.ts 0.7). The launcher bundles it
  as a sidecar; `TYPST_CLI` overrides.

### 4.6 MCP

Official SDK, Streamable HTTP, stateful sessions (`Mcp-Session-Id`) so
`GET /api/mcp/status` can list connected clients by `clientInfo.name` for the
header light. Auth = `APP_TOKEN` if set. Tools (27):

| Group | Tools |
|---|---|
| workspaces | `list_workspaces`, `get_workspace` (entry, tree, assets, slots), `create_workspace`, `open_workspace_folder`, `rename_workspace`, `move_workspace` (group), `delete_workspace` |
| source | `get_source` (file defaults to main.typ), `set_source`, `edit_source` (exact match; must occur once unless `replace_all`; returns count) |
| figures | `list_slots`, `add_slot`, `place_image`, `clear_slot`, `set_slot_height` |
| assets | `list_assets`, `upload_asset` (from an absolute path on disk **or** base64; `folder?`), `rename_asset`, `move_asset`, `update_asset` (crop / blurs / width / height), `delete_asset`, `add_font` (path or base64, `family?`) |
| build | `compile` (diagnostics), `export_pdf` (`to` path; reports `baked`) |
| backup | `backup_status`, `run_backup`, `list_snapshots` |

Every write goes through the same `workspace.ts` functions the REST routes use,
stamped `origin: 'mcp'`, so an MCP edit shows up live in an open window.
Figure tools use the pure helpers in `typst-placeholders.ts` in the same order
the UI does. Tool descriptions are the old catalogue's, adjusted for paths.

### 4.7 Backups

Settings: any number of destinations, each an absolute path anywhere on the
machine (the requirement), chosen with the in-app folder browser or typed.
Per destination: `mirror` and `snapshots` toggles.

**Mirror** (`backup/mirror.ts`), after any change settles:

```
<dest>/
  .typst-studio-backup.json     marker: this folder is ours to reconcile
  README.txt
  <Group>/<Workspace>/main.typ, assets/, fonts/, workspace.json, ...
  <Loose workspace>/...
  _trash/<stamp>/...            anything stale; nothing is ever unlinked
  snapshots/                    see below; excluded from reconcile
```

- A destination is accepted only if it is empty or already carries the marker.
  This is what stops a mis-click from reconciling the Documents folder.
- Files are compared by length + bytes before writing so a synced folder does
  not churn.
- Images in the mirror are the originals; `workspace.json` carries the
  framing. README says so (the old app's warning text).
- Missing external workspaces are skipped, not trashed.

**Snapshots** (`backup/snapshot.ts`): every `snapshotIntervalMin` (default 60),
if the content digest changed since the last snapshot, write
`snapshots/typst-snapshot-YYYYMMDD-HHMMSS.zip` (every workspace, library and
external, laid out as the mirror) plus an embedded `manifest.json`
(`createdAt`, app version, per-file sha256). Keep the newest `keepSnapshots`
(default 30). "Run now" does both mirror and snapshot regardless of digest.

**Restore**: pick a destination + snapshot. The server copies
`DATA_DIR/workspaces` to `DATA_DIR/pre-restore-<stamp>/`, verifies the
manifest checksums, then unpacks library workspaces into `workspaces/` and
external ones into `workspaces/restored-<stamp>/<name>/` (an external folder
is never overwritten). Open windows reload via the bus.

### 4.8 Folder browser

`GET /api/fs/browse` returns drives (letters that exist) at the root and
directories one level down otherwise, each with `isEmpty` and `isBackupRoot`
(marker present). Hidden and unreadable directories are omitted. Opening a
folder as a workspace refuses a drive root, `DATA_DIR` itself, and a folder
with more than 5,000 entries (that is not a report).

## 5. Frontend (`advanced-typst-editor/src`)

Stack identical to BTCT so components port with minimal edits: React 19, Vite 8
(`optimizeDeps.exclude` for the typst.ts packages, `?url` wasm imports),
Tailwind 4, Radix primitives, lucide icons, CodeMirror 6, typst.ts 0.7,
zustand.

### 5.1 Ported as-is (with import path changes only)

`lib/typst-compiler.ts`, `typst-geometry.ts`, `typst-language.ts`, `typst-pages.ts`,
`typst-placeholders.ts`, `typst-search.ts`, `typst-source-map.ts`, `crop-math.ts`,
`blur-math.ts`, `image-format.ts`, `pane-resize.ts`; components `TypstPreview`,
`TypstSearchPanel`, `FigureViewport`, `PlaceScreenshotDialog`, `Portal`,
`ConfirmDialog`; the `index.css` design tokens (dark theme only; the glass skin
and theme picker are not ported).

### 5.2 Ported with changes

- `TypstEditor`: drop `yCollab`, `Y.UndoManager`, awareness. Plain CodeMirror
  state with `history()`. Emits `onChange`; autosave PUTs the file 500 ms after
  the last edit, on blur, and on `pagehide` (`fetch` with `keepalive`).
- `TypstView`: the `Y.Text` source hook becomes a `useWorkspaceFile(id, path)`
  hook backed by the API + SSE. Adds a file switcher in the editor header for
  other `.typ` files in the folder. Mounts every workspace file into the
  compiler (`setTypstShadowFiles`), images through `resolveAssetBytes` with
  crop/blur, fonts from `fonts/`.
- `TypstAssetsPanel`: the `AssetFolder {id, parentId, name}` records it renders
  are derived on the client from the `assets/` directory tree (id = relative
  path), so the tree, drag-and-drop and breadcrumb code stay intact. Actions
  call the asset routes instead of the Yjs store. Standalone "Assets Manager"
  mode is not ported; the rail's expand-over-the-tab mode covers it.
- `lib/typst-assets.ts`: `fetchAssetBytes(id, etag)`; cache keys include the
  ETag. `uploadAsset` targets the new route.
- `lib/asset-folders.ts`: keep the pure tree helpers and `matchAssetByHref`;
  add `foldersFromTree()`.
- Store: one zustand store (`workspace-store.ts`) holding the registry, the
  active workspace, its tree and `workspace.json`, assets, backup state and
  MCP status; fed by the API and the SSE stream.
- Pane layout persists in the browser's localStorage (WebView2 keeps it per
  app); `pane-resize.ts` is ported unchanged.

### 5.3 New

- `Sidebar`: workspaces grouped by `group`, New, Open folder, Settings, MCP
  status light, last-backup line.
- `FolderBrowserDialog`: breadcrumb + list from `/api/fs/browse` + a path input.
- `SettingsView` (modal): Backups (destinations, toggles, interval, keep-N, Run
  now, snapshot list, Restore with confirmation), MCP (endpoint, connected
  clients, stdio snippet, token), Typst CLI path, Redaction default
  (style + strength; stamped onto new regions as in BTCT), Data folder.
- `DiskChangeBar`: shown when `workspace.changed` names the open file while the
  buffer is dirty: Reload / Keep mine. When the buffer is clean the content is
  replaced silently, preserving the caret where possible.

## 6. Launcher (`launcher/`, Tauri 2)

Built exactly as `desktop-packaging.md` section 3 describes, with an apps table:

```rust
pub struct AppSpec { id: &'static str, title: &'static str, port: u16, health: &'static str,
                     sidecar: &'static str, window: (f64, f64), env: fn(&AppHandle) -> Vec<(String, String)> }
pub const APPS: &[AppSpec] = &[ AppSpec { id: "typst", title: "Typst Studio", port: 8090,
    health: "/api/health", sidecar: "tfs-server", window: (1400.0, 900.0), env: typst_env } ];
```

- `typst_env` sets `PORT=8090 HOST=127.0.0.1 DATA_DIR=%LOCALAPPDATA%\UniversityTools\typst
  STATIC_DIR=<resource>/typst/dist TYPST_CLI=<sidecar typst.exe>`.
- Plugins: `tauri-plugin-shell` (sidecars), `tauri-plugin-single-instance`
  (forwards `--open <id>`), `tauri-plugin-autostart` (`--minimized`);
  `win32job` puts children in a kill-on-close Job Object; `RunEvent::Exit`
  kills them explicitly too.
- Tray: one "Open <title>" item per app, "Start at login" toggle, Quit.
- Windows are created from Rust only after `/api/health` returns 200 (poll
  every 100 ms, 20 s limit, then show an error page with the log path).
  Close hides; `ExitRequested` is prevented.
- No `--open` and no `--minimized` opens the first app (today: Typst).
- Bundle: NSIS, per-user install, `externalBin` = the two sidecars,
  `resources` = `resources/typst/dist/**`. Icons generated with
  `cargo tauri icon` from `launcher/icon.svg`.
- `scripts/Install-Shortcuts.ps1`: creates `Typst Studio.lnk` on the Desktop
  pointing at the installed exe with `--open typst` and the Typst icon.
  Re-runnable. (The NSIS installer already adds the Start menu entry.)

## 7. Build pipeline

```
advanced-typst-editor:
  bun install
  bun run fonts            # copies the 17 default typst.ts font assets into public/fonts (as before)
  bun run test             # vitest: src + server
  bun run build            # tsc -b && vite build  -> dist/
  bun run build:sidecar    # bun build --compile --minify --bytecode --target=bun-windows-x64 server/index.ts
                           #   --outfile ../launcher/src-tauri/binaries/tfs-server-x86_64-pc-windows-msvc.exe
                           # then copies dist/ -> ../launcher/src-tauri/resources/typst/dist
launcher:
  copy typst.exe (0.14.2) -> src-tauri/binaries/typst-x86_64-pc-windows-msvc.exe
  cargo tauri build        # -> src-tauri/target/release/bundle/nsis/*.exe
  scripts/Install-Shortcuts.ps1
dev:
  bun run dev:server       # bun --watch server/index.ts  (DATA_DIR=./data, STATIC_DIR unset)
  bun run dev              # vite on 5173, proxies /api and /mcp to 8090
```

If `--bytecode` is rejected for the ESM entry, drop it and record the measured
start time either way (doc section 8).

## 8. Migration and cutover

1. Extract the old data volume: run the `typst-editor:latest` image with
   `typst-editor_tfs-data` mounted and copy `/data` to a scratch folder.
2. `bun run server/cli.ts import-legacy <scratch>/data`: each
   `documents/<uuid>.json` becomes `DATA_DIR/workspaces/<safe name>/` with
   `main.typ`, `assets/<filename>`, `fonts/<filename>` from `blobs/`, and a
   `workspace.json` carrying crop, blurs, width, height and fontFamily; the
   document's folder name becomes `group`. Name collisions get ` (2)`.
3. Stop and remove the `typst-editor` container (it maps 8090 and would fight
   the sidecar on Docker restart). The volume is kept.
4. Register nothing: the existing `typst-figure-studio` MCP entry already
   points at the right URL.

## 9. Testing

Vitest, one config, two environments (`jsdom` for `src`, `node` for `server`).

- Ported unchanged: `typst-placeholders`, `typst-geometry`, `typst-search`,
  `typst-source-map`, `typst-pages`, `crop-math`, `blur-math`, `image-format`,
  `asset-folders`, `pane-resize`.
- New server tests, each against a temp `DATA_DIR`: settings registry and
  library scan; workspace tree/read/write/path-escape rejection; asset upload
  (sanitise, extension fix, de-dupe), rename/move with reference rewriting
  across several `.typ` files, folder delete moving contents up; watcher echo
  suppression; mirror plan (name collisions, groups, loose workspaces) and
  reconcile (`_trash`, marker refusal, byte-identical skip); snapshot manifest,
  keep-N, restore into `pre-restore` + `restored-<stamp>`; `fs-browse` path
  handling; bake (crop + blur output size and that blurred text is destroyed,
  via a rendered-text fixture); compile diagnostics parser; each MCP tool
  through the in-process handler; legacy import on a fixture copied from the
  real volume.
- Launcher: manual, against the checklist in `desktop-packaging.md` section 8,
  with the numbers recorded in the README.

## 10. Decisions

| Decision | Why |
|---|---|
| Plain folder per workspace | user choice; readable by git, VS Code and the CLI; backup is a copy |
| Rail folders = real subdirectories | a virtual tree that disagrees with Explorer would be confusing in a folder-based model |
| Drop Yjs | single-user desktop app; collaboration would need a WebSocket server and CRDT persistence for no user |
| Bun sidecar owns MCP and backups | packaging doc; MCP must outlive the window; most code reuse |
| typst CLI for server-side compile | window may be closed; jimp bakes redactions so an MCP-exported PDF never leaks a blurred secret |
| `--ignore-system-fonts` | parity with the browser compiler |
| Port 8090, name `typst-figure-studio` | existing Claude Code registration |
| Mirror refuses non-empty, non-marked folders; nothing unlinked | the one rule that keeps a backup from eating data |
| Snapshots include external workspaces, restore never overwrites them | external folders are the user's, not ours |
