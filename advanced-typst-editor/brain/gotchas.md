---
type: gotchas
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f; README; docker-compose.yml; Dockerfile; code comments; user memory note typst-figure-studio-api (2026-09-08)
description: Traps already hit in Typst Studio work, each with its fix: Docker container paths for MCP upload_asset and export_pdf, port 8090 and settings.json conflict, missing fonts, PowerShell PATCH, bash resolving to WSL, shared repo and CRLF, removed /api/documents, Docker import boundary, rebuild needed.
---
# Gotchas

Contents: Tried and failed, Docker and the container, Compile and fonts, MCP, Git and the shared repo, Shell on this machine, Code traps.

Each line: the trap, then the fix, then where it comes from. "Inference" means read in the code, not run.

## Tried and failed

Newest first. Format: date, what was tried, exact error text, why, do instead.

- **2026-09-08 · MCP `upload_asset` with a Windows path** · `path must be absolute` · the path is read inside the container · copy the file under `advanced-typst-editor/data/` and pass `/data/...` (see the MCP section below). Source: user memory note.
- **2026-09-08 · PowerShell `Invoke-RestMethod -Method Patch` with a ~9 KB JSON body** · `source must be a string` · fails on Windows PowerShell 5.1 (cause not investigated) · write the JSON to a UTF-8 file without BOM and use `curl.exe -X PATCH --data-binary @file`. Source: user memory note.
- **2026-09-08 · REST calls to `/api/documents`** · 404 · those endpoints are gone; the API is `/api/workspaces` · see [architecture](architecture.md). The comment at the top of `src/template.ts` still says `POST /api/documents`; it is stale.

## Docker and the container

- **The app runs as container `typst-studio` on `127.0.0.1:8090`** (container port 8080). `./data` is bind-mounted as `/data`, and `C:/Users/rober/Desktop/typst-editor/backups` is mounted as `/host` for backups. Source: [docker-compose.yml](../docker-compose.yml).
- **Never run a dev backend on 8090 while the container is up.** Both write `data/settings.json`, each recording workspace paths in its own form (Windows paths or `/data/...`), so the registry flips on every boot. Stop one first. Source: [README](../README.md); the self-heal in `scanLibrary()` papers over it but does not make it safe.
- **Source edits do not reach the container until it is rebuilt:** `docker compose up --build -d`. The image holds a built `dist/` and a copy of `server/`. Source: [Dockerfile](../Dockerfile).
- **Docker import boundary.** The runtime image copies only `server/`, `src/types.ts`, `src/template.ts`, `src/lib/`. A server file importing anything else would fail in the container while `bun run build` passes (inference). See [codemap](codemap.md). `src/lib` files imported by the server must stay DOM-free.
- **Backup destinations are container paths.** To back up to a host folder, the folder must be reachable inside the container (today only `/host`). The mirror also refuses a non-empty folder without its marker file. Source: [mirror.ts](../server/backup/mirror.ts).
- **`.dockerignore` excludes `docs` and `*.md`**, so docs changes never need a rebuild.

## Compile and fonts

- **Only three font families are embedded:** Libertinus Serif, New Computer Modern (and its math face), DejaVu Sans Mono (17 files, `src/lib/typst-default-fonts.ts`). Any other font (for example Poppins) must be added as a per-workspace font asset (`add_font` or the assets rail). Fonts do not carry across workspaces. Both compilers run with `--ignore-system-fonts` or no system fonts, so installed Windows fonts do not count.
- **Typst picks an image decoder from the file extension.** PNG bytes at a `.jpg` path fail with "failed to decode image". `upload_asset` corrects the extension from the bytes. Source: header of [image-format.ts](../src/lib/image-format.ts).
- **Crop and blur are applied at render time.** Files in `assets/` and in backup mirrors are the originals. The server bakes redactions only for PNG and JPEG on `export_pdf`; GIF, WebP and SVG with crop or blur return 422 instead of exporting unredacted. Source: [bake.ts](../server/bake.ts).
- **Two compilers can disagree.** The preview is typst.ts 0.7 in the browser; MCP `compile` and `render_preview` use the typst CLI 0.14.2. If they differ, check versions before blaming the document.
- **The server needs the typst CLI** (`TYPST_CLI`, Settings, a sidecar, or `PATH`) for MCP compile, export and preview. Without it those return 409. The container has it.

## MCP

- **Path arguments are container paths:** `upload_asset` and `add_font` (`path`) and `export_pdf` (`to`) are opened or written by the server process. Copy the input into `advanced-typst-editor/data/` (host) and pass `/data/...`. For output, export to `/data/workspaces/<name>/x.pdf` and copy it out. `data_base64` works but costs a huge number of tokens for an image.
- **The server name is `typst-figure-studio`**, endpoint `http://localhost:8090/mcp`. Claude Code is registered against it; keep both.
- **MCP edits reach open tabs through the event bus** (`origin: 'mcp'`). If a tab has unsaved edits it shows the disk-change bar rather than overwriting.

## Git and the shared repo

- **The git root is `university-tools`, shared with `circut-ai-tool`, `study-app`, `launcher`, `chem-tool`, `lab-parts-case` and more.** `git status` there lists other apps' work. Stage by explicit path inside `advanced-typst-editor/`; never `git add -A`.
- **The working tree was on branch `feat/74ls151-sim` on 2026-10-17**, named after the circut-ai-tool 74LS151 work (inference), yet it also carries this app's history. Check `git branch --show-current` before any commit and ask which branch the user wants.
- **CRLF warnings** (`LF will be replaced by CRLF`) appear on `git diff` and `git add` because `core.autocrlf=true`. They are noise. Do not run a mass line-ending rewrite.
- **`data/` is gitignored and private.** It holds the user's reports. Listing folders is fine; do not open documents.
- **`public/fonts/` is gitignored.** `bun run fonts` restages it; the Docker build does too.

## Shell on this machine

- **`bash` called from PowerShell or Node resolves to WSL**, which re-parses arguments. Use the Git Bash tool for shell work, or PowerShell for PowerShell work. Source: user memory note `bash-resolves-to-wsl`.
- **Quoted heredocs fail or lose backslashes in the Git Bash tool.** Write multi-line files with the Write tool. Source: user memory note.
- **PowerShell 5.1:** no `&&`; `Invoke-RestMethod -Method Patch` with a large body fails (see above).

## Code traps

- **Editor echo.** An open editor ignores `workspace.changed` carrying its own client id. Server-side reference rewrites go out as `origin: null` on purpose ([decisions](decisions.md) D21). Do not "fix" that by passing the caller's origin.
- **Folder ids are paths.** `School/ECE-2300L` is one URL segment after decode (`%2F`). Splitting on `/` before decoding breaks nested folders. Depth max 4.
- **A group a workspace references must exist.** `normalise()` in `server/settings.ts` adds missing groups and their ancestors; a hand-edited `settings.json` self-repairs on load.
- **Windows `fs.watch` reports directory creation** as an event; `watcher.ts` drops pending paths that are directories.
- **The CodeMirror editor is a lazy chunk.** Import it only from `TypstEditor.tsx`; everyone else uses `typst-editor-bridge.ts`, or the chunk lands on the first-paint path.
- **No `window.confirm` or `prompt`.** Use `ConfirmDialog`, which follows the theme.
- **JetBrains Mono is not bundled yet.** The Ember theme names it first in `--font-mono` (`src/index.css`), but it is not installed or shipped, so Cascadia Code renders. Downloading it needs the user's approval.
