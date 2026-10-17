---
type: decision-log
status: active
updated: 2026-10-17
verified: 2026-10-17
source: docs/superpowers/specs and plans; code comments in server/ and src/lib; git log of university-tools@fde194f
description: Append-only log of Typst Studio decisions (D1 onward): what was decided, when, why, where it is recorded, and whether it is in effect; plain-folder workspaces, no Yjs, typst CLI on the server, Docker, compile worker, caches, shadow-root preview, path-as-id folders.
---
# Decisions

Append-only. Add new entries at the end with the next number. Never rewrite an old entry; a reversal is a new entry and the old one gets "replaced by Dn". Seeded 2026-10-17 from the specs, plans and code comments. Dates are the spec's date, or the first commit for code-comment decisions.

Status: **in effect**, **proposed**, **replaced by Dn**, **done**.

**D1 · 2026-09-03 · One plain folder per workspace.** The user's choice. Readable by git, VS Code and the CLI; a backup is a copy. Status: in effect. Source: [design](../docs/superpowers/specs/2026-09-03-typst-studio-design.md) section 10.

**D2 · 2026-09-03 · Asset folders are real subdirectories of `assets/`.** A virtual tree that disagrees with Explorer would confuse a folder-based model. Moves and renames rewrite every `/assets/...` reference in `.typ` files. Status: in effect. Source: design section 10, 4.3.

**D3 · 2026-09-03 · Drop Yjs and collaboration.** Single-user app; collaboration would need a WebSocket server and CRDT storage for no user. Also dropped: accounts, admin, AI assistant. Status: in effect. Source: design sections 1, 10.

**D4 · 2026-09-03 · A Bun server owns REST, MCP and backups.** MCP must outlive the window. A Tauri tray launcher (`../launcher`) was planned to run it as a sidecar. Status: in effect for the server; the launcher's current use is unconfirmed. Source: design sections 1, 6, 10.

**D5 · 2026-09-03 · The server compiles with the typst CLI; jimp bakes redactions.** The window may be closed, and an MCP-exported PDF must never leak a blurred secret. The CLI is pinned to 0.14.2 to match typst.ts 0.7. Status: in effect. Source: design sections 4.5, 10; [Dockerfile](../Dockerfile) `TYPST_VERSION`.

**D6 · 2026-09-03 · `--ignore-system-fonts` on the CLI.** Parity with the browser compiler, which sees only the bundled faces plus the workspace's `fonts/`. Status: in effect. Source: design section 10; [compile.ts](../server/compile.ts).

**D7 · 2026-09-03 · Port 8090 and MCP name `typst-figure-studio` stay.** Claude Code was already registered against them. Status: in effect. Source: design sections 2, 10.

**D8 · 2026-09-03 · The backup mirror refuses non-empty folders that lack the marker, and never unlinks.** The one rule that stops a mis-click from reconciling the Documents folder. Stale items move to `_trash/<stamp>/`. Status: in effect. Source: design sections 4.7, 10; [mirror.ts](../server/backup/mirror.ts).

**D9 · 2026-09-03 · Snapshots include external workspaces; restore never overwrites them.** External folders belong to the user. Restore unpacks them to `workspaces/restored-<stamp>/`. Status: in effect. Source: design sections 4.7, 10.

**D10 · 2026-09-03 · Edits the server makes itself are not reported back as disk changes.** `markOwnWrite` plus an mtime match; the spec said 1 s, the code holds a mark for 1.5 s. Status: in effect. Source: design section 4.4; [watcher.ts](../server/watcher.ts).

**D11 · 2026-09-03 · Click to source uses text search, not Typst spans.** typst.ts only embeds spans when debug info is attached, and only its incremental server API exposes that. Searching for the rendered string needs no compiler help and degrades gracefully. Status: in effect; a better mapping is being researched (see [now](now.md)). Source: header comment of [typst-source-map.ts](../src/lib/typst-source-map.ts).

