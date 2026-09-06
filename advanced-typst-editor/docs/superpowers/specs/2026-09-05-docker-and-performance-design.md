# Typst Studio: Docker packaging, switching performance, sidebar and settings polish

Date: 2026-09-05. Branch: `docker-perf`. Approved by the user in chat (bind-mounted data, Web Worker included, backups folder mounted).

Backup taken before any change: `C:\Users\rober\Desktop\backups\advanced-typst-editor-2026-09-05` (everything except `node_modules/` and `dist/`).

## 1. Goal

1. Run the app in a Docker container again, the way the old `typst-editor` container ran: host port 8090, data persisted outside the image, backups folder mounted, restarts automatically.
2. Make switching between workspaces and between `.typ` files inside a workspace feel instant.
3. Render more efficiently: the compiler must not block typing.
4. Sidebar: collapsible groups with arrows; the MCP / backup status stays pinned at the bottom.
5. Settings: a clean "Connect Claude" section with copy buttons for Claude Code and Claude Desktop.

## 2. Findings that drive the design

Measured on 2026-09-05 in Chrome against the dev server, with the 23-page `cptc-report` and the 2-page `ccdc-inject-template`:

| Observation | Value |
|---|---|
| Workspace switch, click to preview ready | 2.0 to 2.7 s, every time, both directions |
| Fetches per switch | 18 to 26, including all 17 default fonts from `/fonts/` |
| wasm compile + SVG render of the 23-page report | about 80 ms |
| Long tasks during a switch | none over 50 ms (the cost is many async steps, not one block) |

Cause: `lib/typst-compiler.ts` supplies fonts to typst.ts only at `init`. A workspace with its own fonts changes the font set, so `getInstance()` drops the compiler and builds a new one: re-instantiate the 28 MB wasm module, re-fetch and re-parse the 17 default fonts plus the workspace's, then compile. The dropped instance's wasm memory is never freed, which is the 3 to 8 GB growth noted in the project memory.

typst.ts 0.7 exposes `TypstCompiler.setFonts(TypstFontResolver)` ("multiple compilers can share the same fonts") and `createTypstFontBuilder()` with `addFontData` and `build(cb)`. Fonts can therefore be swapped on a live compiler.

The old container (inspected with `docker inspect typst-editor`): `oven/bun` base, `HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist DATA_DIR=/data`, `VOLUME /data`, user `bun`, health check on `/api/health`, host port 8090, named volume `typst-editor_tfs-data`, bind mount `C:\Users\rober\Desktop\typst-editor\backups` at `/host`, `restart: unless-stopped`.

`data/settings.json` stores absolute Windows paths for every workspace. Inside a container those paths do not exist, so every workspace would show as "missing" and `scanLibrary` would add a second, ungrouped entry for each folder. That is the same mechanism behind the stale `.worktrees\typst-studio\...` duplicates in the sidebar today.

**Measured after Tasks 2 and 3 (2026-09-06, Chrome, dev server, worker enabled):**

| Operation (through the worker) | Time |
|---|---|
| Worker cold start (wasm + 17 default fonts), once per page | 925 ms |
| Warm compile + SVG render, 23-page cptc-report | 48 to 89 ms |
| Swap to default fonts + compile 2-page ccdc-inject-template | 47 ms |
| Swap to Poppins (6 faces, 981 KB) + compile cptc-report | 422 ms first time, 82 ms after |
| PDF export, cptc-report | 136 ms |
| Main-thread long tasks during a warm compile | none |

No `/fonts/` request is made after the first page load: the worker keeps the default faces in memory and swaps fonts with `setFonts`. The click-to-preview switch timing in the table above could not be re-measured cleanly because the browser window was in the background, which clamps the preview's 350 ms debounce and any polling to 1 s; the earlier 2.0 to 2.7 s figures were taken under the same throttling and are therefore an upper bound on both sides. The compile path itself, measured without timers, dropped from a full compiler rebuild per switch to under half a second.

Found on the way: `getFontInfo` returns null because typst.ts hands back `{ info: [ { family, … } ] }` and the family is read one level too high; this predates the worker and is fixed in the final review wave.

## 3. Architecture

### 3.1 Docker

Files added at `advanced-typst-editor/`: `Dockerfile`, `docker-compose.yml`, `.dockerignore`.

Build stage (`oven/bun:1.3`):

