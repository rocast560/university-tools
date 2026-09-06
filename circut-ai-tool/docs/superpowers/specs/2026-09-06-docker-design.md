# Circuit AI Tool: Docker packaging

Date: 2026-09-06. Branch: `docker-perf`. Status: draft for the user's review. The
decisions in section 7 were taken without asking; every one of them can be
overridden before the plan is executed.

Companion to the Typst Studio design of 2026-09-05
(`advanced-typst-editor/docs/superpowers/specs/2026-09-05-docker-and-performance-design.md`),
which fixed the house style: compose file inside the app folder, loopback host
port, `restart: unless-stopped`, non-root user, health check on `/api/health`.

## 1. Goal

Run the Circuit AI Tool as a container the way the old Python `circuit-designer`
container ran: host port 8765 on loopback, the KiCad projects folder mounted,
restarts automatically. The existing Claude Code registration
`http://localhost:8765/mcp-server/mcp` keeps working unchanged. The web UI,
REST API, OpenAPI document and MCP server behave the same as `bun start` on
Windows, including PNG export, the tunnel button and reload-on-save.

## 2. Findings that drive the design

Verified on 2026-09-06.

### 2.1 The app today

`bun start` serves `http://127.0.0.1:8765`; 132 tests pass; kicad-cli 9.0 is
found; the PL1_1 project renders (19 wires, 0 errors); `/api/projects`,
`/openapi.json` and an MCP `initialize` over `/mcp` all answer.

### 2.2 The old container

`docker inspect circuit-designer-circuit-designer-1`:

| Item | Value |
|---|---|
| Image | built `FROM kicad/kicad` (KiCad 9.0.9, Debian 12.13, glibc 2.36), 2.49 GB |
| User | `kicad`, uid 1000, passwordless sudo (inherited from the base) |
| Port | `8765/tcp` published on all interfaces |
| Restart | `unless-stopped` |
| Mounts | `Desktop\circuit-designer\data` at `/data`, `...\inbox` at `/inbox` |
| State | `Restarting (1)` every ~40 s: `PermissionError: /data/projects` |

The host folders it mounts are empty and dated today: the project was tidied off
the Desktop and Docker Desktop recreated the mount points, root-owned. Because
the crash loop releases port 8765 between attempts, today's `bun start` bound
the port and Claude Code's `circuit-designer` entry reported "Connected" against
the new server. That will flip-flop until the old container is removed.

### 2.3 The KiCad image

`kicad/kicad:9.0` (Docker Hub, updated 2026-05-03, currently 9.0.9): 0.44 GB
compressed; contains kicad-cli at `/usr/bin/kicad-cli`, 224 symbol libraries at
`/usr/share/kicad/symbols` (Device, Connector, 74xx, Switch all present),
footprints and templates. `9.0-full` (1.04 GB) adds the 3D models, which this
app never uses. The global table is at
`/home/kicad/.config/kicad/9.0/sym-lib-table` and uses `${KICAD9_SYMBOL_DIR}`,
which `parseSymLibTable` already substitutes. No curl, no cloudflared, six
fonts. Source: `gitlab.com/kicad/packaging/kicad-cli-docker`, Debian bookworm.

`oven/bun:1.3` exists (1.3.14 as of 2026-05-13). The `bun` binary is a single
file and copies cleanly into another image. `@resvg/resvg-js` 2.6.2 ships a
`linux-x64-gnu` optional dependency, fine on glibc 2.36.

### 2.4 Windows assumptions in the server

| Where | Assumption | Effect in a Linux container |
|---|---|---|
| `server/config.ts` | `KICAD_CLI` defaults to `%LOCALAPPDATA%\...\kicad-cli.exe`; `DATA_DIR`, `PROJECTS_DIR`, `KICAD_SYMBOL_DIR` likewise | All overridable by env; defaults are useless on Linux |
| `server/kicad-cli.ts` `available()` | `access(exe)` on the configured path | A bare `kicad-cli` on PATH reports "NOT FOUND" while exports still work |
| `server/libraries.ts` | sym-lib-table under `%APPDATA%\kicad\9.0` | Table never read; falls back to `symbolDir/<nick>.kicad_sym`, which works for stock libs but not for table-only nicknames |
| `server/watch.ts` | `fs.watch` on the schematic's folder | Docker Desktop (WSL2) does not forward inotify for Windows bind mounts (docker/for-win #12766, #12898); reload-on-save is dead |
| `server/service.ts` `open()` | Path is used as given | MCP clients on the host send `C:/Users/rober/Documents/KiCad/...`; inside the container that path does not exist |
| `server/png.ts` | `defaultFontFamily: 'Consolas'` | Missing font; labels render in whatever fontconfig picks, possibly nothing |
| `server/tunnel.ts` | Downloads `cloudflared-windows-amd64.exe` | Throws "only wired up for Windows" |
| `server/connect.ts` | stdio snippet is `process.execPath` + script path | Would print `/usr/local/bin/bun /app/server/mcp-stdio.ts`, meaningless on the host |
| `client/main.ts` | Placeholder `C:\Users\you\Documents\KiCad\...` | Misleading; container paths are `/projects/...` |

