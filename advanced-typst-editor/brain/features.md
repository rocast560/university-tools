---
type: reference
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f (advanced-typst-editor/ working tree); specs and plans under docs/superpowers
covers: advanced-typst-editor/src/components, advanced-typst-editor/src/lib, advanced-typst-editor/server, advanced-typst-editor/docs/superpowers
description: Every user-facing Typst Studio feature (workspaces, live preview, click to source, figure slots, crop and blur, assets rail, fonts, PDF export, MCP and Connect Claude, backups, instant switching, nested sidebar folders, Docker) mapped to its files and the spec or plan that designed it; features in progress.
---
# Features

Contents: Shipped features, In progress, Specs and plans index.

Spec and plan paths are under `docs/superpowers/`. Full file lists are in [codemap](codemap.md). "Spec" = what and why; "Plan" = task-by-task steps.

## Shipped

| Feature | Main files | Spec / plan |
|---|---|---|
| **Workspaces as plain folders.** Library (under `data/workspaces`) or external folder; create, rename, delete to trash, locate a missing folder. Sidebar multi-select (2026-10-17): Ctrl/Cmd+click toggles, Shift+click ranges over the visible rows, Escape or a click outside clears; right-click or Delete opens one confirm for the batch ("Delete…" for a library workspace, which moves to `data/trash`; "Remove from sidebar" for an external folder, which stays on disk). Store `removeWorkspaces(ids)` deletes in sequence, reloads once, reports partial failure in a sidebar alert, and drops the preview-lock overrides. Files: `src/lib/sidebar-selection.ts`, `WorkspaceRow.tsx`, `FolderTree.tsx`, `src/stores/index.ts`; tests `sidebar-selection.test.ts`, `sidebar-select-delete.test.tsx`, `remove-workspaces.test.ts`. | `server/service.ts`, `server/settings.ts`, `server/workspace.ts`, `src/components/sidebar/Sidebar.tsx`, `src/components/ui/FolderBrowserDialog.tsx`, `server/fs-browse.ts` | [design](../docs/superpowers/specs/2026-09-03-typst-studio-design.md) sections 3, 4.8; [plan 1](../docs/superpowers/plans/2026-09-03-typst-studio-1-server.md), [plan 2](../docs/superpowers/plans/2026-09-03-typst-studio-2-frontend.md) |
| **Live preview in the browser.** Offline typst.ts in a Web Worker; errors as a banner over the last good render. | `src/lib/typst-compiler*.ts`, `src/components/typst/TypstPreview.tsx` | [docker and performance](../docs/superpowers/specs/2026-09-05-docker-and-performance-design.md) section 3.3; [plan](../docs/superpowers/plans/2026-09-05-docker-and-performance.md) |
| **Per-page lazy preview.** Pages mount near the viewport, unchanged pages keep their DOM, rendered inside a shadow root. | `src/lib/typst-pages.ts`, `TypstPreview.tsx` | [instant switching](../docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md) section 6 |
| **Click to source.** Click preview text, the editor jumps to the matching source. | `src/lib/typst-source-map.ts`, `TypstPreview.tsx`, `typst-editor-bridge.ts` | [design](../docs/superpowers/specs/2026-09-03-typst-studio-design.md) section 5 (ported from BTCT) |
| **Code editor and search.** CodeMirror 6 with hand-written Typst highlighting; whole-document search and replace. | `TypstEditor.tsx`, `src/lib/typst-language.ts`, `TypstSearchPanel.tsx`, `src/lib/typst-search.ts` | design section 5 |
| **Autosave and disk-change bar.** Save 500 ms after typing, on blur and pagehide; external edits reload or ask. | `src/hooks/use-workspace-file.ts`, `src/lib/autosave.ts`, `DiskChangeBar.tsx` | design section 4.4 |
| **Assets rail.** Images in `assets/` folders, fonts in `fonts/`; rename or move rewrites every `.typ` reference. | `TypstAssetsPanel.tsx`, `src/lib/typst-assets.ts`, `src/lib/asset-folders.ts`, `server/workspace.ts` (`rewriteReferences`) | design sections 3, 4.3 |
| **Figure slots.** `#image-placeholder(caption, path:, height:)` calls are the slots; images go into slots, not at the caret. | `src/lib/typst-placeholders.ts`, `src/template.ts`, MCP slot tools | design section 5 |
| **Crop, blur and place.** A fixed frame at the figure's real proportions with the image panned behind it; blur or pixelate regions redact. | `PlaceScreenshotDialog.tsx`, `FigureViewport.tsx`, `src/lib/crop-math.ts`, `blur-math.ts`, `typst-geometry.ts` | design section 5 |
| **Custom fonts.** Per-workspace font files; family read from the file. | `server/fonts.ts`, `src/lib/typst-assets.ts`, driver `setFonts` | docker and performance section 3.3 |
| **PDF export.** In the browser (identical to the preview) and on the server (bakes redactions first). | `TypstView.tsx` (`compileTypstPdf`), `server/compile.ts`, `server/bake.ts` | design section 4.5 |
| **MCP server and Connect Claude.** 27 tools over HTTP at `/mcp`, stdio bridge for Claude Desktop, copy buttons in Settings. | `server/mcp.ts`, `mcp-tools.ts`, `mcp-stdio.ts`, `src/components/settings/SettingsView.tsx` | design section 4.6; docker and performance section 3.5 |
| **Backups.** Mirror tree plus zip snapshots to any folder, restore, folder browser. Each run also saves `data/settings.json` and `data/logos/*` under a reserved `.typst-studio/` folder (mirror and snapshots); a snapshot restore copies back missing logos its workspaces reference, never overwriting one, and never touches the live `settings.json`. | `server/backup/*`, Settings | design section 4.7 |
| **Instant workspace switching.** Caches, ETag revalidation, hover and idle prefetch, async index. | `src/lib/workspace-cache.ts`, `prefetch.ts`, `perf.ts`, `server/workspace-index.ts`, `server/settings.ts` | [spec](../docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md), [plan](../docs/superpowers/plans/2026-09-15-instant-workspace-switching.md) |
| **Sidebar: collapse and status footer.** Collapse to an icon rail (Ctrl+B), pinned MCP and backup status. | `Sidebar.tsx`, `src/lib/sidebar-collapse.ts`, `collapsed-groups.ts` | docker and performance section 3.4 |
| **Sidebar logos and nested documents** (2026-10-17, uncommitted). A folder or a document row shows an uploaded logo, else an icon, else the default; the "Appearance…" popover has a Logo section (PNG, JPEG, WebP, SVG, 512 KB, "Remove logo" only unlinks). Dropping a document on a document row nests it (sidebar only, max 4 levels, nothing moves on disk; a child always lives in its parent's folder); dropping on a folder header or the background un-nests; deleting a parent moves its children up a level. Chevron collapse is remembered under `ws:<id>` keys. API: `POST /api/logos`, `GET /api/logos/:file`, `PATCH /api/workspaces/:id` with `parent` and `appearance`; MCP `move_workspace` takes `parent_id`. Files: `src/lib/workspace-nesting.ts`, `src/lib/logo.ts`, `server/logos.ts`, `WorkspaceRow.tsx`, `FolderTree.tsx`, `FolderRow.tsx`, `FolderAppearance.tsx`, `sidebar-dnd.ts`; tests `workspace-nesting`, `logo`, `sidebar-nesting`, `sidebar-nesting-logic`, `store-nesting`, `server/logos`, `server/nesting-api`, `server/settings-nesting`. | `src/lib/workspace-nesting.ts`, `server/settings.ts`, `server/logos.ts`, `src/components/sidebar/*` | [spec](../docs/superpowers/specs/2026-10-17-sidebar-logos-and-nesting-design.md) |
| **Nested sidebar folders.** Up to four levels, drag and drop, Move to menu, icon and colour per folder. | `src/lib/folder-tree.ts`, `sidebar-dnd.ts`, `FolderTree.tsx`, `FolderAppearance.tsx`, `server/settings.ts` | [spec](../docs/superpowers/specs/2026-09-21-sidebar-folders-design.md), [plan](../docs/superpowers/plans/2026-09-21-sidebar-folders.md) |
| **Docker deployment.** One container, bind-mounted data, health check. | `Dockerfile`, `docker-compose.yml`, `server/static.ts` | docker and performance section 3.1 |
| **Legacy import.** One-time move of the old Typst Figure Studio documents. | `server/legacy-import.ts`, `server/cli.ts` | design section 8 |
| **Desktop launcher** (separate app in `../launcher`). Tray shell that runs a server sidecar. Current use unconfirmed. | `scripts/build-sidecar.ts` | design section 6; [plan 3](../docs/superpowers/plans/2026-09-03-typst-studio-3-launcher.md) |

## In progress (as of 2026-10-17)

Details are unverified until the other agents finish. See [now](now.md).

| Feature | Notes |
|---|---|
| **Preview lock.** Per workspace or for all documents, so a click on the preview does not move the editor. | Another agent is writing it. Known files: `src/lib/preview-lock.ts`, `src/test/preview-lock.test.ts`; edits expected in `src/stores/index.ts`, `TypstPreview.tsx`, `TypstView.tsx`, `src/components/sidebar/WorkspaceRow.tsx`. No spec yet. |
| **Better preview to source mapping.** | Research only: `docs/research/2026-10-17-preview-source-mapping.md` appeared on disk late on 2026-10-17, contents not read for the brain. No code change decided. |
| **Confirm before deleting a sidebar folder.** | Written, uncommitted, in `Sidebar.tsx` and `sidebar.test.tsx`. Matches the risk row in the folders spec. |

## Specs and plans index

| Date | Spec | Plan | Subject |
|---|---|---|---|
| 2026-09-03 | [design](../docs/superpowers/specs/2026-09-03-typst-studio-design.md) | plans [1 server](../docs/superpowers/plans/2026-09-03-typst-studio-1-server.md), [2 frontend](../docs/superpowers/plans/2026-09-03-typst-studio-2-frontend.md), [3 launcher](../docs/superpowers/plans/2026-09-03-typst-studio-3-launcher.md) | the app, ported from BTCT |
| 2026-09-05 | [docker and performance](../docs/superpowers/specs/2026-09-05-docker-and-performance-design.md) | [plan](../docs/superpowers/plans/2026-09-05-docker-and-performance.md) | Docker, worker, sidebar, settings |
| 2026-09-15 | [instant switching](../docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md) | [plan](../docs/superpowers/plans/2026-09-15-instant-workspace-switching.md) | caches, prefetch, index |
| 2026-09-21 | [sidebar folders](../docs/superpowers/specs/2026-09-21-sidebar-folders-design.md) | [plan](../docs/superpowers/plans/2026-09-21-sidebar-folders.md) | nested folders |
