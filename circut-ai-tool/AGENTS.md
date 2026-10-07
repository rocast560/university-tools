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
- `src/render/route3d.ts`: pure router for square wires: A* over a half-pitch lattice, lane packing, rip-up rounds, humps wherever two wires meet, crossing, at a shared corner or along a shared stretch (`hopHeight`: one diameter plus `AIR_Z` clear of the lower wire all round, its own humps included; `rise` and `riseBreaks` are the hump shape, shared with the tube), stacked boards (each board's own wires on that board, then the joining wires shortest first on one lattice of the whole stack, a lane clear of the rest, hopping over what they cross), saved shapes (`pathToPlan`, `planToPath`, `shapePlan`, `simplify`). `ortho.ts` is only its fallback.
- `src/render/centreline.ts`: the 3D centre line of a flat jumper (up out of the hole, the humps, filleted corners, down into the other hole). The tube and the clearance check both draw from it.
- `src/render/clearance.ts`: `clipPairs` and `centreLines`, which measure every pair of jumpers capsule to capsule; tests hold the router to it on whole boards.
- `src/models/manifest.ts`: pure maths for the KiCad part models: the manifest type and its check, `modelKeyFor`, the frame fit, and `bodyPlacement` (centre on all the pins, turn by pins 1 to 2, squeeze across the rows to the drawn gap).
- `scripts/build-models.ts`: `bun run models`, which turns the KiCad 3D models into leg-free GLBs and `public/models/manifest.json`. Needs a local KiCad 9; the output is committed.
- `src/edit/wireshape.ts`: pure hand edits to a wire plan (handles, snap, move a run or a bend, add or remove a bend pair).
- `client/wiretube-math.ts` (pure) and `client/wiretube.ts` (three.js): the flat jumper tube. Frames are computed on the full line, bends are filleted in 15 degree steps (ramp corners under 45 degrees are left sharp), jacket 10 sides, tin 8.
- `client/models.ts`: loads the GLBs in `manifest.json` once (never rejects; a failed model is left out with a warning). `board3d-parts.ts` mounts them, falling back to the simple shapes.
- `client/editor3d/`: the 3D editor.
  - `workspace.ts`: the shell, key routing and the Detail toggle.
  - `modelcache.ts`: the one shared model load; a failed load is no models and is not kept.
  - `manipulate.ts`: select, drag, rotate and flip.
  - `card.ts`: the part card.
  - `wireEdit.ts`: wire selection, handles, the wire card, reshape and recolour commands.
  - `history.ts`: undo.
  - `focus-math.ts`: camera framing.
- `client/view3d.ts`: opens and closes the editor, and owns the history entry.

## Invariants (do not break)
- Layout-only changes go through `api.move` → `POST /api/projects/:id/layout/move` → `Service.movePart`, which writes `sidecar.pinned`.
- Schematic changes go through `/api/projects/:id/edit/*` → `Service.edit` (it backs up first, into `.circuit-ai-backups/` beside the schematic). The client then calls `loadProject(id)`.
- `Service.edit()` announces every schematic edit itself: after its refresh it emits `{type: 'changed', source: 'edit'}`, which `/api/events` forwards over SSE, so MCP and REST edits reach every open page. The watcher skips the refresh and event only when the file matches what `edit()` last wrote (`selfWrites`, cleared on close), so an edit produces exactly one event and a genuine external save still emits `{type: 'changed', source: 'watch'}`. The client reloads quietly for `'edit'` and shows the "changed on disk" toast only for `'watch'`.
- `loadProject(id)` on the project already open keeps the session's UI state (selection, switches, running sim, step, panel, followed net, done steps) where it still exists in the new design, and keeps a running analog sim running (`analog.rebuild`). A different project starts fresh. The 3D undo history is cleared whenever `design` changes identity (any schematic reload) and when the editor closes.
- `src/**`, `client/editor3d/history.ts`, `client/editor3d/focus-math.ts` and `client/wiretube-math.ts` stay free of DOM and three.js.
- Wire shapes go through `api.wirePath` -> `POST /api/projects/:id/layout/wire` `{ key, path }` -> `Service.setWirePath`, which writes `sidecar.wirePaths`. `key: "*"` with `path: null` clears every shape (a non-null path with `*` is a 400); `path: null` on a key deletes it, even a stale one; a non-null path for a key that matches no wire is a 404; an invalid shape is a 400 with the reason. In the editor every shape change is a `wirePathCommand` on the History stack; Tidy all wires is a `tidyCommand` whose undo restores only shapes whose wires are still live. Colour keys 1 to 9 recolour the net through `api.color` and are not undoable.
- `shapePlan(w, path, packages, board, takenNodes(doc))` in `route3d.ts` is the single validity check for a hand shape (square, leaves its holes along their columns, on the board, clear of every package, and never over a leg or another jumper's end). Save (`setWirePath`), layout (`routeWires`) and the editor all use it, so the three never disagree. `simplify` is a fixpoint, `planToPath` returns null for a plan that is off the lattice, and `normalizeSidecar` keeps at most 1024 `wirePaths`.
- `wirePaths` keys are `${net}|${holeA}|${holeB}` with the two holes sorted as strings (`wireKey()`). A `WirePath` stores only the bends in grid units: `col` in pitches (half steps), `gap` (the corridor) and `lane` (half pitches from the corridor centre). A saved key that matches no wire is ignored but kept in the sidecar (so a part moved away and back gets its shape back; `key: "*"` forgets it), with a warning.
- Every router warning (a stale shape, a shape that no longer fits, a wire with no clean route) goes into `doc.warnings` and, because the checks run before routing, `buildLayoutDoc` appends each one to `doc.checks` as a `layout` warning. The Checks panel, the warning counts, `summarize` and the MCP tools read `doc.checks`. If `routeWires` throws, `buildLayoutDoc` draws every wire with `ortho.ts`, flagged with `ROUTER_FAILED`, and says so in both.
- `LayoutDoc.routes` exists only when `options.wireStyle` is `orthogonal`; `buildLayoutDoc` routes then, so the flat board and the 3D board draw one set of paths. The arc style never routes. The 3D part-drag verdict (`manipulate.ts`) builds its doc with the arc style so it does not route on every snapped move. The flat board's drag preview rebuilds only when the snapped holes change.
- Routes never lie on a leg or on another wire's end, never cross a package body (plus 3 units), and leave every hole straight along its column. A wire with no clean route falls back to `ortho.ts` with `WireRoute.warning` set; the editor gives it no handles and shows `FALLBACK_HELP`. Shaping is offered only for square wires.
- `Package.flipped` is `true` or absent, never `false`, so unflipped docs serialize exactly as before.
- In the scene, every part/package group has `userData.ref` and is on raycast layer 1. Jackets are on layer 2, switch ways on layer 3.
- Pick is depth-ordered: a switch first, then whichever of the part or jumper is nearer.
- The editor decides drag vs orbit on `pointerdown` (capture phase) and calls `board.setOrbit(false)` synchronously. Only an already-selected part can start a drag.
- The workspace has a single `release()` teardown, used by both `close()` and a failed setup. Add new listeners and subscriptions to it. It also clears `selectedRef`, which the flat board draws as a hard highlight.
- `History` is serialised (one operation at a time) and generation-guarded: `clear()` bumps a counter so queued or in-flight operations cannot touch the stacks afterwards. Commands hold model data, not scene objects. A command whose undo or redo fails is dropped (the command itself toasts why), so it cannot block the stack beneath it.
- Key routing lives in `workspace.ts`. Ctrl, Cmd and Alt chords belong to the browser except Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. Modules add handlers with `addKeyHandler`.
- No `window.confirm`/`alert`/`prompt` anywhere in the client.
- Commits: no Co-Authored-By / Claude-Session / Generated-with footers.

## Testing notes
- three.js code has no unit tests (no WebGL in Bun). Cover it with `scripts/e2e-3d.ts`.
- The `?e2e` URL flag exposes `window.__e3d`: `ready`, `selected`, `holes`, `screenOf`, `parts`, `lead2`, `chips`, `select`, `pickAt`, `tintCount`, `value` (a part's value in the store's design), `wireStyle`, `move` (a layout move outside the pointer path), and for wires `routes` (each square wire's plan), `wires` (their keys), `wireScreen(i)` (page point halfway along wire i), `selectedWire`, `selectWire(key)`, `handles` (page points of the drawn handles), `wirePath(key)` (the saved shape in the store), `netColor(net)`, `wireTop` (highest jacket point) and `loseContext` (force a WebGL context loss; the editor then closes with a toast and pressing 3D remounts it). It also honours the test-only knobs `window.__e3dDelay` (ms to hold the three.js download) and `window.__e3dFailMount` (make mounting throw).
- Handles are picked on raycast layer 4. Anything picked right after it is created needs `updateMatrixWorld` first: the harness renders at about 3 fps, so the next frame may not have happened yet.
- The tube budget test runs on the lab3 example (limits: mean 770, worst 2200 vertices per wire).
- The headless-Chrome harness renders at about 3 fps. Scenarios must poll with `until` rather than assume a frame has happened.
- Don't measure UI timing in the Chrome MCP tab: it is a background tab clamped to 1 s timers. Use the headless harness.

## Design docs
- `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md`: the 3D editor spec (phases 1 to 3).
- `docs/superpowers/plans/`: implementation plans.
- `docs/editor3d.md`: the user guide.
