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

## Connect Claude, ChatGPT or Claude Code

Open `http://localhost:8765/#/connect` for copy-paste snippets. The MCP
endpoint is `/mcp` (alias `/mcp-server/mcp`); a stdio entry point for Claude
Desktop is `bun server/mcp-stdio.ts`. ChatGPT needs a tunnel (cloudflared or
ngrok) because it only reaches servers on the internet.

## Environment

`CIRCUIT_PORT` (8765), `CIRCUIT_HOST` (127.0.0.1), `KICAD_CLI`, `KICAD_SYMBOL_DIR`,
`DATA_DIR` (`%LOCALAPPDATA%\UniversityTools\circuit`), `PROJECTS_DIR`.
