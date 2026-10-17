---
type: reference
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f (advanced-typst-editor/ working tree)
covers: advanced-typst-editor/server, advanced-typst-editor/src, advanced-typst-editor/scripts, advanced-typst-editor/public
description: File-by-file map of Typst Studio, server and frontend, with each file's job and the test that covers it; where to look for registry, watcher, compile, MCP tools, backup, preview, assets, crop and blur, sidebar folders; the Docker import boundary.
---
# Code map

Contents: Top level, Server, Frontend lib, Frontend components, Tests with no matching file, Import boundary.

Paths are relative to `advanced-typst-editor/`. Tests live in `server/*.test.ts` (next to the file) and `src/test/*.test.ts(x)`. Run them with [environment](environment.md). Behaviour is explained in [architecture](architecture.md); features in [features](features.md).

## Top level

| Path | What |
|---|---|
| [package.json](../package.json) | scripts: `dev`, `dev:server`, `build`, `test`, `test:ui`, `test:server`, `typecheck`, `fonts`, `build:sidecar` |
| [vite.config.ts](../vite.config.ts) | dev proxy, wasm packages excluded from pre-bundling, ES worker format, two vitest projects (`ui` jsdom, `server` node) |
| [Dockerfile](../Dockerfile), [docker-compose.yml](../docker-compose.yml) | image and container; see [environment](environment.md) |
| [scripts/fonts.ts](../scripts/fonts.ts) | stages the 17 default fonts into `public/fonts` |
| [scripts/build-sidecar.ts](../scripts/build-sidecar.ts) | compiles the server to an exe for the `launcher` app |
| [public/fonts/](../public/fonts) | the default font files (gitignored, restaged by `bun run fonts`) |
| `data/` | the user's workspaces and `settings.json`. Private; gitignored |

## Server (`server/`)

| File | Job | Test |
|---|---|---|
| [index.ts](../server/index.ts) | wires everything, starts `Bun.serve` (32 MB body cap, 120 s idle) | none |
| [config.ts](../server/config.ts) | env to config: `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR`, `TYPST_CLI`, `APP_TOKEN` | none |
| [router.ts](../server/router.ts) | every `/api` route, auth, ETag, SSE stream, static fallthrough | [router.test.ts](../server/router.test.ts) |
| [service.ts](../server/service.ts) | workspace, folder and asset operations; emits bus events | [service.test.ts](../server/service.test.ts) |
| [settings.ts](../server/settings.ts) | registry store, groups, folder appearance, path self-heal | [settings.test.ts](../server/settings.test.ts) |
| [workspace.ts](../server/workspace.ts) | `WorkspaceFs`: files, assets, meta, reference rewriting | [workspace.test.ts](../server/workspace.test.ts) |
| [trash.ts](../server/trash.ts) | the app trash: `.trash.json` sidecar, listing (sidecar or legacy shape), move-in, restore (document, files), stamp clean-up | [trash.test.ts](../server/trash.test.ts) |
| [workspace-index.ts](../server/workspace-index.ts) | async folder snapshot and etag | [workspace-index.test.ts](../server/workspace-index.test.ts) |
| [watcher.ts](../server/watcher.ts) | `fs.watch`, debounce, own-write marks | [watcher.test.ts](../server/watcher.test.ts) |
| [events.ts](../server/events.ts) | in-process event bus | [events.test.ts](../server/events.test.ts) |
| [assets.ts](../server/assets.ts) | filename hygiene, MIME allow-list, crop and blur validation, 25 MB cap | via `workspace.test.ts`, `router.test.ts` |
| [fonts.ts](../server/fonts.ts) | font family from the `name` table, or via `typst fonts` | [fonts.test.ts](../server/fonts.test.ts) |
| [compile.ts](../server/compile.ts) | typst CLI: compile, preview PNG, PDF export, diagnostics parser | [compile.test.ts](../server/compile.test.ts) |
| [bake.ts](../server/bake.ts) | jimp: bake crop and blur into PNG/JPEG | [bake.test.ts](../server/bake.test.ts) |
| [mcp.ts](../server/mcp.ts) | MCP sessions, client status, image result blocks | [mcp.test.ts](../server/mcp.test.ts) |
| [mcp-tools.ts](../server/mcp-tools.ts) | the tool catalogue (`TOOLS`, `callTool`) | [mcp-tools.test.ts](../server/mcp-tools.test.ts) |
| [mcp-stdio.ts](../server/mcp-stdio.ts) | stdio to HTTP bridge for Claude Desktop | [stdio-bridge.test.ts](../server/stdio-bridge.test.ts) |
| [backup/index.ts](../server/backup/index.ts) | scheduler, run, restore, state | [index.test.ts](../server/backup/index.test.ts) |
| [backup/mirror.ts](../server/backup/mirror.ts) | plan and write the mirror tree | [mirror.test.ts](../server/backup/mirror.test.ts) |
| [backup/snapshot.ts](../server/backup/snapshot.ts) | zip snapshots, prune, restore | [snapshot.test.ts](../server/backup/snapshot.test.ts) |
| [paths.ts](../server/paths.ts) | `normalizeRel`, `resolveInside` (escape guard) | [paths.test.ts](../server/paths.test.ts) |
| [fsx.ts](../server/fsx.ts) | `writeAtomic`, safe and unique dir names | none |
| [http.ts](../server/http.ts) | `HttpError`, `json`, body readers | none |
| [static.ts](../server/static.ts) | serves `dist/`, prefers `.gz`, SPA fallback | none |
| [fs-browse.ts](../server/fs-browse.ts) | folder browser behind `GET /api/fs/browse` | [fs-browse.test.ts](../server/fs-browse.test.ts) |
| [legacy-import.ts](../server/legacy-import.ts), [cli.ts](../server/cli.ts) | one-time import of the old Typst Figure Studio data | [legacy-import.test.ts](../server/legacy-import.test.ts) |
| [test-util.ts](../server/test-util.ts) | helper for server tests | n/a |