Everything else (Hono app, MCP transport, layout engine, renderer, tests) is
platform-neutral.

## 3. Architecture

### 3.1 Image (`circut-ai-tool/Dockerfile`)

Two stages plus an optional test target.

**`client`** (`oven/bun:1.3`): `bun install --frozen-lockfile`, `bun run build`.
Output: `dist/`.

**runtime** (`kicad/kicad:9.0.9`, pinned; bump deliberately):

1. `COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun`.
2. `apt-get install --no-install-recommends fonts-dejavu-core ca-certificates`
   (the PNG renderer needs a real monospace font; cloudflared needs CA roots).
3. Download `cloudflared-linux-amd64` from the GitHub `releases/latest`
   URL into `/usr/local/bin/cloudflared` (same unpinned source the Windows
   path uses today). It is only exercised when the user presses Tunnel.
4. Harden the inherited user: remove `kicad` from `sudo` and delete the
   NOPASSWD line the base image adds. Keep uid 1000.
5. `WORKDIR /app`; copy `package.json` and `bun.lock`;
   `bun install --frozen-lockfile --production` (pulls `@resvg/resvg-js-linux-x64-gnu`).
6. Copy `server/`, `src/` (the server imports twelve modules from it),
   `tsconfig.json`, and `dist/` from the `client` stage.
7. `mkdir /data /projects && chown kicad:kicad /data /projects`.
8. `ENV`:

   | Variable | Value | Why |
   |---|---|---|
   | `NODE_ENV` | `production` | |
   | `CIRCUIT_HOST` | `0.0.0.0` | reachable through the port proxy |
   | `CIRCUIT_PORT` | `8765` | |
   | `CIRCUIT_PUBLIC_URL` | `http://localhost:8765` | what the snippets print for the host |
   | `KICAD_CLI` | `/usr/bin/kicad-cli` | absolute, so `available()` is true |
   | `KICAD_SYMBOL_DIR` | `/usr/share/kicad/symbols` | |
   | `KICAD_SYM_LIB_TABLE` | `/home/kicad/.config/kicad/9.0/sym-lib-table` | new, see 3.3 |
   | `DATA_DIR` | `/data` | registry, kicad-cli cache, cloudflared |
   | `PROJECTS_DIR` | `/projects` | scanned for `.kicad_sch`; upload target |
   | `STATIC_DIR` | `/app/dist` | |
   | `CIRCUIT_WATCH_POLL_MS` | `1000` | new, see 3.3 |
   | `CIRCUIT_CONTAINER` | `circuit-ai-tool` | new, see 3.3; tells the snippets they run in Docker |

9. `USER kicad`, `VOLUME /data`, `EXPOSE 8765`, a `HEALTHCHECK` that runs
   `bun -e` with a `fetch` of `http://127.0.0.1:8765/api/health` and exits
   non-zero unless the response is ok, and `CMD ["bun", "server/index.ts"]`.
   The same image speaks MCP over stdio with
   `docker exec -i circuit-ai-tool bun server/index.ts --stdio`.

**`test`** builds on `client`, copies `test/` and runs
`bun run typecheck && bun test`. It is not part of the default build
(`docker build --target test .` runs it on demand and in CI later).

`.dockerignore`: `node_modules`, `dist`, `src-tauri`, `docs`, `.data`,
`*.md`, `.git`. `test/` stays in the context for the `test` target.

Expected image size about 1.5 GB (base plus bun 95 MB plus production
dependencies 40 MB). The old image was 2.49 GB.

### 3.2 Compose (`circut-ai-tool/docker-compose.yml`)

