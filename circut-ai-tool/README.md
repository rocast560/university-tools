# Circuit AI Tool

Turns a KiCad schematic into a breadboard wiring diagram with a step-by-step
build guide, wiring checks and a logic simulator, and exposes everything as a
REST API and an MCP server for Claude Desktop, Claude Code and ChatGPT.

Design: `docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md`.

## Develop

    bun install
    bun test
    bun run breadboard path/to/project.kicad_sch    # writes layout JSON and SVG next to it
