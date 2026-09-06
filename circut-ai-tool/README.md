# Circuit AI Tool

Turns a KiCad schematic into a breadboard wiring diagram with a step-by-step
build guide, wiring checks and a logic simulator, and exposes everything as a
REST API and an MCP server for Claude Desktop, Claude Code and ChatGPT.

Design: `docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md`.

## Develop

    bun install
    bun test
    bun run breadboard path/to/project.kicad_sch    # writes layout JSON and SVG next to it

## Run

    bun run build      # once, and after client changes
    bun start          # http://localhost:8765

Open a `.kicad_sch` from the home page (your `Documents\KiCad\9.0\projects`
folder is scanned), drag parts, click switches, follow the guide, print it.
Moved parts, options and colours are saved in `NAME.breadboard.json` next to
the schematic. Saving the schematic in KiCad reloads the board.

## Run in Docker

    docker compose up --build -d      # http://localhost:8765, restarts with Docker Desktop
    bun run docker:smoke              # optional: end-to-end check against the container
    docker compose down               # stop; `docker compose down -v` also drops the cache volume

The image is `kicad/kicad:9.0.9` (kicad-cli plus the stock symbol libraries)
with bun added. Your KiCad projects folder is mounted at `/projects`; it must
already exist before `docker compose up`, since Docker Desktop otherwise
creates an empty root-owned folder there instead of refusing to start. Set
`KICAD_PROJECTS` in a `.env` file (see `.env.example`) to use another folder.
Windows paths sent by Claude Code or the API are translated into `/projects/...`
automatically. The recent list and the kicad-cli cache live in the
`circuit-data` volume; cloudflared is baked into the image at
`/usr/local/bin/cloudflared`. Port 8765 is bound to localhost only; set
`CIRCUIT_HOST_PORT=8766` in `.env` to run it beside `bun start`.

The old `circuit-designer` container used the same port and the same Claude
Code registration (`/mcp-server/mcp`), so nothing needs re-registering.

## Connect Claude, ChatGPT or Claude Code

Open `http://localhost:8765/#/connect` for copy-paste snippets. The MCP
endpoint is `/mcp` (alias `/mcp-server/mcp`); a stdio entry point for Claude
Desktop is `bun server/mcp-stdio.ts`. ChatGPT needs a tunnel (cloudflared or
ngrok) because it only reaches servers on the internet.

## Environment

`CIRCUIT_PORT` (8765), `CIRCUIT_HOST` (127.0.0.1), `KICAD_CLI`, `KICAD_SYMBOL_DIR`,
`KICAD_SYM_LIB_TABLE`, `DATA_DIR` (`%LOCALAPPDATA%\UniversityTools\circuit`),
`PROJECTS_DIR`, `CIRCUIT_WATCH_POLL_MS` (poll the open schematic instead of
inotify; the container sets 1000), `CIRCUIT_PATH_MAP`
(`hostPrefix=containerPrefix;...`), `CIRCUIT_PNG_FONT`, `CIRCUIT_CONTAINER`.
