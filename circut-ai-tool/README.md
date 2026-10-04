# BenchMate

BenchMate reads a KiCad schematic and lays it out on a breadboard. You get a
numbered build guide that names every hole, wiring checks, and a logic
simulator you drive by clicking the switches. Everything is also a REST API
and an MCP server, so Claude Desktop, Claude Code and ChatGPT can open a
schematic, edit it, and check the wiring.

It was built for ECE 2300L: 74LS-series chips, DIP switches, LEDs, and the
5161BS common-anode display from the lab kit.

## Run it

    docker compose up --build -d      # http://localhost:8765
    docker compose down               # stop (add -v to drop the cache volume)

Your KiCad projects folder (`Documents\KiCad\9.0\projects` by default) is
mounted at `/projects`. Create it before the first `docker compose up`;
otherwise Docker Desktop makes an empty root-owned folder there. To use a
different folder, set `KICAD_PROJECTS` in `.env` (see `.env.example`).

The port is bound to localhost. Set `CIRCUIT_HOST_PORT=8766` in `.env` to run
a second copy beside it. The recent-projects list, folders and the kicad-cli
cache live in the `circuit-data` volume.

Without Docker:

    bun install
    bun run build      # after any client change
    bun start          # http://localhost:8765

## Use it

Open a `.kicad_sch` from the home page, or type its path. Drag parts to move
them, click switches to change inputs, and tick off guide steps as you wire.
Saving the schematic in KiCad reloads the board.

Moved parts, board options, wire colours and saved tests go in
`NAME.breadboard.json` beside the schematic, so they travel with the project.

Large circuits: pick **stacked** under Options to lay the circuit over two
full boards, one above the other. Columns run 1-63 on the top board and
64-126 on the bottom one, so a step such as "a70" means the bottom board.

Saved tests: each one is a set of switch positions plus what the LEDs and
display should show. Pick one in the Simulate tab and BenchMate sets the
switches and marks it Pass or Fail. Write them with the `set_sim_tests` MCP
tool or `POST /api/projects/<id>/layout/tests`.

The simulator models 74LS gates, the 74LS138, 74LS283 and 74LS47/48. Other
parts are placed and checked but not simulated, and the analog model is
approximate.

**Create Lab 3 prelab example** on the home page builds the BCD to
seven-segment circuit on the instructor's L3 Auxiliary board. Its header,
pinout and limits are in [docs/lab3.md](docs/lab3.md).

## Connect an assistant

`http://localhost:8765/#/connect` has copy-paste setup for each client. The
MCP endpoint is `/mcp` (`/mcp-server/mcp` also works). Claude Desktop can
use the stdio entry point, `bun server/mcp-stdio.ts`. ChatGPT only reaches
servers on the internet, so it needs a tunnel; cloudflared is in the image at
`/usr/local/bin/cloudflared`.

Windows paths from Claude Code or the API are mapped to `/projects/...`, and
the MCP server is still registered as `circuit-designer`, so existing setups
keep working after the rename.

## Develop

    bun test
    bun run typecheck
    bun run breadboard path/to/project.kicad_sch   # layout JSON and SVG beside it
    bun run docker:smoke                           # end-to-end check against the container

The image is `kicad/kicad:9.0.9` (kicad-cli and the stock symbol libraries)
with bun added. The original design notes are in
`docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md`.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CIRCUIT_PORT` | 8765 | Port the server listens on |
| `CIRCUIT_HOST` | 127.0.0.1 | Address it binds to |
| `CIRCUIT_HOST_PORT` | 8765 | Host port in docker-compose |
| `KICAD_PROJECTS` | `Documents\KiCad\9.0\projects` | Folder mounted at `/projects` |
| `PROJECTS_DIR` | | Folder scanned for schematics |
| `DATA_DIR` | `%LOCALAPPDATA%\UniversityTools\circuit` | Recent list, folders, cache |
| `KICAD_CLI`, `KICAD_SYMBOL_DIR`, `KICAD_SYM_LIB_TABLE` | | Where KiCad lives |
| `CIRCUIT_PATH_MAP` | | `hostPrefix=containerPrefix;...` path translation |
| `CIRCUIT_WATCH_POLL_MS` | | Poll the open schematic instead of inotify (the container uses 1000) |
| `CIRCUIT_PNG_FONT`, `CIRCUIT_CONTAINER` | | PNG export font, container name for the connect page |
