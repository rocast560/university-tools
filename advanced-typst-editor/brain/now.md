---
type: current-state
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f (branch feat/74ls151-sim at the time; advanced-typst-editor/ working tree)
description: Current state of Typst Studio work after the 2026-10-17 session (preview lock, multi-select delete, data-safety fixes, Ember theme, sidebar logos + nested documents), all uncommitted; what to protect and the next concrete steps. Overwritten whenever a task finishes.
---
# Now

## State (2026-10-17, end of session)

Everything below is built, tested and browser-checked, and **all of it is uncommitted** in the `university-tools` working tree. The user's running app is the `typst-studio` container on http://localhost:8090; it still runs the **old image** until `docker compose up --build -d` ([environment](environment.md)).

Verified by the lead at the end: `bun run test:ui` 459 passed (48 files), `bun run test:server` 184 passed (22 files), `bun run typecheck` clean.

## Landed today

| Work | Key files | Browser check |
|---|---|---|
| **Preview lock** (this document or all): preview clicks never open code/assets; linked text selectable when locked | `src/lib/preview-lock.ts`, `TypstPreview.tsx`, `TypstView.tsx`, `WorkspaceRow.tsx` | dev UI against the container |
| **Multi-select delete** (Ctrl/Shift-click, "Delete N documents…", Delete key; still to `data/trash`) | `src/lib/sidebar-selection.ts`, `Sidebar.tsx`, `FolderTree.tsx`, store `removeWorkspaces` | dev UI, dialog cancelled |
| **Data-safety rule + fixes**: corrupt registry kept aside + `.bak`; asset/file delete to trash; `export_pdf` only `.pdf` | [data safety](data-safety.md), `server/settings.ts`, `server/workspace.ts`, `server/compile.ts`, `~/.claude/agents/typst-data-guard.md` | data guard: SAFE WITH NOTES |
| **Ember theme** (dark, coral, Bahnschrift, 4px radius, floating panes) | `src/index.css`, `src/App.tsx`, `TypstView.tsx`, `src/lib/pane-resize.ts` (`PANE_GAP = 8`), D23 | dev UI; divider resize works |
| **Sidebar logos + nested documents** (icon/colour/uploaded logo for folders and documents; documents nest under documents, sidebar only) | spec `docs/superpowers/specs/2026-10-17-sidebar-logos-and-nesting-design.md`, `server/logos.ts`, `src/lib/workspace-nesting.ts`, `src/lib/logo.ts`, D24, D25 | throwaway server on 8091 with an empty data dir: nest, logo, icon, parent delete re-parents; data guard SAFE WITH NOTES (fold fix applied) |
| **Research** | `docs/research/2026-10-17-preview-source-mapping.md`, `docs/research/2026-10-17-ui-themes.md` | n/a |

Theme picker artifact: https://claude.ai/artifact/USQrvguth7bWyqGrdy5KeU (picks in its db at `picks/current`; the applied pick is Ember, dark, radius 4, surface shadows).

## Uncommitted local work (protect it)

- Earlier session: `server/mcp-tools.ts` (`move_workspace` description), `Sidebar.tsx` + `sidebar.test.tsx` (folder-delete confirm dialog).
- Today: everything in the table above, plus `CLAUDE.md`, `AGENTS.md`, `brain/`, `docs/research/`, the new spec.

Never `git add -A`, stash, reset or checkout over these. Ask the user before committing ([how we work](how-we-work.md)).

## Next steps

1. **Commit, once the user says so.** Check the branch first (`feat/74ls151-sim` holds unrelated circuit work); stage explicit `advanced-typst-editor/` paths only. Done when: `git status --short -- advanced-typst-editor` is empty.
2. **Rebuild the container.** Done when: `docker compose up --build -d` succeeds and `GET http://localhost:8090/api/health` returns `{"ok":true,...}`, and the sidebar shows the Ember look.
3. **Answer the open questions**: JetBrains Mono bundle, logos/settings in backups, a trash restore button, the brain hook ([open questions](open-questions.md)).
4. **Preview-to-source mapping, phase 1** (context-aware text alignment) from the research doc, when the user wants it.

## Watch-outs

- Other Claude sessions edit this app at the same time. Check `git status` before editing shared files.
- Do not start a dev backend on port 8090 while the container is up ([gotchas](gotchas.md)). For a server-side browser check, run `PORT=8091 DATA_DIR=<empty temp dir> STATIC_DIR=dist bun server/index.ts` after `bun run build`.
- The Vite dev UI on 5173 proxies to the container's **real** data and its old server code: never confirm a delete there, and new server features need the 8091 setup above.