**D12 · 2026-09-05 · Run in Docker with `./data` bind-mounted, and let the registry self-heal paths.** `settings.json` stores absolute paths; in a container they do not exist. A library entry whose folder is missing is re-pointed to `<workspacesDir>/<name>`; external entries are never touched. Backups folder mounted at `/host`. Status: in effect. Source: [docker and performance](../docs/superpowers/specs/2026-09-05-docker-and-performance-design.md) sections 3.1, 3.2; [docker-compose.yml](../docker-compose.yml).

**D13 · 2026-09-05 · One compiler in a Web Worker; fonts swap with `setFonts`.** Fonts were supplied only at init, so each workspace with its own fonts rebuilt the 28 MB wasm module and leaked the old one (3 to 8 GB growth). Status: in effect. Source: docker and performance section 2, 3.3; [typst-compiler.driver.ts](../src/lib/typst-compiler.driver.ts).

**D14 · 2026-09-05 · Preview pages mount individually and lazily.** One SVG for a long report is tens of thousands of nodes; splitting per page keeps unchanged pages in the DOM. Status: in effect. Source: header of [TypstPreview.tsx](../src/components/typst/TypstPreview.tsx); commit "perf(preview): mount pages individually and lazily".

**D15 · 2026-09-15 · Cache everything a switch reads, and revalidate with ETags.** Settings stay in memory (re-read when mtime moves); `openedAt` is written after 2 s quiet; the folder walk is async and cached (`workspace-index.ts`, 30 s safety rebuild); the client keeps detail, text and render caches; prefetch on hover and idle; prefetch requests carry `x-tfs-prefetch` so they do not bump `openedAt`. Why: the container's bind mount made each fs call about 15 times slower and one event loop queued every request. Status: in effect. Source: [instant switching](../docs/superpowers/specs/2026-09-15-instant-workspace-switching-design.md) sections 2, 3, 6.

**D16 · 2026-09-15 · The preview renders in a shadow root; the document stylesheet is applied once.** With a long report mounted, any style recalculation cost 1.4 to 1.6 s. Re-inserting typst.ts's `<style>` forced one per compile, and the app's global stylesheet was matched against about 26,000 SVG nodes. Status: in effect. Source: instant switching section 6; `splitSharedStyle` and `reconcileDefs` in [typst-pages.ts](../src/lib/typst-pages.ts).

**D17 · 2026-09-15 · Fonts left as they are (no font union, no per-font-set resolver cache).** Out of scope for switching. Status: in effect. Source: instant switching section 7.

**D18 · 2026-09-21 · A sidebar folder's id is its path.** Chosen over a record model (`{id, parentId, name}`), which would need a settings migration, change the snapshot manifest and turn the `move_workspace` argument into an opaque id. Max depth 4. Existing one-segment groups are already valid. Status: in effect. Source: [sidebar folders](../docs/superpowers/specs/2026-09-21-sidebar-folders-design.md) section 2.

**D19 · 2026-09-21 · No manual sort order in the sidebar.** Folders stay A to Z, workspaces most recently opened first, so no ordering field exists. Status: in effect. Source: sidebar folders section 1.

**D20 · 2026-09-21 · A nested folder mirrors to nested directories; a one-segment folder plans the same path as before.** Each segment goes through `safeDirName` separately. Status: in effect. Source: sidebar folders section 4; [mirror.ts](../server/backup/mirror.ts).

**D21 · undated (code comment, after 2026-09-21) · Reference rewrites go out with `origin: null`.** An open tab ignores events carrying its own client id (that stops autosave echoes). Attributing the server's rewrite to the caller's tab would leave its buffer on the old path and let the next autosave put the stale path back. Status: in effect. Source: comment above `rewrote()` in [service.ts](../server/service.ts).

**D22 · 2026-10-17 · This brain exists.** Notes in `brain/` plus a short `CLAUDE.md` and a pointer `AGENTS.md`, following the user's other brains. Status: in effect. Source: [brain method](brain-method.md).

