# Typst Studio

Local Typst editor with a live preview, an assets rail for screenshots and fonts, and an MCP server for Claude.

## Run in Docker (recommended)

    docker compose up --build -d

Open http://localhost:8090. Documents live in `./data` (bind-mounted, so the dev server sees the same workspaces). The container restarts with Docker Desktop. Stop it with `docker compose down`; rebuild after pulling changes with `docker compose up --build -d`.

Before starting the container, stop any dev backend on port 8090.

## Run from source

    bun install
    bun --watch server/index.ts     # API + MCP on http://127.0.0.1:8090
    bun run dev                     # UI on http://127.0.0.1:5173 (proxies /api and /mcp)

## Connect Claude

Settings → Connect Claude has copy buttons for the Claude Code command and the Claude Desktop config. The endpoint is `http://localhost:8090/mcp` in both setups.

## Tests

    bun run test:ui
    bun run test:server
    bun run typecheck
