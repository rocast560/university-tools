# 3D editor workspace: design

Date: 2026-09-29 · Branch: `editor3d` (from `circuit-3d-base`) · Status: approved in chat, awaiting spec review

## 1. Intent

Today the **3D** button swaps the flat board for a 3D view you can orbit, fly
through, flick switches in and follow nets in. You cannot change anything there.

The goal is to make 3D a place where you **build** the board:

- a full-screen workspace with a scrollable **parts tray** along the top that you
  drag real parts from onto the breadboard;
- **clean, realistic jumpers** that lie flat, bend square with tight radii, run in
  tidy parallel lanes, go round chips, and can be **reshaped by hand**;
- **click a part** to highlight it in 3D, then move it (snapping to holes), rotate
  or flip it, edit its value, delete or duplicate it, and fly the camera to it.

Success looks like this: a user can take an open project, add a resistor from the
tray, drop it so it bridges two nets, route a jumper, tidy two wires by hand, and
end up with a `.kicad_sch` and a board layout that agree. The board should look
like a carefully hand-wired breadboard (in the style of Ben Eater), not like a
diagram.

### Decisions the user made

| Question | Answer |
|---|---|
| What a tray drop does | **Adds a real component to the schematic** (with a backup), the same as `add_component` |
| Wire shaping | **Auto-routed, then hand-tweakable**; hand shapes persist |
| Part manipulation | Drag with snap, rotate/flip, info and actions card, camera focus (all four) |
| Environment | **Full-screen workspace**; Esc or Back returns to the page |
| Architecture | **New editor layer** over the existing scene (option A), corridor router evolved (option R1) |
| Delivery | Everything on a branch, reviewed before use; documented in `.md` for people and LLMs |

### Out of scope (explicitly)

- Merging two different nets from 3D. Refused with a message; use the schematic.
- Keyboard-only placement with a hole cursor. Noted as a follow-up; see §8.
- "Starter" sub-circuits in the tray, the kit-length jumper colour mode, and the
  multimeter. Follow-ups.
- Replacing OrbitControls with camera-controls, or moving to WebGPU.

## 2. Research summary (what shaped this design)