**D23 · 2026-10-17 · Theme: Ember dark with floating panes.** The user picked Ember (mode dark, Coral accent, Bahnschrift UI, JetBrains Mono code, radius 4px, icon stroke 1.75, surfaces "shadows") in the theme picker. Tokens live in `src/index.css`; panes are cards on the `--background` canvas with `--pane-gap` 8px and `--pane-shadow`, no hairlines between them. The divider is the gap, so `PANE_GAP` in `src/lib/pane-resize.ts` must equal `--pane-gap`. Status: in effect. Source: [UI themes research](../docs/research/2026-10-17-ui-themes.md), the theme picker artifact "Studio Looks".

**D24 · 2026-10-17 · Documents nest under documents, in the sidebar only.** `WorkspaceEntry.parent` names another entry; nothing moves on disk and each document keeps its own folder and `main.typ`. A child always carries its parent's `group` (the parent wins on load, and moving a parent moves its subtree in one registry write), so the backup mirror tree, which follows `group`, stays coherent. Max 4 levels, no cycles. Deleting a parent re-parents its children to its own parent in the same write, so children are never deleted with it. Dropping a document on a document row now nests it (it used to file it in that row's folder). Status: in effect. Source: [sidebar logos and nesting](../docs/superpowers/specs/2026-10-17-sidebar-logos-and-nesting-design.md); [workspace-nesting.ts](../src/lib/workspace-nesting.ts), `normalise` in [settings.ts](../server/settings.ts).

**D25 · 2026-10-17 · Logos are never deleted on clear.** An uploaded logo is a small file in `data/logos/` under a random generated name. Clearing, replacing or deleting the row that uses it only drops the name from the registry; the file stays, so a mistaken click is recoverable and no delete path exists. Logos are served sandboxed (`Content-Security-Policy: sandbox`, `nosniff`) and only ever shown through `<img>`. They are not in the backup mirror or snapshots (they live outside workspace folders). Status: in effect. Source: same spec; [logos.ts](../server/logos.ts).

**D26 · 2026-10-17 · Restore from trash, and no empty-trash on purpose.** The sidebar footer has a Trash row; its dialog lists items and offers Restore, nothing else. No REST route, UI button or MCP tool empties the trash or deletes from it, so the trash only grows, and the only way something leaves it is by moving back out. A restore never overwrites (free "(restored)" name), copies before removing across drives, and removes a stamp folder only when it is already empty (non-recursive `rmdir`). Both delete paths write `data/trash/<stamp>/.trash.json` with `writeAtomic` (kind, original path or workspace id plus relative paths, deleted-at, and a document's full registry entry); older items are detected by shape. Status: in effect. Source: [restore from trash](../docs/superpowers/specs/2026-10-17-restore-from-trash-design.md); [trash.ts](../server/trash.ts).

**D27 · 2026-10-17 · Click-to-source uses an alignment mapper with no CodeMirror in `src/lib`, tested on a synthetic corpus.** The mapper projects the source with a small hand-written scanner (`projectSource`) instead of the Lezer tree, because CLAUDE.md keeps CodeMirror inside `TypstEditor.tsx` (lazy chunk) and the lib stays pure and DOM-free. It aligns the clicked run plus its neighbours with a banded local alignment, and `findSourceRange` stays as the fallback so a click never does less than before. Accuracy is measured on five fixture documents we wrote, with runs generated once by the project's own typst.ts (`scripts/gen-source-map-fixtures.mjs`), never on the user's documents in `data/`; the corpus test prints an old-vs-new table and asserts new is at least as good on every fixture. The thresholds were tuned on that same corpus, so its 98.3% is an upper bound. Status: in effect. Source: [phase 1 spec](../docs/superpowers/specs/2026-10-17-preview-source-mapping-phase1-design.md); [research](../docs/research/2026-10-17-preview-source-mapping.md) "Phase 1 results"; [typst-source-map.ts](../src/lib/typst-source-map.ts).