## Frontend lib (`src/lib/`)

Pure logic; most files have a test of the same name.

| File | Job | Test |
|---|---|---|
| [typst-compiler.ts](../src/lib/typst-compiler.ts), [.worker.ts](../src/lib/typst-compiler.worker.ts), [.driver.ts](../src/lib/typst-compiler.driver.ts), [-types.ts](../src/lib/typst-compiler-types.ts) | browser compile client, worker, wasm driver, shared types | `typst-compiler-client.test.ts` |
| [typst-default-fonts.ts](../src/lib/typst-default-fonts.ts) | the 17 default font file names | `fonts-manifest.test.ts` |
| [typst-pages.ts](../src/lib/typst-pages.ts) | split the SVG per page; shared style and defs reconcile | `typst-pages.test.ts`, `typst-shared-defs.test.ts` |
| [typst-source-map.ts](../src/lib/typst-source-map.ts) | preview click to source range by text search | `typst-source-map.test.ts` |
| [typst-placeholders.ts](../src/lib/typst-placeholders.ts) | figure slots: find, add, set path and height, retarget asset paths | `typst-placeholders.test.ts` |
| [typst-assets.ts](../src/lib/typst-assets.ts) | upload, fetch, crop, blur, mount into the compiler | `typst-assets.test.ts` |
| [typst-mount.ts](../src/lib/typst-mount.ts) | which files a document sees; plain-file byte cache | `typst-mount.test.ts` |
| [typst-geometry.ts](../src/lib/typst-geometry.ts) | figure box size from `#set page` and slot height | `typst-geometry.test.ts` |
| [typst-search.ts](../src/lib/typst-search.ts) | whole-document search | `typst-search.test.ts` |
| [typst-language.ts](../src/lib/typst-language.ts) | CodeMirror highlighting | none |
| [crop-math.ts](../src/lib/crop-math.ts), [blur-math.ts](../src/lib/blur-math.ts), [image-format.ts](../src/lib/image-format.ts) | crop viewport, blur strength, format sniffing. Also imported by the server | same-name tests |
| [asset-folders.ts](../src/lib/asset-folders.ts), [folder-paths.ts](../src/lib/folder-paths.ts) | asset folder helpers | same-name tests |
| [folder-tree.ts](../src/lib/folder-tree.ts), [workspace-groups.ts](../src/lib/workspace-groups.ts) | sidebar folder paths and grouping. `folder-tree` is shared with the server | same-name tests |
| [sidebar-dnd.ts](../src/lib/sidebar-dnd.ts), [sidebar-collapse.ts](../src/lib/sidebar-collapse.ts), [collapsed-groups.ts](../src/lib/collapsed-groups.ts) | drop rules; collapsed state in localStorage | same-name tests |
| [workspace-cache.ts](../src/lib/workspace-cache.ts), [prefetch.ts](../src/lib/prefetch.ts), [perf.ts](../src/lib/perf.ts) | switch caches, prefetch, switch tracing (`window.__tfsPerf`) | same-name tests |
| [autosave.ts](../src/lib/autosave.ts), [pane-resize.ts](../src/lib/pane-resize.ts) | debounced save; pane width math | same-name tests |
| `preview-lock.ts` | in progress by another agent; see [now](now.md) | `preview-lock.test.ts` |