1. `bun install --frozen-lockfile`.
2. `bun scripts/fonts.ts` so `public/fonts/` exists in the image even on a fresh clone (it skips files already present; the CDN is only touched for missing ones).
3. `bun run build` (typecheck + Vite build to `dist/`).
4. Precompress `dist/assets/*.{js,css,wasm}` with `gzip -9 -k`; `server/static.ts` already prefers a `.gz` sibling.
5. Download typst 0.14.2 (`typst-x86_64-unknown-linux-musl.tar.xz` from the GitHub release, 15.9 MB) and extract the binary. 0.14.2 is the version installed on the laptop and the one that matches typst.ts 0.7.

Runtime stage (`oven/bun:1.3-slim`):

- `bun install --frozen-lockfile --production` for the server's runtime deps (`@modelcontextprotocol/sdk`, `fflate`, `jimp`, `zod`).
- Copy `server/`, `src/types.ts`, `src/template.ts`, `src/lib/` (the server imports `blur-math`, `crop-math`, `image-format`, `typst-geometry`, `typst-placeholders`), both `tsconfig` files (the `@/*` alias), `dist/`, and the typst binary at `/usr/local/bin/typst` (found through `PATH` by `resolveTypstCli`).
- `ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist DATA_DIR=/data`, `EXPOSE 8080`, `VOLUME /data`, `USER bun`, the same health check as before, `CMD ["bun", "server/index.ts"]`.

`docker-compose.yml`:

```yaml
services:
  typst-studio:
    build: .
    image: typst-studio:latest
    container_name: typst-studio
    ports: ["127.0.0.1:8090:8080"]
    volumes:
      - ./data:/data
      - C:/Users/rober/Desktop/typst-editor/backups:/host
    environment:
      - APP_TOKEN=${APP_TOKEN:-}
    restart: unless-stopped
```

The bind mount of `./data` is the user's choice: the container and the dev server share the same documents. The MCP endpoint stays `http://localhost:8090/mcp`, so the Claude Code registration keeps working. Port 8090 is bound to loopback only.

`.dockerignore` excludes `node_modules`, `dist`, `data`, `docs`, `.vite`, `*.md`.

### 3.2 Portable workspace registry (server)

`settings.scanLibrary(workspacesDir)` gains a self-heal step that runs before the directory scan:

- For every entry with `library: true` whose `path` is not a directory, if `<workspacesDir>/<name>` is a directory, re-point the entry there.
- If another entry already owns that path, merge: the surviving entry keeps its id and gains the stale entry's `group` when it has none; the stale entry is removed.
- External (`library: false`) entries are never touched; they keep showing "missing" with the "Locate folder" action.

Effect: the same `data/` folder works under Windows paths and under `/data` in the container, and the six stale `.worktrees` entries collapse into the six live ones, keeping their CPTC and ECE-2300L groups. Covered by `server/settings.test.ts`.

### 3.3 Compiler in a Web Worker, fonts via `setFonts`

`src/lib/typst-compiler.ts` keeps its public API unchanged (`compileTypstSvg`, `compileTypstPdf`, `setTypstFonts`, `setTypstShadowFiles`, `getFontInfo`, `typstErrorMessage`, `TypstShadowFile`, `TypstSvgResult`, `TypstDiagnostic`). Its body becomes a client of a module worker:

- `src/lib/typst-compiler.worker.ts` owns the compiler and renderer. It is created with `new Worker(new URL('./typst-compiler.worker.ts', import.meta.url), { type: 'module' })`, which Vite bundles as its own chunk.
- One compiler and one renderer for the worker's lifetime. The wasm module is instantiated once.
- Fonts: on `setFonts(bytes[])` the worker builds a `TypstFontResolver` from the default font bytes (fetched from `/fonts/` once and kept in worker memory, about 8.4 MB) plus the workspace bytes, calls `compiler.setFonts(resolver)` inside the builder callback, then `compiler.reset()` so the font cache is dropped. No compiler rebuild, no leaked wasm memory.
- Shadow files and fonts are posted only when their generation changes (the existing `setTypstShadowFiles` / `setTypstFonts` change detection stays on the main thread). Bytes are copied with structured clone, not transferred, so the main thread keeps its caches.
- Messages: `{ id, op: 'svg' | 'pdf' | 'fontInfo' | 'setFonts' | 'setShadow', ... }` with `{ id, ok, value | error }` replies. The main-thread side keeps the serialized queue and the coalescing sequence exactly as today (`coalesce: true` previews that are superseded before they start return `{ superseded: true }` without a round trip).
- Fallback: if `Worker` is undefined (jsdom, very old browsers) the same driver code runs inline on the main thread. The driver is a plain module (`typst-compiler.driver.ts`) imported by both the worker and the fallback, so the wasm-facing code exists once.

