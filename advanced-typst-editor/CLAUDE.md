# Typst Studio

A local Typst editor: live in-browser preview, an assets rail for screenshots and fonts, backups, and an MCP server so Claude can edit documents. Each document is a plain folder ("workspace"). This file loads in every session started here, so it stays short; the detail lives in `brain/`.

Stack: React 19, Vite 8, zustand, Tailwind 4, CodeMirror 6, typst.ts 0.7 (compiles in a Web Worker) in `src/`. Bun backend (REST, SSE, MCP, file watcher, backups) in `server/`. Docker deployment. Tests with vitest.

## Start of every session

- Read `brain/index.md`, then `brain/now.md`, before working out project facts again. Open other notes only when the task needs them. `grep "^description:" -r brain` lists what each note answers.
- Explore and Plan subagents do not load this file. Tell any subagent you spawn to read `brain/index.md` first.
- Other Claude sessions edit this app at the same time. Check `git status` and `brain/now.md` before editing, and don't touch files another agent is working on.

## Commands

Run from this folder, in the Git Bash tool.

    bun install
    bun --watch server/index.ts     # API + MCP on 127.0.0.1:8090
    bun run dev                     # UI on 127.0.0.1:5173, proxies /api and /mcp
    bun run test                    # vitest, both projects (test:ui, test:server)
    bun run typecheck               # src and server (build only checks src)
    bun run build                   # typecheck + vite build to dist/
    docker compose up --build -d    # rebuild and restart the container

## Layout

- `server/`: Bun backend. `index.ts` wires it; `router.ts` routes; `service.ts` workspace operations; `settings.ts` the registry (`data/settings.json`); `compile.ts` typst CLI; `mcp-tools.ts` the MCP tools; `backup/` mirror and snapshots. Tests sit beside each file.
- `src/lib/`: pure, DOM-free logic (compiler client, pages, source map, placeholders, crop and blur math, folder tree, caches). Tests in `src/test/`.
- `src/components/`: `typst/` (editor, preview, assets rail, crop dialog), `sidebar/`, `settings/`, `ui/`.
- `src/stores/index.ts`: the one zustand store. `src/api/`: REST client and SSE.
- `docs/superpowers/specs` and `plans`: design history. `data/`: the user's private documents.
- Full map with tests: `brain/codemap.md`. How it fits together: `brain/architecture.md`.

## Hard rules

- **Never commit or push without asking.** The git root is `university-tools`, shared with other apps; it was on branch `feat/74ls151-sim` on 2026-10-17, so check the branch first. Stage explicit paths, never `git add -A`. CRLF warnings are noise.
- **Don't open the user's documents in `data/`.** They are private reports. Listing folders is fine. Don't modify `data/` either.
- **Never run a dev backend on port 8090 while the `typst-studio` container is up.** Both write `data/settings.json` with different path forms and fight.
- **Never lose user data.** Deletes go to a recoverable place (trash, snapshot), overwrites keep a way back. Read `brain/data-safety.md` before touching disk, registry or backup code, and run the `typst-data-guard` agent on such diffs (not for UI-only work).
- **Test first.** Write the failing vitest test, then the code. Run `bun run test` and `bun run typecheck` before saying it works.
- **Specs then plans** for anything new: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, then a plan. Plan execution goes to Sonnet subagents. See `brain/how-we-work.md`.
- **Server code may import only `src/types.ts`, `src/template.ts` and `src/lib/`.** The Docker image copies nothing else, and `src/lib` files the server imports must stay DOM-free.
- **Only `TypstEditor.tsx` imports CodeMirror.** Everyone else goes through `typst-editor-bridge.ts`, so the 500 KB chunk stays lazy.
- **Reference rewrites go out with `origin: null`** in `service.ts`. Don't "fix" that; see `brain/decisions.md` D21.
- Use `ConfirmDialog`, not `window.confirm` or `prompt`.
- Write plainly: short sentences, concrete paths, no em dashes.

## Gotchas you will hit

Full list with fixes: `brain/gotchas.md`.

- **The app runs in the Docker container `typst-studio` on :8090.** `./data` is bind-mounted as `/data`. MCP tool paths (`upload_asset`, `add_font`, `export_pdf`) are container paths: copy files into `data/` first and pass `/data/...`. Source edits reach the container only after `docker compose up --build -d`.
- **Only Libertinus Serif, New Computer Modern and DejaVu Sans Mono are embedded.** Any other font must be added as a per-workspace font asset.
- **Crop and blur apply at render time.** Originals stay on disk and in backups. The server bakes them only for PNG and JPEG on `export_pdf`.
- **Preview is typst.ts in the browser; MCP `compile` and `render_preview` use the typst CLI.** They can differ.
- **PowerShell 5.1 `Invoke-RestMethod -Method Patch` fails on a large JSON body.** Use `curl.exe -X PATCH --data-binary @file`.
- **`bash` called from PowerShell or Node resolves to WSL.** Use the Git Bash tool. Write multi-line files with the Write tool, not heredocs.
- **The old `/api/documents` endpoints are gone.** The API is `/api/workspaces`.
- **Sidebar folder ids are paths** (`School/ECE-2300L`, max depth 4), one URL segment after decoding.

## Keep the brain current

A session can stop at any time, so don't wait for the end.

- Every change gets a line in `brain/daily/<date>.md` and an update to the note that owns the area, in the same session.
- Rewrite `brain/now.md` when a task finishes: focus, next steps each with a done-check, uncommitted work, work in flight.
- New decisions go at the end of `brain/decisions.md` (never rewrite old ones). New traps go in `brain/gotchas.md` with the exact error text. Questions for the user go in `brain/open-questions.md`.
- Mark a step done only with evidence: the command, output or test.
- Re-read the code before bumping a note's `verified` date. Cite only paths that exist.

## Don't loop

- Before retrying anything that failed, check `brain/gotchas.md`.
- If a lookup passes about 10 tool calls or two failed attempts, stop, write what you found into the owning note, and ask.
- When compacting, keep: the current task, files changed, commands run with results, and failed approaches.