Other: [api/client.ts](../src/api/client.ts) (REST client, sends `x-client-id`; test `api-client.test.ts`), [api/events.ts](../src/api/events.ts) (SSE), [stores/index.ts](../src/stores/index.ts) (`useAppStore`; test `store.test.ts`), [hooks/use-workspace-file.ts](../src/hooks/use-workspace-file.ts) (test `use-workspace-file.test.ts`), [types.ts](../src/types.ts) (shared types, `ServerEvent`), [template.ts](../src/template.ts) (starter document; test `template.test.ts`), [index.css](../src/index.css) (theme tokens).

## Frontend components (`src/components/`)

| File | Job | Test |
|---|---|---|
| [typst/TypstView.tsx](../src/components/typst/TypstView.tsx) | the tab: panes, file picker, export, asset sync | none direct |
| [typst/TypstPreview.tsx](../src/components/typst/TypstPreview.tsx) | debounced compile, per-page cards, click to source | `typst-preview-pages.test.tsx` |
| [typst/TypstEditor.tsx](../src/components/typst/TypstEditor.tsx) | CodeMirror (only importer of it) | `editor-echo.test.tsx`, `editor-reveal.test.tsx` |
| [typst/typst-editor-bridge.ts](../src/components/typst/typst-editor-bridge.ts) | command interface to the editor | `typst-editor-bridge.test.ts` |
| [typst/TypstAssetsPanel.tsx](../src/components/typst/TypstAssetsPanel.tsx) | assets rail: tree, drag, fonts | none direct |
| [typst/PlaceScreenshotDialog.tsx](../src/components/typst/PlaceScreenshotDialog.tsx), [FigureViewport.tsx](../src/components/typst/FigureViewport.tsx) | crop, blur and place into a slot | `place-dialog-defaults.test.tsx` |
| [typst/TypstSearchPanel.tsx](../src/components/typst/TypstSearchPanel.tsx), [DiskChangeBar.tsx](../src/components/typst/DiskChangeBar.tsx) | search and replace; disk-change notice | none direct |
| [sidebar/Sidebar.tsx](../src/components/sidebar/Sidebar.tsx) and siblings (`FolderTree`, `FolderRow`, `WorkspaceRow`, `FolderAppearance`, `folder-icons.ts`) | workspace tree, drag and drop, folder menu, status footer | `sidebar.test.tsx`, `folder-icons.test.ts` |
| [settings/SettingsView.tsx](../src/components/settings/SettingsView.tsx), [CopyRow.tsx](../src/components/settings/CopyRow.tsx) | Connect Claude, backups, CLI path, redaction defaults | `settings-connect.test.tsx` |
| [ui/ConfirmDialog.tsx](../src/components/ui/ConfirmDialog.tsx), [FolderBrowserDialog.tsx](../src/components/ui/FolderBrowserDialog.tsx), [Portal.tsx](../src/components/ui/Portal.tsx) | shared dialogs | none direct |
| [ui/TrashDialog.tsx](../src/components/ui/TrashDialog.tsx), [lib/trash-format.ts](../src/lib/trash-format.ts) | the Trash dialog (list, Restore only), time and size text | [trash-dialog.test.tsx](../src/test/trash-dialog.test.tsx) |

## Import boundary (Docker)

The runtime image copies only `server/`, `src/types.ts`, `src/template.ts` and `src/lib/` ([Dockerfile](../Dockerfile)). So server code may import only from those, and any `src/lib` file the server imports must stay free of DOM and React. Today the server imports `types`, `template`, `folder-tree`, `typst-geometry`, `typst-placeholders`, `blur-math`, `crop-math` and `image-format`. Importing from `src/components`, `src/stores` or `src/api` would fail inside the container (inference: the files are not in the image) while `bun run build` still passes.