Preview behaviour is unchanged: the main thread receives the SVG string, splits it per page, and mounts only changed, visible pages.

### 3.4 Sidebar

- Group headers render a `ChevronDown` / `ChevronRight` icon before the name. Clicking the header toggles the group; the items list is not rendered while collapsed.
- Collapsed state is a `Set<string>` in `localStorage` under `tfs-collapsed-groups`; the loose (ungrouped) list is never collapsible.
- The header remains the drop target and the context-menu target, so dragging a workspace onto a collapsed group still files it.
- If the active workspace is inside a collapsed group, the group stays collapsed (the user collapsed it deliberately); the active state is visible again on expand.
- Footer: the two status rows stay pinned at the bottom (`shrink-0` under the scrolling list). Each row becomes a button that opens Settings, text tightened to "MCP: connected (claude-code)" / "MCP: no client" and "Backup: 23:41" / "Backup: not set up" / "Backup error".

### 3.5 Settings: Connect Claude

The MCP section is replaced by a "Connect Claude" section with three rows, each a labelled read-only code line and a copy button (clipboard API, button flips to a check mark for 1.5 s):

1. Endpoint: `http://localhost:8090/mcp` (plus a token note when `authRequired`).
2. Claude Code: `claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp`.
3. Claude Desktop: a JSON block for `claude_desktop_config.json`:
   ```json
   { "mcpServers": { "typst-figure-studio": { "command": "bun", "args": ["<repo>/advanced-typst-editor/server/mcp-stdio.ts"] } } }
   ```
   The path comes from a new `stdioBridge: string | null` field on `GET /api/mcp/status`: the server fills it with the absolute path of `server/mcp-stdio.ts` when that file exists next to the running server and the server is not inside a container (no `/.dockerenv`); otherwise `null`, and the UI shows `<path to advanced-typst-editor>/server/mcp-stdio.ts` with one line explaining that the bridge runs on the machine where Claude Desktop runs.

Below the rows, the connected-clients list as today. The hardcoded `C:/Users/rober/...` string disappears.

## 4. Data flow: switching a workspace, after the change

1. Sidebar click → `selectWorkspace` → `detail` reloads (one fetch).
2. `useTypstAssetSync` resolves image, font and plain-file bytes (memoized by id, crop and mtime as today).
3. `setTypstFonts` sees a different font list → posts the bytes to the worker → worker builds a resolver (default bytes already in memory) → `setFonts` + `reset`. Expected 100 to 300 ms.
4. `revision` bumps → preview debounce → `compileTypstSvg` → worker compiles (about 80 ms for 23 pages) → SVG back to the main thread → split, mount the two eager pages.

Target: under 0.5 s from click to preview, no wasm re-instantiation, flat memory across repeated switches.

## 5. Error handling

- Worker failure (script fails to load, wasm init throws): the client rejects the pending calls with the error message, the preview shows its existing fatal-error banner, and the next call retries by creating a fresh worker.
- `setFonts` with a font typst cannot parse: the worker logs the file and skips it; the rest of the set is installed (matches today's `allSettled` behaviour upstream).
- Docker: a missing `dist/index.html` makes the server answer routes with the existing "client not built" 503 text; the health check only tests `/api/health`.
- Self-heal never deletes folders; it only edits `settings.json` entries.

## 6. Testing

- `src/test/typst-compiler-client.test.ts`: the client's queue, coalescing and message framing against a fake worker (`postMessage` / `onmessage` stub).
- `src/test/sidebar.test.tsx`: collapse toggles items, state persists in `localStorage`, dropping on a collapsed header still calls `setWorkspaceGroup`.
- `src/test/settings-connect.test.tsx`: the three copy buttons write the expected strings via a stubbed `navigator.clipboard`; the Docker placeholder renders when `stdioBridge` is null.
- `server/settings.test.ts`: self-heal re-points a missing library entry by name; merges a duplicate and keeps the group; leaves external entries alone.
- Manual: `docker compose up --build`, health check green, app reachable at `http://localhost:8090`, workspaces listed once each with their groups, MCP status from Claude Code; browser timing of cptc-report ↔ ccdc-inject-template switches before and after, and typing with the 23-page report open shows no long task from the compiler.

## 7. Out of scope

- The Tauri launcher and sidecar build are untouched (they keep working; `STATIC_DIR` and `DATA_DIR` semantics do not change).
- Incremental (diff-based) rendering inside typst.ts sessions. The per-page virtualization already removes the DOM cost; the worker removes the compile cost.
- Chemistry Tool and circuit-designer containers.