```yaml
services:
  circuit-ai-tool:
    build: .
    image: circuit-ai-tool:latest
    container_name: circuit-ai-tool
    ports: ["127.0.0.1:8765:8765"]
    volumes:
      - circuit-data:/data
      - ${KICAD_PROJECTS:-C:/Users/rober/Documents/KiCad/9.0/projects}:/projects
    environment:
      - CIRCUIT_PATH_MAP=${KICAD_PROJECTS:-C:/Users/rober/Documents/KiCad/9.0/projects}=/projects
    restart: unless-stopped
volumes:
  circuit-data:
```

`KICAD_PROJECTS` can be set in a `.env` file next to the compose file to point
at another folder; both the mount and the path map follow it. Port 8765 is bound
to loopback only. While the container runs, a dev server needs
`CIRCUIT_PORT=8766 bun start`.

### 3.3 Server changes

Each change is small, keeps Windows behaviour identical, and gets a unit test.

1. **Platform defaults** (`config.ts`). On non-Windows: `KICAD_CLI` = `kicad-cli`
   (on PATH), `KICAD_SYMBOL_DIR` = `/usr/share/kicad/symbols`, `DATA_DIR` =
   `$XDG_DATA_HOME` or `~/.local/share` + `/university-tools/circuit`,
   `PROJECTS_DIR` = `~/KiCad/9.0/projects`. Windows defaults unchanged.
   `config.ts` also exports `WATCH_POLL_MS`, `PATH_MAP`, `CONTAINER`,
   `SYM_LIB_TABLE` and `PNG_FONT` read from the new env vars.
2. **PATH-aware availability** (`kicad-cli.ts`). `available()` resolves a bare
   command name with `Bun.which` before falling back to `access`.
3. **Symbol table location** (`libraries.ts`). New `KICAD_SYM_LIB_TABLE` env;
   default `%APPDATA%\kicad\9.0\sym-lib-table` on Windows,
   `$XDG_CONFIG_HOME or ~/.config` + `/kicad/9.0/sym-lib-table` elsewhere.
   `boot.ts` passes it as `tableFile`.
4. **Polling watcher** (`watch.ts`). `watchFile(file, onChange, { debounceMs, pollMs })`
   polls with `setInterval` plus `statSync` (mtime, size, or the file going
   missing and coming back) when `pollMs > 0`, otherwise today's `fs.watch`. `Service` receives `pollMs` from `boot.ts` and
   passes it down. The existing 300 ms debounce stays in front of both.
5. **Host path mapping** (`projects.ts`, `service.ts`). `CIRCUIT_PATH_MAP` is a
   `;`-separated list of `hostPrefix=containerPrefix`. `mapHostPath(p, map)`
   normalises backslashes, matches prefixes case-insensitively on the host side,
   longest prefix wins, and rewrites the first match. `Service.open()` applies it
   before `normalizePath`. One-way: responses, the registry and the UI show
   container paths. On a miss the 404 message lists the configured mappings so
   the user can see why.
6. **PNG font** (`png.ts`). Font family from `CIRCUIT_PNG_FONT`, default
   `Consolas` on Windows and `DejaVu Sans Mono` elsewhere, passed as both
   `defaultFontFamily` and `monospaceFamily` so the SVG's
   `ui-monospace, Consolas, monospace` stack resolves.
7. **Tunnel binary** (`tunnel.ts`). `ensureBinary` checks `Bun.which('cloudflared')`
   first; the download path is unchanged and still Windows-only.
8. **Container-aware snippets** (`connect.ts`, `api.ts`, `client/main.ts`).
   When `CIRCUIT_CONTAINER` is set: the Claude Desktop and Claude Code stdio
   commands become `docker exec -i <name> bun server/index.ts --stdio`; the
   ChatGPT snippet says `docker compose up -d` instead of `bun start`; the
   curl example uses `<PROJECTS_DIR>/lab1/lab1.kicad_sch`. `/api/projects` gains
   `projectsDir`, and the home page builds its placeholder from it.

### 3.4 Data flow: Claude Code opens a schematic

1. Claude Code posts to `http://localhost:8765/mcp-server/mcp`; Docker's port
   proxy delivers it to bun on `0.0.0.0:8765`.
2. `open_schematic("C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch")`
   passes through `mapHostPath` and becomes `/projects/PL1_1/PL1_1.kicad_sch`.