| Source | Pattern adopted |
|---|---|
| Tinkercad Circuits | Parts panel with search; hovering a hole highlights its connected strip; **R** rotates; digit keys recolour a wire; **F** frames the selection |
| Fritzing | Drag a segment to create a bend, double-click to add or remove a bendpoint; green/red connector feedback |
| Wokwi | Wires coloured from the net by default (GND black, supply red); click-then-click wiring with waypoints; Esc cancels; **D** duplicates |
| de:volt | Touch works: tap to arm, long-press for the context menu, one finger edits and two fingers move the camera |
| libavoid (Wybrow, Marriott and Stuckey 2009) | Routing then **nudging**: order and separate shared segments; a bend (segment) penalty is mandatory or routes staircase |
| Channel routing (left-edge algorithm) | Pack runs that share a corridor into minimum lanes, respecting vertical order constraints |
| JointJS / draw.io | Segment handles move a segment perpendicular to itself; auto-jog at pin-attached segments; remove redundant points; loop-capped A* with a fallback |
| three.js practice | Pointer Events (not HTML5 drag-and-drop) for the tray; raycast onto a `Plane`; pick layers; decide orbit vs drag on `pointerdown`; `EdgesGeometry` overlay instead of `OutlinePass` (avoids the composer's MSAA and tone-mapping pitfalls); one shared renderer for thumbnails; command-pattern undo in the style of `History.js` |
| Hand-wiring practice (Ben Eater, DigiKey guide) | Flush on the board, cut to length, tight bends (about 1 wire diameter), bundles in parallel, never over a chip, short straight hops to rails |
| WCAG 2.2 SC 2.5.7 | Every drag has a single-pointer (click/tap) alternative |

Links: see `docs/editor3d.md#references`.

## 3. Architecture

```
client/view3d.ts                 opens/closes the workspace, syncs the store (existing, slimmed)
client/editor3d/
  workspace.ts                   full-screen shell: tray slot, toolbar, canvas, legend, toasts, key routing
  select.ts                      picking (layers), hover, selection outline overlay
  manipulate.ts                  drag-to-move, rotate/flip, ghost + validation display
  card.ts                        floating part card (and wire card)
  focus.ts                       camera frame-to-box tween
  history.ts                     undo/redo command stack (layout-level commands)
  wireEdit.ts                    wire selection, segment/bend handles, wire tool (phase 3)
  tray.ts                        parts tray, search, thumbnails, pointer drag-in (phase 3)
  thumbs.ts                      offscreen thumbnails via the shared renderer (phase 3)
client/board3d.ts                scene (existing); gains the Board3D editor interface below
client/board3d-parts.ts          part meshes (existing); groups tagged with userData.ref, parts on pick layer
client/wiretube.ts               custom tube builder: polyline + fillets -> BufferGeometry
src/render/route3d.ts            pure router: A* + lane packing + height profile + saved-path application
src/edit/placement.ts            pure: rotate/flip hole maps, placement validation, legs -> connections, jumper outcome
```

The pure modules (`src/render/route3d.ts`, `src/edit/placement.ts`) have no DOM or
three.js dependencies and carry most of the unit tests.

### Board3D interface additions

```ts
interface Board3D {
  // existing: dispose, setState, setBoard, setHighlight, setHover, resize, resetView, setFly
  pick(e: PointerEvent): { kind: 'part'; ref: string } | { kind: 'wire'; index: number } | { kind: 'switch'; key: string } | { kind: 'hole'; hole: Hole } | null;
  boardPoint(e: PointerEvent): [number, number] | null;   // plan (SVG) coords on the board plane
  setSelected(sel: { ref?: string; wire?: number } | null): void;  // outline overlay + emissive bump
  setGhost(g: Ghost | null): void;                        // translucent part or wire preview + strip tints
  setStripTint(tints: { hole: Hole; tone: 'ok' | 'join' | 'bad' }[]): void;
  rebuild(doc: LayoutDoc): void;                          // re-layout without remounting renderer or camera
  anchor(ref: string): { x: number; y: number; visible: boolean } | null;  // screen position for the card
  bounds(ref: string): THREE.Box3 | null;                 // for focus
  controls: { enabled: boolean };                         // editor takes the pointer on pointerdown
  camera: THREE.PerspectiveCamera; target: THREE.Vector3; // for the focus tween
}
```

`rebuild(doc)` is new and important. Today a wire-style change remounts the whole
scene. The editor needs to swap parts and wires in place after every edit while the
camera stays where it is.

### Data flow

- **Layout-only changes** (move, rotate, flip, wire shape):
  1. The pure helper computes the new pinned holes or the new wire path.
  2. The client-side pipeline gives a live preview, the same as the 2D drag does.
  3. On release, `api.move(...)` or `api.setWirePath(...)` runs.
  4. The server returns the doc, the store updates, and 2D and 3D both repaint.
- **Schematic changes** (drop from tray, jumper that connects, set value, delete,
  duplicate):
  1. They go through the existing `service.edit` operations (`edit/add`,
     `edit/connect`, `edit/value`, `edit/remove`), each of which makes a backup.
  2. A placement is then pinned with `layout/move`.
  3. On error: show a toast and restore the board from the server doc, so the view
     never shows a state the schematic lacks.

### Sidecar changes

```ts
interface Sidecar {
  // existing: version, options, pinned, colors, placed, ledColors
  /**
   * Hand-shaped jumper paths. Key: `${net}|${holeA}|${holeB}`. Holes use the MCP
   * naming (`e12`, `T+3`), and the two holes are sorted as strings.
   */
  wirePaths: Record<string, WirePath>;
}
/**
 * The bend points between the two end holes, in grid units rather than SVG units,
 * so a path survives board-size and pitch changes.
 * col:  column position in pitches; half steps (12.5) sit between two columns.
 * gap:  the corridor the point lies in, named by the rows either side
 *       ('c|d', 'e|f', 'T-|a', or 'top' / 'bottom' outside the rails).
 * lane: signed sub-lane index inside that corridor (0 = centre line).
 */
interface WirePath { points: { col: number; gap: string; lane: number }[] }
```

`normalizeSidecar` accepts files that have no `wirePaths` field (older sidecars).
A new endpoint, `POST /api/projects/:id/layout/wire`, takes
`{ key, path: WirePath | null }`, where `null` clears the path. It maps to a new
`service.setWirePath`, which follows the same pattern as `setColor`. The MCP tool
list is unchanged for now.

## 4. Phase 1: workspace and part manipulation

### 4.1 Shell

- The 3D button mounts a `position: fixed; inset: 0` overlay into `document.body`.
  It keeps the existing `history.pushState` entry, so Back closes it. Esc closes it
  too, unless a drag, the wire tool or fly mode is active; in those cases Esc
  cancels that first.
- Layout from top to bottom:
  - the **tray strip** (collapsed placeholder in phase 1);
  - the **toolbar**: Exit · Fly through · ◀ step ▶ · wire style · Undo/Redo · hint text;
  - the **canvas**;
  - the **legend**, floating at the bottom left;
  - **toasts** at the bottom centre.
- Keyboard routing lives in the workspace. Editor shortcuts are ignored while fly
  mode is on (fly uses WASD/QE/C) and while any input is focused.

### 4.2 Selection

- Every part and package group gets `userData.ref` and sits on **raycast layer 1**.
  Jackets are on layer 2 and switches on layer 3. `pick()` decides in this order:
  switch > part > wire > hole.
- Hover is throttled to one raycast per animation frame. A hovered part gets a
  faint edge overlay.
- A selected part gets:
  - an `EdgesGeometry` + `LineSegments` overlay (accent colour, `depthTest: false`),
    built lazily on selection and disposed on deselection;
  - a small emissive bump;
  - its nets lit through the existing `setHighlight({ ref, soft: true })`.
- `selectedRef` goes in the store, so the flat board highlights the same part.
  Clicking empty board clears the selection. Clicking a wire still follows its net
  (as today) and also selects the wire (phase 2).

### 4.3 Move

- On `pointerdown` over the **already selected** part, the editor sets
  `controls.enabled = false` in that same handler and calls `setPointerCapture`.
  Any other press orbits as it does today. The listener is registered before
  OrbitControls' listener, so this runs first.
- A click is movement under 4 px (8 px for touch).
- `boardPoint()` intersects a `Plane` at board-top height. It keeps the grab offset,
  and the delta goes into the existing `shiftHoles()`.
- The part mesh follows the pointer smoothly. Its snapped footprint shows as tinted
  strips:
  - **ok**: green;
  - **join** (the leg's strip already carries a net other than its current one):
    amber, labelled "joins /A";
  - **bad**: red.
- On release, if the placement is valid, call `api.move` (the same path as 2D) and
  `rebuild(doc)`. If it is invalid, animate back and write the reason on the hint
  line.

### 4.4 Validation (`src/edit/placement.ts`, pure)

A placement is refused, with a reason, when any of these is true:

- a leg is off the board or in a rail gap column;
- a hole is taken by another part's leg;
- both legs of a two-terminal part land in the same strip (this shorts the part;
  it is the most common beginner error, and Tinkercad and Fritzing allow it
  silently);
- a DIP does not straddle the centre channel (DIPs snap across it automatically);
- the pinned placement would be dropped by the engine (the same check as the 2D
  drag).

### 4.5 Rotate and flip

| Key | Action |
|---|---|
| **R** | Rotate a two-leg part 90° about pin 1. Chips: no-op, with the hint "chips only flip" |
| **Shift+R** | Flip a DIP 180° (notch to the other end, pin 1 to the opposite corner) |

Both compute a new hole map in `placement.ts`, validate it, then call `api.move`.
**F** is reserved for focus (see 4.7), which matches Tinkercad.

### 4.6 Part card

- A single HTML card, positioned by projecting the part's anchor every frame, but
  only when the camera or the part moved. It uses `translate3d` and is clamped to
  the viewport, flipping above or below the part. It is hidden when the part is
  behind the camera.
- Contents:
  - ref, type and **value** (inline edit through `edit/value`);
  - pins with their nets (clicking a net follows it);
  - actions: Rotate · Flip (chips) · Duplicate (phase 3) · **Delete** · Focus.
- Delete asks for confirmation inside the card, never with `window.confirm`, then
  calls `edit/remove`.
- Long-press on touch opens the same card.

### 4.7 Focus

Double-click a part, press **F**, or press the card's Focus button. A hand-rolled
tween of about 400 ms (easeOutCubic) moves `controls.target` and the camera
distance to frame `bounds(ref)` with padding. Any orbit input cancels it.
camera-controls was not adopted because fly mode is built around OrbitControls.

### 4.8 Undo/redo (`history.ts`)

- A command stack in the style of three.js editor `History.js`, storing
  **model-level data** so it survives rebuilds. For example
  `MovePart { ref, before: holes, after: holes }`; `SetWirePath` arrives in phase 2.
- Rules:
  - one command per completed gesture;
  - a new command clears the redo stack;
  - **Ctrl+Z** undoes, **Ctrl+Shift+Z** and **Ctrl+Y** redo.
- Schematic edits are **not** undoable in the editor. They keep their server
  backups, and the toast says so.

## 5. Phase 2: clean wires

### 5.1 Router (`src/render/route3d.ts`, pure)

This evolves `ortho.ts` (whose corridors, package rectangles and short-first
ordering are kept):

1. **A\* over the corridor graph** with state `(node, direction)` and cost
   `length + B·bends + S·sharedCorridor + X·crossings`. Ties break toward fewer
   bends.
   - Chip bodies (with a margin of one pitch) are **hard obstacles**. There is no
     arch-over fallback unless the search fails; if it does, the wire is flagged,
     shown with a warning tint, and named in `doc.warnings`.
   - The search is capped at a maximum number of expanded nodes, with the existing
     `ortho.ts` path as a fallback, so a drag never stalls.
2. **Hand-shaped wires first.** Saved `wirePaths` whose end holes still match are
   applied, and they claim their lanes as fixed occupants. Stale ones are dropped,
   with a warning naming the net.
3. **Lane packing (nudging).** After every wire is routed, the horizontal segments
   in each corridor are collected as intervals and assigned lanes with the
   **left-edge algorithm**. Vertical constraints (a wire entering from above takes
   the upper lane) are respected, and ordering is kept consistent along shared
   runs so bundles don't swap and cross. Vertical segments sharing a column gap are
   treated the same way. Lane pitch is the wire diameter plus a gap.
4. **Height profile.** Wires lie at `z = radius` on the board. At each crossing the
   wire routed later humps by one wire diameter over about 2 pitches.
5. Output per wire: `{ plan: Point[], lifts: { at: number; height: number }[], warning?: string }`.

The 2D square view (`wireStyle: 'orthogonal'`) switches to `route3d` so both views
draw the same paths. The arc style is unchanged.

### 5.2 Tube (`client/wiretube.ts`)

- Builds one `BufferGeometry` per wire from the 3D polyline. The polyline is made
  from the plan and height profile: a vertical stub out of each hole, down onto the
  board, along the plan, humps at crossings, and back up into the other hole.
- **Fillets** at every corner: tangent distance `d = min(r/tan(θ/2), ½|PA|, ½|PB|)`,
  and `r` is recomputed after clamping.
  - Collinear points are dropped.
  - Bend radius: about 4 units (roughly one wire diameter) on the plan; hole stubs
    use about 3.
- **Rings:**
  - 2 per straight run and `ceil(angle / (π/12))` per fillet;
  - frames carried across by parallel transport, seeded with board-up so the seam
    faces down;
  - 10 radial sides for the jacket.
- The tinned ends are separate short, instanced cylinders. The jacket stops
  7 units short of each hole, as a stripped jumper does.
- Budget: about 400 vertices per wire, roughly 40k for 100 wires. Only the edited
  wire's geometry is rebuilt during a drag.
- Colours stay per net (existing `colors` sidecar). New projects default power to
  red and ground to black.

### 5.3 Editing wires (`client/editor3d/wireEdit.ts`)

- Clicking a jacket selects the wire. It gets an edge overlay, its net is followed
  softly, and the **wire card** opens with net, length, colour swatches, Re-route
  and Reset all wires.
- Handles:
  - a disc at the midpoint of each segment longer than about 2 pitches (segment
    handle);
  - a smaller disc at each bend (vertex handle).
- **Dragging a segment** moves it perpendicular to itself, snapped to corridor
  lanes (never onto hole centres). Its neighbours stretch.
  - If the segment touches a leg stub, a jog is inserted automatically so the stub
    stays put.
- **Dragging a bend** moves one coordinate of each neighbour, so the path stays
  orthogonal.
- **Double-clicking a segment** adds a bend pair (a small Z). Double-clicking a
  bend, or selecting it and pressing **Delete**, removes it.
- After each edit, zero-length and collinear points are removed.
- Paths through a chip body turn red and are refused on release.
- A valid release saves through `layout/wire`, and a `SetWirePath` command is pushed
  onto the undo stack. The other wires re-pack around the locked one.
- **Digit keys 1–9** recolour the selected wire's **net** from a fixed palette,
  through the existing colour endpoint. Colour is per net, the same as today.

## 6. Phase 3: parts tray and building

### 6.1 Tray (`tray.ts`, `thumbs.ts`)

- A horizontal strip. The wheel scrolls it sideways. A search box sits at the left,
  focused with **/**.
  - Search matches the alias name, lib_id and default value (for example "10k",
    "LED" or "74HC").
  - Group chips: Passives · Indicators · Inputs · Logic · Power. The list opens on a
    curated "Basic" set, and an **All** toggle shows the rest.
- The source is the existing `GET /api/parts` alias list.
- **Thumbnails** use the shared renderer. They render once into a 128×128
  `WebGLRenderTarget` with a fixed thumbnail scene and camera fitted to the part's
  `Box3`, built with the same `buildPart`/`buildPackage` code. They are read back to
  a canvas, cached in a `Map` as object URLs, and generated lazily in idle time.
  There is no second WebGL context.

### 6.2 Adding a part

- **Pointer drag** (not HTML5 drag-and-drop):
  1. `pointerdown` on a tile captures the pointer and shows a DOM ghost (the
     thumbnail).
  2. Over the canvas the DOM ghost hides and a translucent 3D ghost of the real part
     snaps to holes, with the §4.3 strip tints and the §4.4 validation.
- **Tap to arm, then tap a hole** does the same thing without a drag, for touch
  users and for WCAG 2.5.7. Esc disarms.
- **On drop**, legs in strips that already carry a net join that net; legs in empty
  strips stay unconnected. The client builds the `connections` map with
  `placement.ts:legsToConnections`, then:
  1. `edit/add { part, value, connections }`;
  2. `layout/move { ref, holes }` with the dropped holes;
  3. the new part is selected and its card opens with the value field focused.
- If step 2 fails after step 1 succeeded, the part stays in the schematic, the
  engine places it automatically, and a toast explains what happened.

### 6.3 Wire tool

- Press **W** or the toolbar button. It works in two ways, press-drag-release or
  click hole → optional click bends → click hole, with a live preview in the §5.2
  style. Esc or right-click cancels.
- Outcome (`placement.ts:jumperOutcome`, pure):

| From strip | To strip | Result |
|---|---|---|
| empty (has unconnected part pins) | has net N | `edit/connect` each of those pins to N |
| net A | net B, A ≠ B | **Refused**, preview stays red: "would join /A and /B. Merge nets in the schematic" |
| net A | net A | No schematic change; saved as a hand-placed route in `wirePaths` |
| empty | empty | Refused: "nothing to connect yet. Place a part first" |

### 6.4 Duplicate and delete

- **D** or the card's Duplicate button: `edit/add` with the same part and value,
  pinned at the nearest valid spot to the right of the original.
- **Delete** (key or card button): `edit/remove` after the in-card confirmation.

## 7. Error handling

- Every server call is wrapped. On failure: show a toast with the server's message,
  restore the board from the last good doc, and clear any ghost.
- Pinning conflicts reuse the engine's `pinned placement … dropped` warning.
- Router failures never throw. They fall back to the `ortho.ts` path and add a
  warning.
- WebGL context loss disposes the workspace with a toast. Reopening remounts it.

## 8. Follow-ups (not in this spec)

- Keyboard-only placement: a hole cursor moved with arrow keys, Enter to place, and
  aria-live announcements.
- Tray "Starters" (for example LED + resistor as one drag).
- A kit-length jumper mode that colours by length like a 140-piece kit.
- An override that merges nets, for non-power nets.
- MCP tools for wire paths (`set_wire_path`) and for selection.

## 9. Testing

- **Unit (bun):**
  - `placement.ts`: rotate and flip maps, every validation rule, `legsToConnections`,
    and each row of the jumper outcome table.
  - `route3d.ts`: no run crosses a chip rectangle; no two runs overlap in a
    corridor; ordering stays consistent in bundles; the bend count on `PL1_1`, lab3
    and lab4 fixtures is no worse than `ortho.ts`; saved paths are applied, or
    dropped when stale; search-cap fallback.
  - `wiretube.ts`: fillets stay within radius; the tube is continuous (no gaps
    between rings); collinear points are removed; the vertex budget holds.
  - `history.ts`: undo/redo sequencing and clearing redo on a new command.
  - Sidecar: accepts and normalizes `wirePaths`, including old files without it.
- **Service:** `setWirePath` round trip; add-then-pin flow on a fixture.
- **Render snapshots:** the 2D orthogonal fixtures are regenerated and reviewed.
- **End to end:** headless Chrome over CDP from a Bun script (the Chrome MCP tab is
  throttled). The script opens a fixture and:
  - selects a part, drags it, checks the pinned holes;
  - rotates it;
  - shapes a wire and reloads it, checking the path persists;
  - drags a resistor from the tray across two nets and checks the schematic gained
    the part and both connections;
  - refuses a shorting jumper.
- **Gate for every phase:** `bun test` and `bun run typecheck` stay green (baseline:
  303 tests).

## 10. Documentation deliverables

Each phase updates these, and they are part of its definition of done:

- `docs/editor3d.md`: the human guide. It covers controls and shortcuts, what
  changes the schematic and what changes only the layout, how wire shapes persist,
  troubleshooting, and references (research links).
- `AGENTS.md` (new, at `circut-ai-tool/`): for LLM agents. It covers the module map,
  invariants (moves only through `api.move`; schematic edits only through
  `service.edit` operations; `wirePaths` key format and grid units; pure modules
  stay DOM-free), how to run tests and typecheck, and the headless-Chrome
  verification recipe.
- `CLAUDE.md` (new): a one-line pointer to `AGENTS.md`.
- `README.md`: a short "3D editor" section linking to both.
