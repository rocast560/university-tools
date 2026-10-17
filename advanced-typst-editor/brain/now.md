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

Everything below is built, tested, browser-checked, **committed and pushed** to GitHub `main` (https://github.com/rocast560/university-tools), and **live** in the `typst-studio` container on http://localhost:8090 ([environment](environment.md)). Later additions the same day: backups carry logos + `settings.json` (`.typst-studio/` in the mirror), JetBrains Mono bundled, and restore from trash (Trash row in the sidebar footer, D26).

**Publishing:** GitHub's history had been rewritten to strip "Co-Authored-By: Claude" lines, so the 121 local commits were replayed onto `origin/main` with identical trees (parents re-pointed, trailers removed) and pushed without force. Never force-push over it, and never add the co-author trailer in this repo. The pre-replay commit IDs survive locally on branch `backup/typst-pre-publish-2026-10-17`; other old local branches (`circuit-*`, `sidebar-*`) still sit on the old IDs.

Rebuild check: health ok; 14 workspaces before and after; `settings.json` entries field-for-field identical, only additive changes (`groups` gained `CPTC` and `ECE-2300L`, which workspaces already referenced, and `folderMeta: {}`); `settings.json.bak` now exists. Side effect: the CPTC and ECE-2300L folders (11 documents) show in the sidebar again; the old server's groups list lacked them. Pre-rebuild registry copy kept in the lead's session scratchpad only.

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
| **Click-to-source, phase 1** (context-aware alignment; corpus 86.7% -> 98.7%) | `src/lib/typst-source-map.ts`, `TypstPreview.tsx`, `TypstEditor.tsx` (`settleReveal`), fixtures in `src/test/fixtures/source-map/`, D27 | real 23-page report: TOC clicks 4.2/7.2/6.1/2.1/8 land on their headings, on screen |
| **Selection-to-source, phase 2** (highlight in the preview -> transient editor mark + bar: Copy, Copy Typst source, Select in code; locked = copy buttons only) | `rangeFromSelection` in `typst-source-map.ts`, `PreviewSelectionBar.tsx`, `typst-editor-bridge.ts` `showTypstPreviewHighlight`, D28 | real report: mark, copy source, select in code, locked mode, narrow-pane bar |

Theme picker artifact: https://claude.ai/artifact/USQrvguth7bWyqGrdy5KeU (picks in its db at `picks/current`; the applied pick is Ember, dark, radius 4, surface shadows).

## Uncommitted local work (protect it)

- Not ours: `circut-ai-tool/src/sim/*` and its tests are uncommitted circuit-simulator work, left untouched in the working tree on the new branch. Never `git add -A`, stash, reset or checkout over it.

## Next steps

1. **Answer the open questions**: the brain hook, pruning old trash ([open questions](open-questions.md)). JetBrains Mono, logos/settings in backups and the trash restore button are done.
2. **Mapping, phase 3** (exact spans from a custom wasm) only if real use shows phases 1-2 miss too often; see the research doc. Known approximate cases: math, page counters, footnote markers, helper/`#include` output.

## Watch-outs

- Other Claude sessions edit this app at the same time. Check `git status` before editing shared files.
- Do not start a dev backend on port 8090 while the container is up ([gotchas](gotchas.md)). For a server-side browser check, run `PORT=8091 DATA_DIR=<empty temp dir> STATIC_DIR=dist bun server/index.ts` after `bun run build`.
- The Vite dev UI on 5173 proxies to the container's **real** data and its old server code: never confirm a delete there, and new server features need the 8091 setup above.