3. `Service.load` stats the file on the bind mount, runs
   `kicad-cli sch export netlist` (result cached in `/data/cache` by content
   hash, so a second open is free), builds the layout, and returns the summary
   with the container path.
4. The user saves in KiCad on Windows. Within one poll interval the stat poll
   sees the new mtime or size, the debounce fires, `refresh` re-exports, and the
   SSE `changed` event reloads the board in the browser.

### 3.5 Cutover from the old container

The old container must go before the new one can hold port 8765. This is a
destructive step and the plan stops to ask before running it:

```
docker rm -f circuit-designer-circuit-designer-1
docker rmi circuit-designer-circuit-designer   # optional, frees 2.49 GB
```

Its bind-mount folders on the Desktop are empty and dated today, so there is
nothing to migrate from them. The Claude Code registration is not touched: the
new container answers on the same URL.

## 4. Error handling

- kicad-cli missing or broken: `/api/health` reports `kicad: false`; every
  open fails with the existing `KicadError` text. The container still starts.
- Bind-mount source missing: compose refuses to start with Docker's own error.
  The README says the folder must exist.
- Path not under any mapping: 404 `schematic not found: <path>` plus the list
  of mappings.
- Polling watcher on a deleted file: `stat` fails, `refresh` throws, the
  existing `error` event is emitted, as today.
- PNG font missing: resvg falls back to any available family; the smoke test
  checks the PNG is non-trivial in size so an all-blank render is caught.
- cloudflared missing on PATH on Linux: the existing "install cloudflared"
  error appears in the Tunnel panel.

## 5. Testing

Unit tests, run with `bun test` on Windows and inside the `test` image target:

- `config`: defaults per platform (import the module with a stubbed
  `process.platform` and env).
- `kicad-cli`: `available()` is true for a bare name that `Bun.which` resolves.
- `libraries`: table path default per platform; env override wins.
- `watch`: polling mode fires once after a write to a temp file, respects the
  debounce, and stops cleanly.
- `projects`: `mapHostPath` handles backslashes, case, longest-prefix wins, no
  match returns the input unchanged.
- `connect`: container mode prints `docker exec -i circuit-ai-tool ...`.
- `png`: font selection per platform and env.

`scripts/docker-smoke.ts`, run from the host against a running container:
waits for `/api/health` with `kicad: true`, opens the `PL1_1` fixture through a
temporary projects folder mounted at `/projects` using a **host-style** path
(proves the mapping), asserts components are present, `board.svg` and
`board.png` return 200 with the PNG above 20 KB, checks report no errors, and
both `/mcp` and `/mcp-server/mcp` complete an `initialize`.

Manual: `docker compose up --build -d`; health turns green; open
`http://localhost:8765`, open PL1_1, save it in KiCad and see the board reload
within about two seconds; `claude mcp list` shows `circuit-designer` connected;
`open_schematic` with the Windows path works from Claude Code; Tunnel button
produces a `trycloudflare.com` URL.

## 6. Out of scope

- The Tauri shell and its sidecar build (untouched; `STATIC_DIR`, `DATA_DIR`
  semantics do not change).
- Typst Studio and Chemistry Tool containers.
- A smaller custom KiCad build (only `kicad-cli` and symbols); revisit if 1.5 GB
  matters.
- arm64 images; an auth token (loopback only, same as today); reverse path
  mapping in responses.

## 7. Decisions taken without asking

1. **Base image**: official `kicad/kicad:9.0.9` with bun copied in, not
   `oven/bun` with KiCad from a PPA. It is the image KiCad maintains, the old
   container used the same family, and it pins the exact kicad-cli version.
2. **`/data` is a named volume, not a bind mount.** Unlike Typst Studio, the
   documents here are the schematics, which are bind-mounted from the KiCad
   projects folder. `/data` only holds the recent list (absolute container
   paths), the kicad-cli cache and cloudflared, none of which is meaningful on
   the host.
3. **Port 8765 on loopback**, same as the old container and the Claude Code
   registration.
4. **The old crash-looping container is removed** during cutover (with a
   confirmation step).
5. **cloudflared is baked into the image** so the Tunnel button works.
6. **Path mapping is one-way** (host to container). Responses show container
   paths.
7. **Compose lives in `circut-ai-tool/`** like the Typst design; no repo-root
   compose that would build all three apps.
8. **No `test` in the default build**; it is a separate target so
   `docker compose up --build` stays fast.
