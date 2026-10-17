---
type: reference
status: active
updated: 2026-10-17
verified: 2026-10-17
source: university-tools@fde194f; package.json; Dockerfile; docker-compose.yml; README; docker ps and /api/health on 2026-10-17
description: How to run, test, build and deploy Typst Studio: Docker container on 8090, dev server and Vite, vitest projects, typecheck, fonts script, environment variables, MCP registration, ports and paths.
---
# Environment

Contents: Where things are, Run in Docker, Run from source, Test and typecheck, Build, Environment variables, Connect Claude.

Run shell commands from `C:\Users\rober\Desktop\university-tools\advanced-typst-editor`. Use the Git Bash tool, not `bash` from PowerShell ([gotchas](gotchas.md)).

## Where things are

| What | Where |
|---|---|
| App | `C:\Users\rober\Desktop\university-tools\advanced-typst-editor` |
| Git root | `C:\Users\rober\Desktop\university-tools` (shared with other apps) |
| Runtime | Bun 1.3 (host: `~/.bun/bin/bun`); Node types only for typing |
| Data (host) | `advanced-typst-editor\data` = `/data` in the container. Private |
| Backup mount | `C:/Users/rober/Desktop/typst-editor/backups` = `/host` in the container |
| typst CLI (host) | WinGet package `Typst.Typst`, found on `PATH` |
| Container | `typst-studio`, image `typst-studio:latest`, `127.0.0.1:8090` -> `8080`; seen healthy on 2026-10-17 |

## Run in Docker (the user's normal setup)

    docker compose up --build -d       # build and (re)start
    docker compose down                # stop
    curl http://127.0.0.1:8090/api/health    # {"ok":true,"version":"0.1.0"}

The container restarts with Docker Desktop (`restart: unless-stopped`). Stop any dev backend on 8090 first ([gotchas](gotchas.md)). The build installs deps, downloads the typst CLI 0.14.2, runs `bun scripts/fonts.ts`, `bun run build`, and gzips the big assets so `server/static.ts` can serve `.gz` files.

## Run from source

    bun install
    bun --watch server/index.ts        # API + MCP on http://127.0.0.1:8090 (dev:server)
    bun run dev                        # Vite UI on http://127.0.0.1:5173, proxies /api and /mcp

Only one of "container" and "dev backend" may own 8090 at a time. Dev uses `DATA_DIR=./data` by default, the same folder the container mounts.

## Test and typecheck

    bun run test             # vitest run, both projects
    bun run test:ui          # jsdom: src/**/*.test.ts(x)
    bun run test:server      # node: server/**/*.test.ts (20 s timeout)
    bun run typecheck        # tsc for src and for server

`bun run build` runs `tsc -p tsconfig.json` (the `src` tree only) and then Vite. It does not typecheck `server/`; use `typecheck` for that. Baseline pass counts were not recorded; run the suite and write them here ([now](now.md) next step 3).

Test files: 41 files in `src/test/`, 19 in `server/` (counted 2026-10-17). Server tests build real services over temp dirs (`server/test-util.ts`).

## Build

    bun run build            # typecheck + vite build -> dist/
    bun run fonts            # stage the 17 default fonts into public/fonts
    bun run build:sidecar    # compile the server exe for ../launcher (needs dist/ and a typst.exe)

## Environment variables (server)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8090 (container sets 8080) | listen port |
| `HOST` | 127.0.0.1 (container: 0.0.0.0) | bind address |
| `DATA_DIR` | `./data` (container: `/data`) | registry and library root |
| `STATIC_DIR` | unset (container: `/app/dist`) | built UI; unset means API only |
| `TYPST_CLI` | unset | path to the typst binary; otherwise Settings, sidecar, or `PATH` |
| `APP_TOKEN` | unset | when set, `/api` and `/mcp` need `Authorization: Bearer <token>`; `/api/health` stays open |

## Connect Claude

Claude Code: `claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp`. Claude Desktop uses `server/mcp-stdio.ts` through Bun, with `TFS_MCP_URL` and `APP_TOKEN` in its environment (inside a container the path is not offered). Settings > Connect Claude has copy buttons. In this user's setup the MCP server is already registered and its tools load as `mcp__typst-figure-studio__*`. Tool list: [architecture](architecture.md).
