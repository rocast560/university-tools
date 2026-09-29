# AGENTS.md: Circuit AI Tool

Guidance for AI coding agents working in this directory. People should start with README.md.

## Commands
- `bun test`: unit and integration tests (Bun). Must stay green.
- `bun run typecheck`: `tsc --noEmit`. Must stay clean.
- `bun run build`: Vite client build into `dist/` (the server serves it).
- `bun scripts/e2e-3d.ts [scenario…]`: headless Chrome end-to-end checks of the 3D editor. Needs a build first and kicad-cli.
- `bun server/index.ts`: the app on :8765 (`CIRCUIT_PORT` overrides).

## Map
- `src/`: pure pipeline: netlist → layout engine (`src/layout/engine.ts`) → `LayoutDoc` (`src/pipeline.ts`) → SVG (`src/render/`), checks, guide, simulators.
- `src/edit/placement.ts`: pure placement rules (validity, shorts, rotate, flip). Shared by the 3D editor and future tools.
- `server/`: Hono API (`server/api.ts`), `Service` (`server/service.ts`), MCP server (`server/mcp.ts`).
- `client/`: vanilla TS SPA. `board.ts` is the flat board; `board3d.ts` and `board3d-parts.ts` are the three.js scene.
- `client/editor3d/`: the 3D editor.
  - `workspace.ts`: the shell and key routing.
  - `manipulate.ts`: select, drag, rotate and flip.
  - `card.ts`: the part card.
  - `history.ts`: undo.
  - `focus-math.ts`: camera framing.
- `client/view3d.ts`: opens and closes the editor, and owns the history entry.

## Invariants (do not break)
- Layout-only changes go through `api.move` → `POST /api/projects/:id/layout/move` → `Service.movePart`, which writes `sidecar.pinned`.
- Schematic changes go through `/api/projects/:id/edit/*` → `Service.edit` (it backs up first, into `.circuit-ai-backups/` beside the schematic). The client then calls `loadProject(id)`.
- The server does not announce its own edits as "changed on disk": `startWatch` compares the file's mtime and size with `selfWrites` (what `edit()` last wrote) and skips the event on a match. So a card edit causes no reload toast. An external change still does, and the client reload resets selection and undo history.
- `src/**`, `client/editor3d/history.ts` and `client/editor3d/focus-math.ts` stay free of DOM and three.js.
- `Package.flipped` is `true` or absent, never `false`, so unflipped docs serialize exactly as before.
- In the scene, every part/package group has `userData.ref` and is on raycast layer 1. Jackets are on layer 2, switch ways on layer 3.
- Pick is depth-ordered: a switch first, then whichever of the part or jumper is nearer.
- The editor decides drag vs orbit on `pointerdown` (capture phase) and calls `board.setOrbit(false)` synchronously. Only an already-selected part can start a drag.
- The workspace has a single `release()` teardown, used by both `close()` and a failed setup. Add new listeners and subscriptions to it.
- `History` is serialised (one operation at a time) and generation-guarded: `clear()` bumps a counter so queued or in-flight operations cannot touch the stacks afterwards. Commands hold model data, not scene objects.
- Key routing lives in `workspace.ts`. Ctrl, Cmd and Alt chords belong to the browser except Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. Modules add handlers with `addKeyHandler`.
- No `window.confirm`/`alert`/`prompt` anywhere in the client.
- Commits: no Co-Authored-By / Claude-Session / Generated-with footers.

## Testing notes
- three.js code has no unit tests (no WebGL in Bun). Cover it with `scripts/e2e-3d.ts`.
- The `?e2e` URL flag exposes `window.__e3d`: `ready`, `selected`, `holes`, `screenOf`, `parts`, `lead2`, `chips`, `select`, `pickAt`, `tintCount`. It also honours the test-only knobs `window.__e3dDelay` (ms to hold the three.js download) and `window.__e3dFailMount` (make mounting throw).
- The headless-Chrome harness renders at about 3 fps. Scenarios must poll with `until` rather than assume a frame has happened.
- Don't measure UI timing in the Chrome MCP tab: it is a background tab clamped to 1 s timers. Use the headless harness.

## Design docs
- `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md`: the 3D editor spec (phases 1 to 3).
- `docs/superpowers/plans/`: implementation plans.
- `docs/editor3d.md`: the user guide.
