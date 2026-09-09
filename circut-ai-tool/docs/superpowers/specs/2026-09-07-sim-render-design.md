# Simulation, rich rendering and hand editing — design notes

Companion to the phased plan. Records the decisions that are expensive to
rediscover. Written 2026-09-07.

## Simulation

The analog engine solves the **physical breadboard graph**, not the schematic
netlist. Nodes are the union-find roots of strips and rails from
`connectivity()` / `holeNode()` in `src/checks/index.ts`; a device stamps
between the strips its legs occupy, via `EngineResult.pinHoles`.

This is forced by the sidecar-only editing decision — a hand-placed part has no
schematic net — and is strictly more truthful: it simulates what was built,
including a jumper in the wrong row.

`gmin` is applied **only to nodes with no conductive path to ground**, not
blanket to every node as SPICE does. A blanket 1e-12 perturbs a 1k/1k divider
by 1.25e-9 V, which is enough to fail a 9-decimal assertion; targeted gmin
keeps well-connected nodes exact.

The boolean simulator in `src/sim/index.ts` is untouched and still owns the
truth table, the build guide and MCP `simulate`.

## Rendering

### The flat skin is the contract
`renderSvg()` defaults to `skin: 'flat'`, which must stay **byte-identical** to
today's output. Four consumers depend on it: resvg (`server/png.ts`), MCP
`render_breadboard`, the `.svg`/`.png` downloads, and the print sheet. A golden
fixture (`test/fixtures/PL1_1.flat.svg`) is the only thing that catches drift,
and flat must contain no `url(#`, `filter=`, `<defs`, `<style` or
`mix-blend-mode`. `src/render/skin-rich.ts` is imported only by `client/`, so
the rich skin cannot physically reach resvg.

### Performance traps, in order of severity
1. **`feTurbulence` on anything board-sized re-runs on every zoom notch** —
   wheel-zoom mutates the viewBox, which changes the raster scale, which
   invalidates the cached filter result. Confine turbulence to a 64x64
   `<pattern>` tile with `stitchTiles="stitch"` and
   `color-interpolation-filters="sRGB"`.
2. **880 rich hole sockets as real elements** would swamp the static layer.
   Rows are uniformly 18 apart, so `patternUnits="userSpaceOnUse"` tiles
   collapse them to four band rects. Derive the rail tile width from
   `board.railGapEvery`, never hard-code 6.
3. **Animating shared gradient stops** invalidates every referencing element.
   Give each LED its own gradients and animate element `opacity` / `r`.
4. **Setting `filter` per frame** re-plumbs the filter graph. Set it once.
5. **Total filter budget: two** — noise (in a pattern tile) and one drop shadow
   on the slab. Contact shadows and bloom are radial gradients, not filters.

### Layer order
`l-board`, `l-spill` (multiply — light pooling on the plastic), `l-packages`,
`l-parts`, `l-wires`, `l-supply`, `l-glow` (screen — light in the air, tinting
the wires), `l-overlay`. `mix-blend-mode` creates a stacking context, so
`#board svg` needs `isolation: isolate`.

### The render/patch split
Three tiers: **structure** (new `LayoutDoc` → full re-serialise), **highlight**
(attribute diff on a pre-built index), **frame** (attribute writes on leaf
nodes at rAF).

Two existing bugs must go first or nothing holds 60 fps:
- `client/board.ts:110` calls `buildLayoutDoc` on every pointermove — that is
  `runChecks` + `buildSimModel` + `truthTable`, and the truth table is up to 64
  full logic solves. Per pointer event.
- `client/board.ts:40` does `JSON.stringify(doc)` on every store notification
  just to decide whether to re-render. The pipeline is pure and returns a fresh
  object, so `doc !== lastDoc` is a free structural key.

Frames must **never** go through `store.set()` — `renderPanels()` rebuilds
three `innerHTML`s per notification. Use a module-local `simBus`. Board visuals
at rAF; panel text at 10 Hz.

### Scope
`<canvas>`, not SVG. A 600-sample x 4-trace scope in SVG means rewriting ~2400
coordinates 60x/s per trace, competing with the board SVG. Canvas allows a
blit-and-scroll that is O(1) per frame. Keep the ring buffer pure and tested;
only the `ctx` calls are untestable.

## Hand editing

`Sidecar.hand: HandPart[]`, no version bump — old sidecars simply lack the
field, which is what a permissive `normalizeSidecar` is for.

Hand parts must exist as synthetic `Component`s **before** `layout()` runs
(the engine builds footprints from `design.components`), with their holes
merged into `sidecar.pinned` so `placePinned()` claims them first.

Net resolution is a **post-layout alias pass, not a second layout pass** — a
second pass can oscillate as packing shifts. Each hand pin starts on a
geometric net `bb/<node>`; afterwards, any schematic pin sharing that node
donates its name. A hand part sharing a strip with a schematic pin is already
connected by the strip, so the router never needs to know.

`server/service.ts` `resetLayout` currently keeps only `placed` and would
silently eat hand parts.

Undo/redo: the client owns the whole `hand[]` array and PUTs it, so undo is an
array swap. History lives in `sessionStorage`, not the sidecar — that file is a
document people diff in git, not a journal.
