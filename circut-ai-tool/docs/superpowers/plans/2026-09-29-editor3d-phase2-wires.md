# 3D Editor Phase 2 (Clean Wires): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make square jumpers look like a carefully hand-wired breadboard (flat on the board, tight fillets, parallel lanes, never over a chip, a hop at each crossing) in both the 3D editor and the flat board's square view, and let the user select a jumper, reshape it by its handles, recolour its net and undo it, with the shapes kept in the layout sidecar.

**Architecture:**
- **Router (pure).** `src/render/route3d.ts` replaces `ortho.ts` for square wires: A* over a half-pitch lattice, then lane packing (left-edge, peel-off order) with a few rip-up rounds, then humps at crossings. Hand shapes from `sidecar.wirePaths` are applied first. `ortho.ts` stays as the fallback when a search gives up.
- **One set of paths.** `buildLayoutDoc` routes when the sidecar asks for square wires and puts the result in `LayoutDoc.routes`; the flat board and the 3D board both draw it.
- **Tube (pure maths, thin three.js).** `client/wiretube-math.ts` builds the centre line, fillets and parallel-transport rings; `client/wiretube.ts` turns them into `BufferGeometry`.
- **Editing.** `src/edit/wireshape.ts` (pure) moves runs and bends; `client/editor3d/wireEdit.ts` drives it from handles in the scene, saves through `POST /layout/wire` (`Service.setWirePath`) as a `SetWirePath` History command, and owns the wire card.
- **WebGL context loss** (carried over from phase 1) closes the workspace with a toast; pressing 3D mounts a fresh one.

**Tech Stack:** TypeScript (strict), Bun test runner, three.js 0.185, Vite client build, Hono server, headless Chrome over CDP for end-to-end checks.

**Spec:** `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md` (§5, the wire parts of §3, §7, §9, §10; research in §2). Phase 1 plan for conventions: `docs/superpowers/plans/2026-09-29-editor3d-phase1-workspace.md`.

**Working directory for every command:** `C:\Users\rober\Desktop\university-tools\.worktrees\editor3d\circut-ai-tool` (branch `editor3d`).

## Global Constraints

- `bun test`, `bun run typecheck` and `bun scripts/e2e-3d.ts` green (current baseline: 340 unit tests, 17 e2e scenarios). The e2e harness needs `bun run build` first.
- Pure modules stay DOM-free: `src/**`, `client/editor3d/history.ts`, `client/editor3d/focus-math.ts` and, new here, `client/wiretube-math.ts` never import `three`, touch `document` or touch `window`.
- Layout changes go through the API + Service; schematic changes through `/edit/*`.
- No `window.confirm`, `alert` or `prompt`.
- No attribution footers: commit messages have no `Co-Authored-By`, `Claude-Session` or "Generated with" line.
- Code style matches the surrounding code: two-space indentation, single quotes, semicolons, `//` comments that say why.
- Shortcuts are ignored while typing or flying, and modifier chords are left to the browser unless claimed.
- The headless harness renders at about 3 fps, so scenarios poll with `until`.

## Spec clarifications made while planning

Every number below was measured by running this plan's code on the four fixture boards (PL1_1, lab3, lab4-74ls08, lab4-decoder) before the plan was written.

1. **A half-pitch lattice, not a coarse corridor graph.** The wire is 8 units across (22 AWG with insulation, 1.1 mm), so the spec's lane pitch "wire diameter plus a gap" is 9 units, exactly half a hole pitch. Lanes therefore sit on one grid with the hole rows, and A* runs on that grid: a node every half pitch both ways, the heading in the state. A `WirePath` point is `{ col, gap, lane }` as specified: `col` in pitches (half steps between columns), `gap` the corridor, `lane` the number of half pitches from the corridor's centre line. In a one-pitch corridor, lanes ±1 lie on the hole rows either side; a wire may lie over an empty hole, never on a leg or another wire's end.
2. **Chip margin.** A hard margin of one pitch bars the column beside every chip, which is where most chip wiring lands. Hard obstacles are the body plus 3 units (ortho.ts's own air); running within 4 more units of a body costs extra (`NEAR_CHIP`). The "no arch-over unless the search fails" rule holds: only a fallback wire can cross a body, and it is lifted clear of it and flagged.
3. **"Bend count no worse than ortho.ts."** ortho.ts gets its count by stepping sideways out of holes along the row and by running over legs, jumper ends and other wires; the new router may not do any of that, so a raw comparison is not meaningful. The tests pin: on both lab4 boards, no more bends than ortho.ts on the wires ortho.ts draws legally (measured: equal, 28 and 18); on all four boards, total bends within 1.7x of ortho.ts as a regression guard (measured 1.40 PL1_1, 1.61 lab3, 1.03 and 1.13 lab4).
4. **Nudging plus rip-up.** Left-edge lane packing alone left overlaps on PL1_1 and lab3. After nudging, wires that still lie along (or turn on) a wire of another net are ripped up and searched again with sharing made dear, up to 3 rounds, alternating longest-first and shortest-first. Measured result: zero such clashes on all four fixtures. Two jumpers of one net meeting are one conductor and are allowed.
5. **Routes live in the doc.** `buildLayoutDoc` routes when `options.wireStyle === 'orthogonal'` and returns `LayoutDoc.routes` (optional field), so stale-shape and fallback warnings reach `doc.warnings` and both views draw one set of paths. With curved wires nothing is routed and the doc and SVG are exactly as before. The part-drag verdict doc in `manipulate.ts` is built with curved wires, because routing lab3 takes about 170 ms and it is rebuilt on every snapped move.
6. **Tinned ends are not instanced cylinders.** The bare end bends out of the hole and onto the board, which a straight instanced cylinder cannot follow. Both bare ends are built by the same tube builder (8 sides, radius 2.1) as one geometry per wire. The jacket starts 7 units of arc length above the board top at each end, as specified.
7. **Selection overlay for a wire** is an accent line along its top. A tube is smooth all round, so `EdgesGeometry` finds no edges.
8. **Board3D interface.** The spec's `setSelected({ ref?, wire? })` is split: `setSelected(ref)` stays as in phase 1 and `setWireSelected(index)` is added. `pick()` returns `{ kind: 'wire', net, index }`, keeping `net` for the existing callers.
9. **Shaping needs square wires.** Handles, Re-route and Tidy all wires exist only when the Wires button reads "square". With curved wires, clicking a jumper still selects it and the card offers colours and a hint to switch.
10. **"Reset all wires" is "Tidy all wires"**, and it is undoable: its command stores every shape and its undo puts each one back. `layout/wire` accepts `key: "*"` with `path: null` for it.
11. **Clicking a wire now follows its net softly** (spec §5.3), replacing phase 1's hard follow.
12. **Power red, ground black** is already the engine's default (`COLOR_PLUS`, `COLOR_GND` in `makeNets`), and colours saved in the sidecar still win. Nothing changes; a test pins it.
13. **Render snapshots.** No 2D square-wire snapshot exists to regenerate. A structural test pins that the flat board draws `doc.routes` exactly, and the curved style stays byte-identical to `test/fixtures/PL1_1.flat.svg`.
14. **Humps** are trapezoids 2 pitches long: rising over the outer thirds, level over the middle third, one wire diameter high.
15. **Fallback wires** (search cap or no path) use the ortho.ts path, carry a `warning` that also lands in `doc.warnings`, are dashed on the flat board and glow red in 3D. They are off the lane grid, so a hand edit is refused with "Re-route it first".
16. **Server validation of a shape**: `normalizeWirePath` checks the shape (at most 64 points, finite `col`, string `gap`, integer `lane` with |lane| at most 4); `pathToPlan` rejects unknown corridor names; `checkPlan` rejects paths that are not square, do not leave their holes along the column, leave the board or cross a package.
17. **Colour keys are not undoable.** Only wire shapes join the History stack (spec §4.8 names `SetWirePath`); a colour is changed back the same way it was changed.

## Review Focus

The failure modes most likely to bite a user that no single task's happy-path test covers, and the task whose tests pin each.

1. **Dragging a part in square-wire mode on a big board must not stall.** Routing lab3 takes about 170 ms, and the drag verdict rebuilds a doc on every snapped move. The verdict doc is built with curved wires (Task 3 step "Keep the part-drag verdict from routing"; test "square wires put routes in the doc; curved ones leave the doc as it was").
2. **A part moved after a wire was shaped.** The saved key no longer matches a wire: the shape must be dropped with a warning naming the net, never drawn at the old holes (Task 1 test "a saved shape for a wire that is gone is dropped with a warning naming its net"; Task 3 test "a stale saved shape shows up in doc.warnings").
3. **Editing a fallback wire.** Its plan is off the lane grid, so saving it would store garbage. `planToPath` returns null and the editor says "Re-route it first" (Task 1 test "a plan off the half-pitch grid ... has no grid form").
4. **A double-click that cannot bend.** A run too short for a Z, or a bend that holds a wire's end on its column, must be refused with the plan unchanged (Task 5 tests "a run too short for a Z ... is left as it is" and "a corner that holds a hole-end run on its column cannot be removed").
5. **Undo of a reshape after the wire's key vanished** (its part moved since). The server answers 404, the command is dropped with the server's message, and the stack beneath is not blocked (Task 4 test "setWirePath refuses an unknown wire ..."; phase 1's History drop rule).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/layout/types.ts` | modify | `WirePoint`, `WirePath`, `Sidecar.wirePaths`, `normalizeWirePath` |
| `src/render/ortho.ts` | modify | Export `packageRects` (the router's obstacles) |
| `src/render/route3d.ts` | create | Pure router: lattice A*, saved shapes, fallback, nudging, rip-up, humps, grid conversions, `checkPlan` |
| `test/route-fixtures.ts` | create | The four fixture docs, shared by the router tests |
| `test/route3d.test.ts` | create | Routing core tests |
| `test/route3d-nudge.test.ts` | create | Lane packing and clash tests |
| `src/pipeline.ts` | modify | `LayoutDoc.routes` when square wires are asked for |
| `src/render/index.ts` | modify | Flat board draws `routes` (fallback wires dashed) |
| `client/editor3d/manipulate.ts` | modify | Part-drag verdict doc skips routing |
| `test/route3d-pipeline.test.ts` | create | Pipeline and flat-board tests |
| `server/service.ts` | modify | `Service.setWirePath` |
| `server/api.ts`, `server/openapi.ts` | modify | `POST /api/projects/:id/layout/wire` |
| `client/api.ts` | modify | `api.wirePath` |
| `client/panels.ts` | modify | Reset also clears `wirePaths` in the store |
| `src/edit/wireshape.ts` | create | Pure hand edits: handles, snapping, move run, move bend, add/remove bend pair |
| `test/wireshape.test.ts` | create | Its tests |
| `client/wiretube-math.ts` | create | Pure centre line, fillets, trim, parallel-transport tube rings |
| `test/wiretube.test.ts` | create | Its tests |
| `client/wiretube.ts` | create | three.js assembly of the tube and live reshaping |
| `client/board3d.ts` | modify | Flat wires from routes, wire pick index, selection line, preview, handles, projection, context-loss hook |
| `client/editor3d/workspace.ts` | modify | Context loss, wire editor wiring, soft follow, e2e hook members |
| `client/editor3d/wireEdit.ts` | create | Wire selection, handles, wire card, reshape commands, colour keys |
| `client/styles.css` | modify | Wire card swatches |
| `scripts/e2e-3d.ts` | modify | Six new scenarios |
| `docs/editor3d.md`, `AGENTS.md`, `README.md` | modify | Documentation |

---

### Task 1: Router core (saved shapes, lattice A*, fallback, humps)

**Files:**
- Modify: `src/layout/types.ts`, `src/render/ortho.ts`, `test/board.test.ts`
- Create: `src/render/route3d.ts`, `test/route-fixtures.ts`, `test/route3d.test.ts`

**Interfaces:**
- Consumes: `holeKey` from `src/layout/board.ts`; `HEIGHT`, `P`, `pt`, `ROWY`, `X0` from `src/render/geometry.ts`; `wirePolylines` and (newly exported) `packageRects` from `src/render/ortho.ts`.
- Produces (`src/layout/types.ts`):
  ```ts
  export interface WirePoint { col: number; gap: string; lane: number }
  export interface WirePath { points: WirePoint[] }
  // Sidecar gains: wirePaths: Record<string, WirePath>;  emptySidecar() has wirePaths: {}
  export function normalizeWirePath(x: unknown): WirePath | null;
  ```
- Produces (`src/render/route3d.ts`):
  ```ts
  export type Point = [number, number];
  export interface Lift { at: number; height: number }
  export interface WireRoute { plan: Point[]; lifts: Lift[]; warning?: string; locked?: true }
  export interface RouteResult { routes: WireRoute[]; warnings: string[] }
  export interface RouteInput { wires: Wire[]; packages: Package[]; board: BoardSpec; pinHoles: Record<string, Record<string, Hole>> }
  export const WIRE_R = 4, WIRE_D = 8, LANE = 9, MAX_EXPAND = 30000;
  export interface Gap { name: string; y: number }
  export const GAPS: Gap[];              // 'top', 'T+|T-', 'T-|a', 'a|b' ... 'j|B-', 'B-|B+', 'bottom'
  export const ROW_YS: Set<number>;      // plan y of every hole row
  export function wireKey(w: Wire): string;          // `${net}|${holeA}|${holeB}`, holes sorted
  export const keyNet: (key: string) => string;
  export interface Rect { x1: number; y1: number; x2: number; y2: number; id: string }
  export function chipRects(packages: Package[]): Rect[];
  export function simplify(plan: Point[]): Point[];
  export const planLength: (plan: Point[]) => number;
  export function checkPlan(plan: Point[], packages: Package[], board: BoardSpec): string | null;
  export function pathToPlan(w: Wire, path: WirePath): Point[] | null;
  export function planToPath(w: Wire, plan: Point[]): WirePath | null;
  export function routeWires(input: RouteInput, saved?: Record<string, WirePath>, opts?: { maxExpand?: number }): RouteResult;
  ```

- [ ] **Step 1: Write the failing sidecar test**

In `test/board.test.ts`:

a. Find:

```ts
import { Board, Occupancy, halfOf, hole, holeKey, holeName, isRail, parseHole, stripOf } from '../src/layout/board.ts';
import { emptySidecar, normalizeSidecar } from '../src/layout/types.ts';
```

Replace with:

```ts
import { Board, Occupancy, halfOf, hole, holeKey, holeName, isRail, parseHole, stripOf } from '../src/layout/board.ts';
import { emptySidecar, normalizeSidecar, normalizeWirePath } from '../src/layout/types.ts';
```

b. Find:

```ts
    expect(s.placed).toEqual({});
  });
});
```

Replace with:

```ts
    expect(s.placed).toEqual({});
  });

  test('wire shapes: an old sidecar has none, good ones are kept, malformed ones dropped', () => {
    expect(normalizeSidecar({ pinned: {} }).wirePaths).toEqual({});
    expect(emptySidecar().wirePaths).toEqual({});
    const good = { points: [{ col: 12.5, gap: 'c|d', lane: 0 }, { col: 20, gap: 'e|f', lane: -1 }] };
    const s = normalizeSidecar({
      wirePaths: {
        '/A|a12|e20': good,
        '/B|a1|a2': { points: [{ col: 'x', gap: 'c|d', lane: 0 }] },
        '/C|a1|a3': { points: [{ col: 3, gap: 'c|d', lane: 0.5 }] },
        '/D|a1|a4': 'nope',
      },
    });
    expect(s.wirePaths).toEqual({ '/A|a12|e20': good });
    expect(normalizeWirePath({ points: [] })).toEqual({ points: [] });
    expect(normalizeWirePath({ points: [{ col: 3, gap: 'c|d', lane: 9 }] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to check it fails**

Run: `bun test test/board.test.ts`
Expected: FAIL: `normalizeWirePath` is not exported by `src/layout/types.ts`.

- [ ] **Step 3: Add the wire shape types and their normaliser**

In `src/layout/types.ts`:

a. Find:

```ts
  ledColors: Record<string, LedColour>;
}
```

Replace with:

```ts
  ledColors: Record<string, LedColour>;
  /**
   * Hand-shaped jumpers. Key: `${net}|${holeA}|${holeB}` with the two holes in
   * MCP naming (`e12`, `T+3`) sorted as strings; see wireKey in
   * src/render/route3d.ts. Absent from sidecars written before phase 2.
   */
  wirePaths: Record<string, WirePath>;
}

/** One bend of a hand-shaped jumper, in grid units rather than SVG units. */
export interface WirePoint {
  /** Column position in pitches; 12.5 sits halfway between columns 12 and 13. */
  col: number;
  /** The corridor it lies in, named by the rows either side ('c|d', 'e|f', 'T-|a'), or 'top' / 'bottom' outside the rails. */
  gap: string;
  /** Signed sub-lane inside that corridor, one per half pitch; 0 is its centre line. */
  lane: number;
}

/** The bends between a jumper's two end holes, listed from the hole whose name sorts first. */
export interface WirePath {
  points: WirePoint[];
}
```

b. Find:

```ts

export const emptySidecar = (): Sidecar => ({ version: 1, options: defaultOptions(), pinned: {}, colors: {}, placed: {}, ledColors: {} });
```

Replace with:

```ts

export const emptySidecar = (): Sidecar => ({ version: 1, options: defaultOptions(), pinned: {}, colors: {}, placed: {}, ledColors: {}, wirePaths: {} });
```

c. Find:

```ts
  return !!x && typeof x === 'object' && Number.isInteger((x as Hole).col) && (x as Hole).col >= 1 && ROWS.has((x as Hole).row);
}
```

Replace with:

```ts
  return !!x && typeof x === 'object' && Number.isInteger((x as Hole).col) && (x as Hole).col >= 1 && ROWS.has((x as Hole).row);
}

/**
 * A saved wire shape as it came off disk or the wire, or null when it is not
 * one. Only the shape is checked here; whether its corridors exist on the
 * board and whether it clears the chips is the router's business.
 */
export function normalizeWirePath(x: unknown): WirePath | null {
  const pts = (x as { points?: unknown } | null)?.points;
  if (!Array.isArray(pts) || pts.length > 64) return null;
  const out: WirePoint[] = [];
  for (const p of pts) {
    if (!p || typeof p !== 'object') return null;
    const { col, gap, lane } = p as WirePoint;
    if (typeof col !== 'number' || !Number.isFinite(col) || typeof gap !== 'string' || !Number.isInteger(lane) || Math.abs(lane) > 4) return null;
    out.push({ col, gap, lane });
  }
  return { points: out };
}
```

d. Find:

```ts
    for (const [ref, c] of Object.entries(o.ledColors)) if (typeof c === 'string' && (LED_COLOURS as readonly string[]).includes(c)) s.ledColors[ref] = c as LedColour;
  }
```

Replace with:

```ts
    for (const [ref, c] of Object.entries(o.ledColors)) if (typeof c === 'string' && (LED_COLOURS as readonly string[]).includes(c)) s.ledColors[ref] = c as LedColour;
  }
  if (o.wirePaths && typeof o.wirePaths === 'object') {
    for (const [key, path] of Object.entries(o.wirePaths)) {
      const clean = normalizeWirePath(path);
      if (clean) s.wirePaths[key] = clean;
    }
  }
```

- [ ] **Step 4: Run it to check it passes**

Run: `bun test test/board.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing router tests**

Create `test/route-fixtures.ts`:

```ts
// The four example boards the router is measured on, laid out once for every
// router test file.

import { readFileSync } from 'node:fs';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';

export const FIXTURES: Record<string, string> = {
  PL1_1: 'test/fixtures/PL1_1.net',
  lab3: 'examples/Lab3_Prelab_Example.net',
  'lab4-74ls08': 'test/fixtures/lab4-74ls08.net',
  'lab4-decoder': 'test/fixtures/lab4-decoder.net',
};

/** Each fixture's doc with curved wires (so the pipeline does not route it: the tests do). */
export const docs: Record<string, LayoutDoc> = Object.fromEntries(Object.entries(FIXTURES).map(([name, file]) => [name, buildLayoutDoc(parseNetlist(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), emptySidecar())]));
```

Create `test/route3d.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { pt } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { checkPlan, GAPS, LANE, pathToPlan, planToPath, routeWires, wireKey, WIRE_D, type Point } from '../src/render/route3d.ts';
import { docs, FIXTURES } from './route-fixtures.ts';

const routed = Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, routeWires(doc)]));

describe('routeWires on the fixtures', () => {
  for (const name of Object.keys(FIXTURES)) {
    const doc = docs[name];
    const { routes, warnings } = routed[name];

    test(`${name}: every jumper starts and ends in its holes, and none needed the fallback`, () => {
      expect(warnings).toEqual([]);
      routes.forEach((r, i) => {
        expect(r.plan[0]).toEqual(pt(doc.wires[i].a));
        expect(r.plan[r.plan.length - 1]).toEqual(pt(doc.wires[i].b));
        expect(r.warning).toBeUndefined();
      });
    });

    test(`${name}: every run is square, leaves its holes along the column, stays on the board and clear of the chips`, () => {
      const bad = routes.map((r, i) => [i, checkPlan(r.plan, doc.packages, doc.board)]).filter(([, why]) => why);
      expect(bad).toEqual([]);
    });

    test(`${name}: every crossing has exactly one hump, one wire diameter high`, () => {
      const plans = routes.map((r) => r.plan);
      let crossings = 0;
      for (let i = 0; i < plans.length; i++) {
        for (let j = i + 1; j < plans.length; j++) {
          for (let s = 0; s + 1 < plans[i].length; s++) {
            for (let t = 0; t + 1 < plans[j].length; t++) {
              const [a, b, c, d] = [plans[i][s], plans[i][s + 1], plans[j][t], plans[j][t + 1]];
              const ah = a[1] === b[1];
              if (ah === (c[1] === d[1])) continue;
              const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
              if (v1[0] > Math.min(h1[0], h2[0]) + 0.5 && v1[0] < Math.max(h1[0], h2[0]) - 0.5 && h1[1] > Math.min(v1[1], v2[1]) + 0.5 && h1[1] < Math.max(v1[1], v2[1]) - 0.5) crossings++;
            }
          }
        }
      }
      const lifts = routes.flatMap((r) => r.lifts);
      expect(lifts.length).toBe(crossings);
      expect(lifts.every((l) => l.height === WIRE_D)).toBe(true);
    });

    test(`${name}: routing twice gives the same paths`, () => {
      expect(routeWires(doc)).toEqual(routed[name]);
    });
  }
});

describe('hand-shaped wires', () => {
  const doc = docs.PL1_1;
  const i = routed.PL1_1.routes.findIndex((r) => r.plan.length >= 4);
  const w = doc.wires[i];
  const auto = routed.PL1_1.routes[i].plan;

  test('a plan survives the trip to grid units and back, whichever way round the wire is stored', () => {
    const path = planToPath(w, auto)!;
    expect(path.points.length).toBe(auto.length - 2);
    expect(pathToPlan(w, path)).toEqual(auto);
    const flipped = { ...w, a: w.b, b: w.a };
    expect(planToPath(flipped, [...auto].reverse())).toEqual(path);
    expect(pathToPlan(flipped, path)).toEqual([...auto].reverse());
    expect(path.points.every((p) => GAPS.some((g) => g.name === p.gap))).toBe(true);
  });

  test('a plan off the half-pitch grid (the simple router draws those) has no grid form', () => {
    const off: Point[] = [auto[0], [auto[0][0], auto[1][1] - 5], [auto[auto.length - 1][0], auto[1][1] - 5], auto[auto.length - 1]];
    expect(planToPath(w, off)).toBeNull();
  });

  test('a saved shape is used exactly as saved, and marked locked', () => {
    // Slide the wire's second run (the first that is not in a hole) one lane over.
    const across = auto[1][0] === auto[2][0] ? 0 : 1;
    const shaped = auto.map((p, n) => (n === 1 || n === 2 ? ((across ? [p[0], p[1] + LANE] : [p[0] + LANE, p[1]]) as Point) : p));
    expect(checkPlan(shaped, doc.packages, doc.board)).toBeNull();
    const again = routeWires(doc, { [wireKey(w)]: planToPath(w, shaped)! });
    expect(again.warnings).toEqual([]);
    expect(again.routes[i].plan).toEqual(shaped);
    expect(again.routes[i].locked).toBe(true);
  });

  test('a saved shape for a wire that is gone is dropped with a warning naming its net', () => {
    const again = routeWires(doc, { '/NOPE|a1|a9': { points: [{ col: 1, gap: 'a|b', lane: 0 }, { col: 9, gap: 'a|b', lane: 0 }] } });
    expect(again.warnings).toEqual(['hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; dropped']);
    expect(again.routes).toEqual(routed.PL1_1.routes);
  });

  test('a saved shape naming a corridor the board lacks is re-routed with a warning; a run through a chip is refused', () => {
    const odd = routeWires(doc, { [wireKey(w)]: { points: [{ col: 3, gap: 'x|y', lane: 0 }] } });
    expect(odd.warnings[0]).toContain(`hand-shaped jumper for ${w.net}`);
    expect(odd.warnings[0]).toContain('names a corridor');
    expect(odd.routes[i].locked).toBeUndefined();
    const [cx] = pt({ col: doc.packages[0].col0 + 1, row: 'd' });
    expect(checkPlan([[cx, pt({ col: 1, row: 'd' })[1]], [cx, pt({ col: 1, row: 'g' })[1]]], doc.packages, doc.board)).toBe(`the path runs through ${doc.packages[0].id}`);
  });
});

describe('search cap', () => {
  test('a search that gives up falls back to the ortho.ts path, with a warning, and never throws', () => {
    const doc = docs['lab4-74ls08'];
    const { routes, warnings } = routeWires(doc, {}, { maxExpand: 1 });
    const fell = routes.map((_, i) => i).filter((i) => routes[i].warning);
    expect(fell.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(fell.length);
    for (const i of fell) {
      expect(routes[i].plan).toEqual(wirePolylines([doc.wires[i]], doc.packages, doc.board)[0]);
      expect(routes[i].warning).toContain(doc.wires[i].net);
    }
  });
});
```

- [ ] **Step 6: Run them to check they fail**

Run: `bun test test/route3d.test.ts`
Expected: FAIL: cannot find module `../src/render/route3d.ts`.

- [ ] **Step 7: Export the package rectangles from ortho.ts**

In `src/render/ortho.ts`:

a. Find:

```ts
/** Where the bodies are, so no run is drawn through a chip. */
function packageRects(packages: Package[]): Rect[] {
  return packages.map((pkg) => {
```

Replace with:

```ts
/** Where the bodies are, so no run is drawn through a chip. */
export function packageRects(packages: Package[]): Rect[] {
  return packages.map((pkg) => {
```

- [ ] **Step 8: Write the router core**

Create `src/render/route3d.ts` (passes 1, 2 and 4; Task 2 adds pass 3, the nudging):

```ts
// Square-cornered jumpers that lie flat on the board, the way a carefully
// hand-wired breadboard looks: cut to length, flush on the plastic, bent
// tight, bundled in parallel lanes, and never run over a chip.
//
// Four passes, after libavoid's route-then-nudge (Wybrow, Marriott and
// Stuckey 2009):
//   1. Hand-shaped wires first. A saved path whose end holes still match a
//      wire is used as it is and holds its lines; one that matches no wire is
//      dropped with a warning naming its net.
//   2. Every other wire, shortest first, is found by A* over a lattice with a
//      node every half pitch, the heading in the state so that a bend can
//      cost something. Without a bend penalty the cheapest paths staircase.
//   3. Nudging. Runs that ended up on the same line are packed into parallel
//      lanes with the left-edge algorithm, ordered so a bundle does not cross
//      itself where its wires peel off. Wires still sharing a line after that
//      are ripped up and searched again with sharing made dear, a few rounds.
//   4. Where two wires still cross, the one laid later humps over.
//
// Pure: a function of the wires, the packages, the legs and the saved paths,
// so the flat board and the 3D board draw the same wires. The old corridor
// router in ortho.ts is the fallback when a search gives up.

import { holeKey } from '../layout/board.ts';
import type { BoardSpec, Hole, Package, Row, Wire, WirePath, WirePoint } from '../layout/types.ts';
import { HEIGHT, P, pt, ROWY, X0 } from './geometry.ts';
import { packageRects, wirePolylines } from './ortho.ts';

export type Point = [number, number];

/** A hump where this wire passes over another: `at` is the distance along the plan, in SVG units. */
export interface Lift {
  at: number;
  height: number;
}

export interface WireRoute {
  /** From the wire's `a` hole to its `b` hole, square corners only, in SVG units. */
  plan: Point[];
  lifts: Lift[];
  /** Set when no clean route was found and the simple router drew it instead. */
  warning?: string;
  /** Hand-shaped: taken from the sidecar, not routed. */
  locked?: true;
}

export interface RouteResult {
  routes: WireRoute[];
  warnings: string[];
}

export interface RouteInput {
  wires: Wire[];
  packages: Package[];
  board: BoardSpec;
  pinHoles: Record<string, Record<string, Hole>>;
}

/** The jacket's radius: 0.56 mm, so 1.1 mm across, like 22 AWG solid-core wire. */
export const WIRE_R = 4;
export const WIRE_D = 2 * WIRE_R;
/** Lane pitch: one wire diameter and a hair of air, which is half a hole pitch, so every lane sits on one grid. */
export const LANE = P / 2;
/** Expanded states before a search gives up and the simple router takes over, so a drag never stalls. */
export const MAX_EXPAND = 30000;

// A* weights, in SVG units of length (a pitch is 18).
const BEND = 60;
/** Per half pitch of line another wire already lies on; nudging can usually part two, rarely five. */
const SHARE = 40;
/** The same down a column track, where there is far less room to part them. */
const SHARE_V = 400;
/** Through a node where another wire turns: the two would look joined. */
const TOUCH = 400;
/** Per wire crossed. */
const CROSS = 10;
/** Per half pitch hugging a package body. */
const NEAR_CHIP = 8;
/** Per half pitch along a row of holes, or down a column of them, rather than between. */
const ON_HOLES = 4;
/** Air between a wire and a body it must not cross, as in ortho.ts. */
const AIR = 3;
/** How close to a body counts as hugging it. */
const HUG = 4;

const ROWS: Row[] = ['T+', 'T-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'B-', 'B+'];

export interface Gap {
  name: string;
  /** The corridor's centre line. */
  y: number;
}

/**
 * The corridors, top to bottom: one outside each rail, and one between each
 * pair of neighbouring hole rows, named by those rows. A saved bend is a
 * corridor and a signed lane from its centre line, one lane per half pitch.
 */
export const GAPS: Gap[] = (() => {
  const out: Gap[] = [{ name: 'top', y: ROWY['T+'] - P }];
  for (let i = 0; i + 1 < ROWS.length; i++) out.push({ name: `${ROWS[i]}|${ROWS[i + 1]}`, y: (ROWY[ROWS[i]] + ROWY[ROWS[i + 1]]) / 2 });
  out.push({ name: 'bottom', y: ROWY['B+'] + P });
  return out;
})();
const GAP_INDEX = new Map(GAPS.map((g, i) => [g.name, i]));

/** The lines wires may lie on: every half pitch from the top corridor to the bottom one. */
const Y0 = GAPS[0].y;
const LINES = Math.round((GAPS[GAPS.length - 1].y - Y0) / LANE) + 1;
/** Plan y of the lines that run along a row of holes. */
export const ROW_YS = new Set(ROWS.map((r) => ROWY[r]));

/** The sidecar key for a wire's hand shape: its net and both holes, sorted as strings. */
export function wireKey(w: Wire): string {
  return `${w.net}|${[holeKey(w.a), holeKey(w.b)].sort().join('|')}`;
}

/** The net a wire key names (a net name may itself contain '|'). */
export const keyNet = (key: string) => key.split('|').slice(0, -2).join('|');
/** The two holes a wire key names, as "e12-a20". */
const keyHoles = (key: string) => key.split('|').slice(-2).join('-');

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
}

/** Package bodies with a little air round them: a wire must never cross one. */
export function chipRects(packages: Package[]): Rect[] {
  return packageRects(packages).map((r, i) => ({ x1: r.x1 - AIR, y1: r.y1 - AIR, x2: r.x2 + AIR, y2: r.y2 + AIR, id: packages[i].id }));
}

const grow = (r: Rect, m: number): Rect => ({ x1: r.x1 - m, y1: r.y1 - m, x2: r.x2 + m, y2: r.y2 + m, id: r.id });
const inside = (p: Point, r: Rect) => p[0] > r.x1 && p[0] < r.x2 && p[1] > r.y1 && p[1] < r.y2;
/** Whether an axis-aligned segment passes through the inside of a rectangle. */
const crosses = (a: Point, b: Point, r: Rect) => Math.max(a[0], b[0]) > r.x1 && Math.min(a[0], b[0]) < r.x2 && Math.max(a[1], b[1]) > r.y1 && Math.min(a[1], b[1]) < r.y2;
const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

/** Drop repeated points and points in the middle of a straight run; the two ends always stay. */
export function simplify(plan: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of plan) {
    if (out.length && same(out[out.length - 1], p)) continue;
    if (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]];
      const straight = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01);
      if (straight) out.pop();
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Length along a square-cornered plan. */
export const planLength = (plan: Point[]) => plan.reduce((s, p, i) => (i ? s + Math.abs(p[0] - plan[i - 1][0]) + Math.abs(p[1] - plan[i - 1][1]) : 0), 0);

/**
 * Why a plan cannot be a jumper on this board, or null when it can: square
 * corners only, straight out of each hole along its column, on the board,
 * and never through a package body (other than one holding its own end).
 */
export function checkPlan(plan: Point[], packages: Package[], board: BoardSpec): string | null {
  if (plan.length < 2) return 'a jumper needs two ends';
  for (let i = 0; i + 1 < plan.length; i++) if (Math.abs(plan[i][0] - plan[i + 1][0]) > 0.01 && Math.abs(plan[i][1] - plan[i + 1][1]) > 0.01) return 'the path must turn square corners';
  const n = plan.length;
  if (Math.abs(plan[0][0] - plan[1][0]) > 0.01 || Math.abs(plan[n - 1][0] - plan[n - 2][0]) > 0.01) return 'a jumper has to leave each hole straight along its column';
  const width = 2 * X0 + (board.cols - 1) * P;
  if (plan.some(([x, y]) => x < WIRE_R || x > width - WIRE_R || y < WIRE_R || y > HEIGHT - WIRE_R)) return 'the path leaves the board';
  const ends = [plan[0], plan[n - 1]];
  for (const r of chipRects(packages)) {
    if (ends.some((e) => inside(e, r))) continue;
    for (let i = 0; i + 1 < n; i++) if (crosses(plan[i], plan[i + 1], r)) return `the path runs through ${r.id}`;
  }
  return null;
}

/** A saved shape turned into a plan from `w.a` to `w.b`, or null when it names a corridor this board lacks. */
export function pathToPlan(w: Wire, path: WirePath): Point[] | null {
  const pts: Point[] = [];
  for (const p of path.points) {
    const g = GAP_INDEX.get(p.gap);
    if (g === undefined) return null;
    pts.push([X0 + (p.col - 1) * P, GAPS[g].y + p.lane * LANE]);
  }
  if (holeKey(w.a) > holeKey(w.b)) pts.reverse();
  return [pt(w.a), ...pts, pt(w.b)];
}

/** A plan's bends in grid units, from the hole that sorts first; null when a bend is off the half-pitch grid. */
export function planToPath(w: Wire, plan: Point[]): WirePath | null {
  const points: WirePoint[] = [];
  for (const [x, y] of plan.slice(1, -1)) {
    let g = 0;
    for (let i = 1; i < GAPS.length; i++) if (Math.abs(y - GAPS[i].y) < Math.abs(y - GAPS[g].y)) g = i;
    const lane = Math.round((y - GAPS[g].y) / LANE);
    if (Math.abs(GAPS[g].y + lane * LANE - y) > 0.01 || Math.abs(lane) > 4) return null;
    points.push({ col: Math.round(((x - X0) / P + 1) * 1e6) / 1e6, gap: GAPS[g].name, lane });
  }
  if (holeKey(w.a) > holeKey(w.b)) points.reverse();
  return { points };
}

/** A binary min-heap of state ids. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      ids[i] = ids[up];
      keys[i] = keys[up];
      i = up;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop()!;
    const key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

const bump = (m: Map<number, number>, k: number, by: number) => {
  const v = (m.get(k) ?? 0) + by;
  if (v) m.set(k, v);
  else m.delete(k);
};

/**
 * The routing lattice and what the wires laid so far use of it. Nodes sit
 * every half pitch both ways: column tracks k (x = X0 + k * LANE, so even k
 * is a column of holes) by lines j (y = Y0 + j * LANE, some of them rows of
 * holes). A wire may lie across an empty hole, never on a leg or on another
 * wire's end.
 */
class Grid {
  readonly kMin = -1;
  readonly kMax: number;
  readonly nk: number;
  readonly hard: Rect[];
  private hug: Rect[];
  /** Nodes where a leg or a jumper end sits. */
  readonly taken = new Set<number>();
  private hUse = new Map<number, number>();
  private vUse = new Map<number, number>();
  private hPass = new Map<number, number>();
  private vPass = new Map<number, number>();
  /** Nodes where a wire turns: another one meeting it there would look joined to it. */
  private bendAt = new Map<number, number>();

  constructor(input: RouteInput) {
    this.kMax = 2 * input.board.cols - 1;
    this.nk = this.kMax - this.kMin + 1;
    this.hard = chipRects(input.packages);
    this.hug = this.hard.map((r) => grow(r, HUG));
    for (const pins of Object.values(input.pinHoles)) for (const h of Object.values(pins)) this.taken.add(this.at(pt(h)));
    for (const w of input.wires) {
      this.taken.add(this.at(pt(w.a)));
      this.taken.add(this.at(pt(w.b)));
    }
  }

  node(k: number, j: number) {
    return j * this.nk + (k - this.kMin);
  }

  /** The node nearest a point in SVG units. */
  at([x, y]: Point) {
    return this.node(Math.round((x - X0) / LANE), Math.round((y - Y0) / LANE));
  }

  x(k: number) {
    return X0 + k * LANE;
  }

  y(j: number) {
    return Y0 + j * LANE;
  }

  /** Record a plan (by = 1) or take it back (by = -1), so later searches pay for sharing its lines or crossing it. */
  claim(plan: Point[], by = 1) {
    for (const p of plan.slice(1, -1)) bump(this.bendAt, this.at(p), by);
    for (let i = 0; i + 1 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      const k1 = Math.round((Math.min(a[0], b[0]) - X0) / LANE);
      const k2 = Math.round((Math.max(a[0], b[0]) - X0) / LANE);
      const j1 = Math.round((Math.min(a[1], b[1]) - Y0) / LANE);
      const j2 = Math.round((Math.max(a[1], b[1]) - Y0) / LANE);
      if (Math.abs(a[1] - b[1]) < 0.01) {
        if (j1 < 0 || j1 >= LINES) continue;
        for (let k = Math.max(k1, this.kMin); k < Math.min(k2, this.kMax); k++) bump(this.hUse, this.node(k, j1), by);
        for (let k = Math.max(k1 + 1, this.kMin); k < Math.min(k2, this.kMax + 1); k++) bump(this.hPass, this.node(k, j1), by);
      } else {
        if (k1 < this.kMin || k1 > this.kMax) continue;
        for (let j = Math.max(j1, 0); j < Math.min(j2, LINES - 1); j++) bump(this.vUse, this.node(k1, j), by);
        for (let j = Math.max(j1 + 1, 0); j < Math.min(j2, LINES); j++) bump(this.vPass, this.node(k1, j), by);
      }
    }
  }

  /** The cheapest plan for one wire, or null when there is none within `cap` expanded states. `dear` scales the cost of sharing. */
  search(w: Wire, cap: number, dear = 1): Point[] | null {
    const pa = pt(w.a);
    const pb = pt(w.b);
    // A body holding one of this wire's own holes cannot bar it: it has to get there.
    const hard = this.hard.filter((r) => !inside(pa, r) && !inside(pb, r));
    const hug = this.hug.filter((r) => !inside(pa, r) && !inside(pb, r));
    const start = this.at(pa);
    const goal = this.at(pb);
    const n = this.nk * LINES * 4;
    const cost = new Float64Array(n).fill(Infinity);
    const bends = new Int32Array(n);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new Heap();
    const h = (k: number, j: number) => Math.abs(this.x(k) - pb[0]) + Math.abs(this.y(j) - pb[1]);
    // Headings: 0 up, 1 down, 2 left, 3 right. A jumper leaves its hole
    // straight up or straight down its column, and arrives the same way.
    for (const dir of [0, 1]) {
      cost[start * 4 + dir] = 0;
      heap.push(start * 4 + dir, Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]));
    }
    let expanded = 0;
    while (heap.size) {
      const s = heap.pop();
      if (closed[s]) continue;
      closed[s] = 1;
      const node = s >> 2;
      const dir = s & 3;
      if (node === goal) return this.unwind(s, from, pa, pb);
      if (++expanded > cap) return null;
      const j = Math.floor(node / this.nk);
      const k = (node % this.nk) + this.kMin;
      const c = cost[s];
      for (let m = 0; m < 4; m++) {
        if (m === (dir ^ 1)) continue;
        // Out of the start hole the only way is straight on.
        if (node === start && m !== dir) continue;
        const k2 = k + (m === 2 ? -1 : m === 3 ? 1 : 0);
        const j2 = j + (m === 0 ? -1 : m === 1 ? 1 : 0);
        if (k2 < this.kMin || k2 > this.kMax || j2 < 0 || j2 >= LINES) continue;
        const t = this.node(k2, j2);
        // Into the end hole only along its column; never onto anyone else's hole.
        if (t === goal ? m >= 2 : this.taken.has(t)) continue;
        const a: Point = [this.x(k), this.y(j)];
        const b: Point = [this.x(k2), this.y(j2)];
        if (hard.some((r) => crosses(a, b, r))) continue;
        let step = LANE;
        if (m >= 2) {
          step += dear * SHARE * (this.hUse.get(this.node(Math.min(k, k2), j)) ?? 0) + CROSS * (this.vPass.get(t) ?? 0);
          if (ROW_YS.has(a[1])) step += ON_HOLES;
        } else {
          step += dear * SHARE_V * (this.vUse.get(this.node(k, Math.min(j, j2))) ?? 0) + CROSS * (this.hPass.get(t) ?? 0);
          // A column of holes is where every jumper into it has to run; keep it for them.
          if (k % 2 === 0) step += ON_HOLES;
        }
        if (hug.some((r) => crosses(a, b, r))) step += NEAR_CHIP;
        if (this.bendAt.has(t)) step += dear * TOUCH;
        const turn = m !== dir;
        if (turn) step += BEND;
        const ts = t * 4 + m;
        const nc = c + step;
        const nb = bends[s] + (turn ? 1 : 0);
        if (nc < cost[ts] || (nc === cost[ts] && nb < bends[ts])) {
          cost[ts] = nc;
          bends[ts] = nb;
          from[ts] = s;
          // Ties go to the path with fewer bends.
          heap.push(ts, nc + h(k2, j2) + nb / 1000);
        }
      }
    }
    return null;
  }

  /** Walk a search back from the end hole to the start one. */
  private unwind(s: number, from: Int32Array, pa: Point, pb: Point): Point[] {
    const nodes: Point[] = [];
    for (let t = s; t >= 0; t = from[t]) {
      const node = t >> 2;
      nodes.push([this.x((node % this.nk) + this.kMin), this.y(Math.floor(node / this.nk))]);
    }
    nodes.reverse();
    // The two ends are the holes themselves, exactly.
    nodes[0] = [pa[0], pa[1]];
    nodes[nodes.length - 1] = [pb[0], pb[1]];
    return simplify(nodes);
  }
}

/** Where a horizontal and a vertical segment cross, strictly inside both, or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const ah = Math.abs(a[1] - b[1]) < 0.01;
  const ch = Math.abs(c[1] - d[1]) < 0.01;
  if (ah === ch) return null;
  const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
  const x = v1[0];
  const y = h1[1];
  const inH = x > Math.min(h1[0], h2[0]) + 0.5 && x < Math.max(h1[0], h2[0]) - 0.5;
  const inV = y > Math.min(v1[1], v2[1]) + 0.5 && y < Math.max(v1[1], v2[1]) - 0.5;
  return inH && inV ? [x, y] : null;
}

// ---------- the whole board ----------

/** Every wire's route, in the order of `input.wires`, and what went wrong on the way. Never throws. */
export function routeWires(input: RouteInput, saved: Record<string, WirePath> = {}, opts: { maxExpand?: number } = {}): RouteResult {
  const grid = new Grid(input);
  const cap = opts.maxExpand ?? MAX_EXPAND;
  const warnings: string[] = [];
  const keys = input.wires.map(wireKey);
  const plans: Point[][] = new Array(input.wires.length);
  const routes: WireRoute[] = new Array(input.wires.length);
  /** Wires whose plan is final before nudging: hand-shaped ones, then fallbacks. */
  const fixed: number[] = [];

  // 1. Hand-shaped wires, as saved.
  for (const [key, path] of Object.entries(saved)) {
    const i = keys.indexOf(key);
    if (i < 0) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer matches a wire; dropped`);
      continue;
    }
    const plan = pathToPlan(input.wires[i], path);
    const why = plan ? checkPlan(plan, input.packages, input.board) : 'it names a corridor this board does not have';
    if (!plan || why) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer fits (${why}); re-routed`);
      continue;
    }
    plans[i] = simplify(plan);
    routes[i] = { plan: plans[i], lifts: [], locked: true };
    grid.claim(plans[i]);
    fixed.push(i);
  }

  // 2. The rest, shortest first, so short hops keep the lines nearest their holes.
  const span = (w: Wire) => Math.abs(pt(w.a)[0] - pt(w.b)[0]) + Math.abs(pt(w.a)[1] - pt(w.b)[1]);
  const todo = input.wires.map((_, i) => i).filter((i) => !plans[i]).sort((i, j) => span(input.wires[i]) - span(input.wires[j]) || i - j);
  const auto: number[] = [];
  for (const i of todo) {
    const w = input.wires[i];
    const plan = grid.search(w, cap);
    if (plan) {
      plans[i] = plan;
      routes[i] = { plan, lifts: [] };
      auto.push(i);
    } else {
      const warning = `no clean route for the ${w.net} jumper (${holeKey(w.a)}-${holeKey(w.b)}); drawn with the simple router`;
      plans[i] = wirePolylines([w], input.packages, input.board)[0];
      routes[i] = { plan: plans[i], lifts: [], warning };
      warnings.push(warning);
      fixed.push(i);
    }
    grid.claim(plans[i]);
  }

  // 4. Humps: of each crossing pair, the wire laid later goes over.
  const layer = [...fixed, ...auto];
  for (let li = 0; li < layer.length; li++) {
    for (let lj = li + 1; lj < layer.length; lj++) {
      const under = routes[layer[li]].plan;
      const over = routes[layer[lj]];
      let before = 0;
      for (let s = 0; s + 1 < over.plan.length; s++) {
        const [a, b] = [over.plan[s], over.plan[s + 1]];
        for (let t = 0; t + 1 < under.length; t++) {
          const hit = crossing(a, b, under[t], under[t + 1]);
          if (hit) over.lifts.push({ at: before + Math.abs(hit[0] - a[0]) + Math.abs(hit[1] - a[1]), height: WIRE_D });
        }
        before += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      }
    }
  }
  for (const r of routes) r.lifts.sort((p, q) => p.at - q.at);
  return { routes, warnings };
}
```

- [ ] **Step 9: Run the tests to check they pass**

Run: `bun test test/route3d.test.ts`
Expected: PASS (22 tests, well under a second).

Run: `bun test` and `bun run typecheck`
Expected: 363 pass; typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add src/layout/types.ts src/render/ortho.ts src/render/route3d.ts test/board.test.ts test/route-fixtures.ts test/route3d.test.ts
git commit -m "feat(route3d): lattice router for flat square wires, saved shapes in the sidecar"
```

---

### Task 2: Nudging (lane packing, peel-off order, rip-up)

**Files:**
- Modify: `src/render/route3d.ts`
- Create: `test/route3d-nudge.test.ts`

**Interfaces:**
- Consumes: everything Task 1 put in `route3d.ts`.
- Produces (`src/render/route3d.ts`, in addition):
  ```ts
  export interface Run { wire: number; seg: number; lo: number; hi: number; loSide: number; hiSide: number }
  export function peelOrder(i: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>, j: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>): number;  // 1: i above j
  export function packLine(runs: Run[], free: (lane: number, run: Run) => boolean): Map<Run, number>;
  export function clashes(plans: Point[][], wires: number[], nets?: string[]): [number, number][];
  // routeWires's result is now nudged: no two wires of different nets lie along each other or meet at a bend.
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/route3d-nudge.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { LayoutDoc } from '../src/pipeline.ts';
import { pt } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { checkPlan, clashes, LANE, packLine, peelOrder, planToPath, routeWires, wireKey, type Point, type Run } from '../src/render/route3d.ts';
import { docs, FIXTURES } from './route-fixtures.ts';

const routed = Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, routeWires(doc)]));
const bends = (plan: Point[]) => Math.max(0, plan.length - 2);
const nets = (doc: LayoutDoc) => doc.wires.map((w) => w.net);

describe('nudged routes on the fixtures', () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`${name}: no jumper lies along, or turns on, a jumper of another net`, () => {
      const { routes } = routed[name];
      expect(clashes(routes.map((r) => r.plan), routes.map((_, i) => i), nets(docs[name]))).toEqual([]);
    });
  }

  // ortho.ts steps sideways out of a hole along the row and runs over legs
  // and jumper ends to save bends; this router may not. The fair comparison
  // is on the wires ortho draws legally, and on the two lab4 boards this one
  // must match it or win there.
  const legal = (doc: LayoutDoc, plan: Point[]) => {
    const taken = [...Object.values(doc.pinHoles).flatMap((p) => Object.values(p)), ...doc.wires.flatMap((w) => [w.a, w.b])].map(pt);
    const n = plan.length;
    if (plan[0][0] !== plan[1][0] || plan[n - 1][0] !== plan[n - 2][0]) return false;
    return !taken.some((h) => {
      if ((h[0] === plan[0][0] && h[1] === plan[0][1]) || (h[0] === plan[n - 1][0] && h[1] === plan[n - 1][1])) return false;
      return plan.slice(0, -1).some((a, i) => {
        const b = plan[i + 1];
        return a[1] === b[1] ? Math.abs(h[1] - a[1]) < 4 && h[0] >= Math.min(a[0], b[0]) - 3 && h[0] <= Math.max(a[0], b[0]) + 3 : Math.abs(h[0] - a[0]) < 4 && h[1] >= Math.min(a[1], b[1]) - 3 && h[1] <= Math.max(a[1], b[1]) + 3;
      });
    });
  };
  for (const name of ['lab4-74ls08', 'lab4-decoder']) {
    test(`${name}: no more bends than ortho.ts on the wires it draws legally`, () => {
      const doc = docs[name];
      const old = wirePolylines(doc.wires, doc.packages, doc.board);
      const fair = old.map((p, i) => (legal(doc, p) ? i : -1)).filter((i) => i >= 0);
      expect(fair.length).toBeGreaterThan(doc.wires.length / 2);
      const sum = (plans: Point[][]) => fair.reduce((s, i) => s + bends(plans[i]), 0);
      expect(sum(routed[name].routes.map((r) => r.plan))).toBeLessThanOrEqual(sum(old));
    });
  }

  test('on every fixture the total bend count stays within 1.7x of ortho.ts (a regression guard for the crowded boards)', () => {
    for (const name of Object.keys(FIXTURES)) {
      const doc = docs[name];
      const old = wirePolylines(doc.wires, doc.packages, doc.board).reduce((s, p) => s + bends(p), 0);
      const now = routed[name].routes.reduce((s, r) => s + bends(r.plan), 0);
      expect(now).toBeLessThanOrEqual(Math.ceil(old * 1.7));
    }
  });

  test('the other wires route round a hand-shaped one', () => {
    const doc = docs.PL1_1;
    const i = routed.PL1_1.routes.findIndex((r) => r.plan.length >= 4);
    const w = doc.wires[i];
    const auto = routed.PL1_1.routes[i].plan;
    const across = auto[1][0] === auto[2][0] ? 0 : 1;
    const shaped = auto.map((p, n) => (n === 1 || n === 2 ? ((across ? [p[0], p[1] + LANE] : [p[0] + LANE, p[1]]) as Point) : p));
    expect(checkPlan(shaped, doc.packages, doc.board)).toBeNull();
    const again = routeWires(doc, { [wireKey(w)]: planToPath(w, shaped)! });
    expect(again.routes[i].plan).toEqual(shaped);
    expect(clashes(again.routes.map((r) => r.plan), again.routes.map((_, n) => n), nets(doc))).toEqual([]);
  });
});

describe('lane packing', () => {
  const run = (wire: number, lo: number, hi: number, loSide: number, hiSide: number): Run => ({ wire, seg: 1, lo, hi, loSide, hiSide });
  const all = () => true;
  const lanesOf = (m: Map<Run, number>) => [...m.entries()].sort(([a], [b]) => a.wire - b.wire).map(([, l]) => l);

  test('a run that peels off upward inside another takes the upper lane, and downward the lower', () => {
    expect(peelOrder(run(1, 20, 80, -1, -1), run(0, 0, 100, 1, 1))).toBe(1);
    expect(peelOrder(run(1, 20, 80, 1, 1), run(0, 0, 100, -1, -1))).toBe(-1);
    const [outer, inner] = lanesOf(packLine([run(0, 0, 100, 1, 1), run(1, 20, 80, -1, -1)], all));
    expect(inner).toBeLessThan(outer);
    const [o2, i2] = lanesOf(packLine([run(0, 0, 100, -1, -1), run(1, 20, 80, 1, 1)], all));
    expect(i2).toBeGreaterThan(o2);
  });

  test('a bundle of three that peel off downward one after another nests without crossing, centred on the line', () => {
    // In from the left along the line, out downward at 40, 60 and 80: the
    // first to leave must be the lowest, or the others would cut across it.
    const runs = [run(0, 0, 80, -1, 1), run(1, 0, 60, -1, 1), run(2, 0, 40, -1, 1)];
    const lanes = packLine(runs, all);
    const l = (w: number) => lanes.get(runs[w])!;
    expect(l(2)).toBeGreaterThan(l(1));
    expect(l(1)).toBeGreaterThan(l(0));
    expect([l(0), l(1), l(2)].sort()).toEqual([-1, 0, 1]);
  });

  test('runs that do not overlap share a lane, and a blocked lane slides the bundle', () => {
    expect(lanesOf(packLine([run(0, 0, 40, 1, 1), run(1, 50, 90, 1, 1)], all))).toEqual([0, 0]);
    expect(lanesOf(packLine([run(0, 0, 40, 1, 1)], (lane) => lane !== 0))).toEqual([-1]);
  });
});
```

- [ ] **Step 2: Run them to check they fail**

Run: `bun test test/route3d-nudge.test.ts`
Expected: FAIL: `packLine`, `peelOrder` and `clashes` are not exported.

- [ ] **Step 3: Add the rip-up round count**

In `src/render/route3d.ts`, find:

```ts
/** Air between a wire and a body it must not cross, as in ortho.ts. */
```

and insert above it:

```ts
/** Rounds of ripping up and searching again the wires that still clash after nudging. */
const RIP_ROUNDS = 3;
```

- [ ] **Step 4: Teach the grid how many ways out of a hole there are**

In `src/render/route3d.ts`, inside `class Grid`, insert this, then a blank line, immediately above the line `  /** Record a plan (by = 1) or take it back (by = -1), so later searches pay for sharing its lines or crossing it. */`:

```ts
  /** How many ways out of a hole there are: up the column, down it, or both. */
  exits(p: Point): number {
    const hard = this.hard.filter((r) => !inside(p, r));
    return [-LANE, LANE].filter((d) => {
      const q: Point = [p[0], p[1] + d];
      return q[1] >= Y0 && q[1] <= Y0 + (LINES - 1) * LANE && !this.taken.has(this.at(q)) && !hard.some((r) => crosses(p, q, r));
    }).length;
  }
```

- [ ] **Step 5: Add the nudging section**

In `src/render/route3d.ts`, insert this, then a blank line, immediately above the line `/** Where a horizontal and a vertical segment cross, strictly inside both, or null. */`:

```ts
// ---------- nudging ----------

export interface Run {
  wire: number;
  /** Index of the run's first point in the wire's plan. */
  seg: number;
  lo: number;
  hi: number;
  /** Which way the run at each end leaves: -1 up (or left), 1 down (or right), 0 straight on or none. */
  loSide: number;
  hiSide: number;
}

/** Where each placed run lies, so a lane can be tested against everything already down. */
class Occupancy {
  private lines = new Map<string, [number, number][]>();
  private key(horizontal: boolean, c: number) {
    return `${horizontal ? 'h' : 'v'}${Math.round(c * 2) / 2}`;
  }
  add(horizontal: boolean, c: number, lo: number, hi: number) {
    const k = this.key(horizontal, c);
    const list = this.lines.get(k) ?? [];
    list.push([lo, hi]);
    this.lines.set(k, list);
  }
  hits(horizontal: boolean, c: number, lo: number, hi: number) {
    return (this.lines.get(this.key(horizontal, c)) ?? []).some(([p, q]) => hi > p + 0.5 && lo < q - 0.5);
  }
  addPlan(plan: Point[]) {
    for (let i = 0; i + 1 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      if (Math.abs(a[1] - b[1]) < 0.01) this.add(true, a[1], Math.min(a[0], b[0]), Math.max(a[0], b[0]));
      else this.add(false, a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1]));
    }
  }
}

const sign = (v: number) => (v > 0.01 ? 1 : v < -0.01 ? -1 : 0);

/** The runs of the given wires, by the line they lie on; the first and last run (into the holes) never move. */
function runsOf(plans: Point[][], wires: number[], horizontal: boolean): Map<number, Run[]> {
  const along = horizontal ? 0 : 1;
  const across = horizontal ? 1 : 0;
  const out = new Map<number, Run[]>();
  for (const w of wires) {
    const plan = plans[w];
    for (let i = 1; i + 2 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      if (Math.abs(a[across] - b[across]) > 0.01) continue;
      const startSide = sign(plan[i - 1][across] - a[across]);
      const endSide = sign(plan[i + 2][across] - b[across]);
      const forward = a[along] <= b[along];
      const run: Run = { wire: w, seg: i, lo: Math.min(a[along], b[along]), hi: Math.max(a[along], b[along]), loSide: forward ? startSide : endSide, hiSide: forward ? endSide : startSide };
      const c = Math.round(a[across] * 2) / 2;
      out.set(c, [...(out.get(c) ?? []), run]);
    }
  }
  return out;
}

const overlap = (a: Run, b: Run) => a.hi > b.lo + 0.5 && a.lo < b.hi - 0.5;

/**
 * Must `i` take a smaller lane (above, or left of) `j` for the two not to
 * cross where one peels off? 1 yes, -1 the other way round, 0 no rule. A run
 * that starts or ends inside the other's span leaves the line there; if it
 * leaves upwards it has to be the upper one, or it would cut across.
 */
export function peelOrder(i: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>, j: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>): number {
  let v = 0;
  if (i.lo > j.lo + 0.5 && i.lo < j.hi - 0.5 && i.loSide) v += i.loSide < 0 ? 1 : -1;
  if (i.hi < j.hi - 0.5 && i.hi > j.lo + 0.5 && i.hiSide) v += i.hiSide < 0 ? 1 : -1;
  if (j.lo > i.lo + 0.5 && j.lo < i.hi - 0.5 && j.loSide) v -= j.loSide < 0 ? 1 : -1;
  if (j.hi < i.hi - 0.5 && j.hi > i.lo + 0.5 && j.hiSide) v -= j.hiSide < 0 ? 1 : -1;
  return Math.sign(v);
}

/**
 * Pack the runs on one line into lanes. Each bundle of overlapping runs is
 * ordered by the peel-off rule (a topological sort; a cycle is broken by
 * which way the runs lean), stacked with the left-edge algorithm, centred on
 * the line, and slid sideways as a whole if that is what clears the legs,
 * bodies and fixed wires already there. A bundle that no slide clears is
 * placed a run at a time, each on the free lane nearest the one it wanted, or
 * left where the search put it. Returns run -> lane offset.
 */
export function packLine(runs: Run[], free: (lane: number, run: Run) => boolean): Map<Run, number> {
  const out = new Map<Run, number>();
  const sorted = [...runs].sort((a, b) => a.lo - b.lo || a.wire - b.wire || a.seg - b.seg);
  const bundles: Run[][] = [];
  let reach = -Infinity;
  for (const r of sorted) {
    if (bundles.length && r.lo < reach - 0.5) bundles[bundles.length - 1].push(r);
    else {
      bundles.push([r]);
      reach = -Infinity;
    }
    reach = Math.max(reach, r.hi);
  }
  for (const bundle of bundles) {
    const above = new Map<Run, Set<Run>>(bundle.map((r) => [r, new Set()]));
    for (const a of bundle) for (const b of bundle) if (a !== b && a.wire !== b.wire && overlap(a, b) && peelOrder(a, b) > 0) above.get(b)!.add(a);
    const lean = (r: Run) => r.loSide + r.hiSide;
    const rel = new Map<Run, number>();
    const left = new Set(bundle);
    while (left.size) {
      const ready = [...left].filter((r) => [...above.get(r)!].every((p) => !left.has(p)));
      const pool = ready.length ? ready : [...left];
      pool.sort((a, b) => lean(a) - lean(b) || a.wire - b.wire || a.seg - b.seg);
      const r = pool[0];
      left.delete(r);
      let lane = 0;
      for (const p of above.get(r)!) if (rel.has(p)) lane = Math.max(lane, rel.get(p)! + 1);
      while ([...rel].some(([q, l]) => l === lane && overlap(q, r))) lane++;
      rel.set(r, lane);
    }
    const count = Math.max(...rel.values()) + 1;
    const start = -Math.floor((count - 1) / 2);
    const shift = [0, -1, 1, -2, 2].find((s) => bundle.every((r) => free(start + rel.get(r)! + s, r)));
    if (shift !== undefined) {
      for (const r of bundle) out.set(r, start + rel.get(r)! + shift);
      continue;
    }
    const placed: [Run, number][] = [];
    for (const r of [...bundle].sort((a, b) => rel.get(a)! - rel.get(b)!)) {
      const want = start + rel.get(r)!;
      const lanes = [0, 1, -1, 2, -2, 3, -3, 4, -4].map((d) => want + d).filter((l) => Math.abs(l) <= 4);
      const lane = lanes.find((l) => free(l, r) && !placed.some(([q, ql]) => ql === l && overlap(q, r))) ?? 0;
      placed.push([r, lane]);
      out.set(r, lane);
    }
  }
  return out;
}

/**
 * Slide whole runs of a plan sideways (`moves`: run index -> new line). A run
 * whose neighbour lay on the same line gets a jog to stay joined to it.
 */
function shiftRuns(plan: Point[], moves: Map<number, number>, horizontal: boolean): Point[] {
  const across = horizontal ? 1 : 0;
  const out: Point[] = [];
  for (let i = 0; i + 1 < plan.length; i++) {
    const a: Point = [plan[i][0], plan[i][1]];
    const b: Point = [plan[i + 1][0], plan[i + 1][1]];
    const v = moves.get(i);
    if (v !== undefined) a[across] = b[across] = v;
    if (!out.length || !same(out[out.length - 1], a)) out.push(a);
    out.push(b);
  }
  return simplify(out);
}

/** Split a long run out of a hole after its first half pitch, so the rest of it can be nudged. */
function freeEnds(plan: Point[]): Point[] {
  const p = plan.map((q) => [q[0], q[1]] as Point);
  const step = (from: Point, to: Point): Point => [from[0], from[1] + Math.sign(to[1] - from[1]) * LANE];
  if (p.length >= 2 && Math.abs(p[1][1] - p[0][1]) > LANE + 0.01) p.splice(1, 0, step(p[0], p[1]));
  const n = p.length;
  if (n >= 2 && Math.abs(p[n - 2][1] - p[n - 1][1]) > LANE + 0.01) p.splice(n - 1, 0, step(p[n - 1], p[n - 2]));
  return p;
}

/** Nudge the searched plans of `auto` apart around the `fixed` ones. Returns every wire's plan. */
function nudge(grid: Grid, board: BoardSpec, given: Point[][], fixed: number[], auto: number[]): Point[][] {
  const plans = given.map((p, i) => (auto.includes(i) ? freeEnds(p) : p));
  const width = 2 * X0 + (board.cols - 1) * P;
  for (const horizontal of [true, false]) {
    const occ = new Occupancy();
    for (const i of fixed) occ.addPlan(plans[i]);
    // The runs into the holes cannot move, so they are in the way too.
    for (const i of auto) {
      occ.addPlan(plans[i].slice(0, 2));
      occ.addPlan(plans[i].slice(-2));
    }
    const moves = new Map<number, Map<number, number>>();
    for (const [c, runs] of runsOf(plans, auto, horizontal)) {
      const onGrid = (p: Point) => grid.taken.has(grid.at(p));
      const free = (lane: number, r: Run) => {
        const v = c + lane * LANE;
        if (horizontal ? v < Y0 || v > Y0 + (LINES - 1) * LANE : v < X0 - LANE || v > width - X0 + LANE) return false;
        if (occ.hits(horizontal, v, r.lo, r.hi)) return false;
        const a: Point = horizontal ? [r.lo, v] : [v, r.lo];
        const b: Point = horizontal ? [r.hi, v] : [v, r.hi];
        if (grid.hard.some((rect) => crosses(a, b, rect))) return false;
        // Not along a row (or down a column) of holes where a leg or a jumper end sits.
        for (let t = r.lo; t <= r.hi + 0.01; t += LANE) if (onGrid(horizontal ? [t, v] : [v, t])) return false;
        // The runs at each end stretch to meet the new line: not across a leg or a body either.
        for (const e of [r.lo, r.hi]) {
          const p: Point = horizontal ? [e, c] : [c, e];
          const q: Point = horizontal ? [e, v] : [v, e];
          if (grid.hard.some((rect) => crosses(p, q, rect))) return false;
          for (let t = Math.min(c, v); t <= Math.max(c, v) + 0.01; t += LANE) if (onGrid(horizontal ? [e, t] : [t, e])) return false;
        }
        return true;
      };
      for (const [r, lane] of packLine(runs, free)) {
        const v = c + lane * LANE;
        if (!moves.has(r.wire)) moves.set(r.wire, new Map());
        moves.get(r.wire)!.set(r.seg, v);
        occ.add(horizontal, v, r.lo, r.hi);
      }
    }
    for (const [w, m] of moves) plans[w] = shiftRuns(plans[w], m, horizontal);
  }
  return plans.map((p, i) => (auto.includes(i) ? simplify(p) : p));
}

/**
 * Pairs of wires that would look joined: a run lying along part of another's,
 * or a bend of one lying on the other. Indices into `plans`.
 */
export function clashes(plans: Point[][], wires: number[], nets?: string[]): [number, number][] {
  const onSeg = (p: Point, a: Point, b: Point) => (Math.abs(a[0] - b[0]) < 0.01 ? Math.abs(p[0] - a[0]) < 0.5 && p[1] >= Math.min(a[1], b[1]) - 0.5 && p[1] <= Math.max(a[1], b[1]) + 0.5 : Math.abs(p[1] - a[1]) < 0.5 && p[0] >= Math.min(a[0], b[0]) - 0.5 && p[0] <= Math.max(a[0], b[0]) + 0.5);
  const out: [number, number][] = [];
  for (let x = 0; x < wires.length; x++) {
    for (let y = x + 1; y < wires.length; y++) {
      // Two jumpers of one net meeting are one conductor: nothing is misread.
      if (nets && nets[wires[x]] === nets[wires[y]]) continue;
      const [p, q] = [plans[wires[x]], plans[wires[y]]];
      let hit = false;
      for (let i = 0; i + 1 < p.length && !hit; i++) {
        for (let j = 0; j + 1 < q.length && !hit; j++) {
          const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
          const ah = Math.abs(a[1] - b[1]) < 0.01;
          const ch = Math.abs(c[1] - d[1]) < 0.01;
          if (ah === ch && (ah ? Math.abs(a[1] - c[1]) < 0.5 : Math.abs(a[0] - c[0]) < 0.5)) {
            const [lo1, hi1] = ah ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
            const [lo2, hi2] = ah ? [Math.min(c[0], d[0]), Math.max(c[0], d[0])] : [Math.min(c[1], d[1]), Math.max(c[1], d[1])];
            if (hi1 > lo2 + 1 && lo1 < hi2 - 1) hit = true;
          }
        }
      }
      for (const b of p.slice(1, -1)) for (let j = 0; j + 1 < q.length && !hit; j++) if (onSeg(b, q[j], q[j + 1])) hit = true;
      for (const b of q.slice(1, -1)) for (let i = 0; i + 1 < p.length && !hit; i++) if (onSeg(b, p[i], p[i + 1])) hit = true;
      if (hit) out.push([wires[x], wires[y]]);
    }
  }
  return out;
}
```

- [ ] **Step 6: Nudge and rip up in routeWires**

In `src/render/route3d.ts`, inside `routeWires`, insert this, then a blank line, immediately above the line `  // 4. Humps: of each crossing pair, the wire laid later goes over.`:

```ts
  // 3. Nudge; then rip up whatever still looks joined to a wire of another
  // net, search it again with sharing made dear, and nudge again, a few times.
  let final = nudge(grid, input.board, plans, fixed, auto);
  for (let round = 1; round <= RIP_ROUNDS; round++) {
    const again = new Set(clashes(final, [...fixed, ...auto], input.wires.map((w) => w.net)).flat().filter((i) => auto.includes(i)));
    if (!again.size) break;
    for (const i of again) grid.claim(plans[i], -1);
    // A wire with only one way out of a hole goes first. Then the longest in
    // odd rounds (the short hops in their way have room to move) and the
    // shortest in even ones, in case it was the other way round.
    const exits = (i: number) => Math.min(grid.exits(pt(input.wires[i].a)), grid.exits(pt(input.wires[i].b)));
    const longer = round % 2 ? 1 : -1;
    for (const i of auto.filter((i) => again.has(i)).sort((i, j) => exits(i) - exits(j) || longer * (span(input.wires[j]) - span(input.wires[i])) || i - j)) {
      plans[i] = grid.search(input.wires[i], cap, 10 * round) ?? plans[i];
      grid.claim(plans[i]);
    }
    final = nudge(grid, input.board, plans, fixed, auto);
  }
  for (const i of auto) routes[i].plan = final[i];
```

- [ ] **Step 7: Run the tests to check they pass**

Run: `bun test test/route3d-nudge.test.ts test/route3d.test.ts`
Expected: PASS (11 and 22 tests). The whole router test run takes about 1.3 s; lab3 routes in under 250 ms.

Run: `bun test` and `bun run typecheck`
Expected: 374 pass; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/render/route3d.ts test/route3d-nudge.test.ts
git commit -m "feat(route3d): pack shared runs into lanes, rip up and re-route clashes"
```

---

### Task 3: One set of paths: the pipeline and the flat board

**Files:**
- Modify: `src/pipeline.ts`, `src/render/index.ts`, `client/editor3d/manipulate.ts`
- Create: `test/route3d-pipeline.test.ts`

**Interfaces:**
- Consumes: `routeWires`, `WireRoute`, `Point` from `src/render/route3d.ts`.
- Produces:
  ```ts
  // src/pipeline.ts
  export interface LayoutDoc extends EngineResult { /* ... */ routes?: WireRoute[] }  // only with wireStyle 'orthogonal'
  // src/render/index.ts
  export function renderSvg(res: EngineResult & { routes?: WireRoute[] }, opts?: RenderOptions): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/route3d-pipeline.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COLOR_GND, COLOR_PLUS } from '../src/layout/engine.ts';
import { emptySidecar, type Sidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';

const design = parseNetlist(readFileSync(new URL('./fixtures/PL1_1.net', import.meta.url), 'utf8'));
const square = (): Sidecar => ({ ...emptySidecar(), options: { ...emptySidecar().options, wireStyle: 'orthogonal' } });

describe('pipeline', () => {
  test('square wires put routes in the doc; curved ones leave the doc as it was', () => {
    expect(buildLayoutDoc(design, emptySidecar()).routes).toBeUndefined();
    const doc = buildLayoutDoc(design, square());
    expect(doc.routes?.length).toBe(doc.wires.length);
  });

  test('power jumpers stay red and ground ones black unless the sidecar says otherwise', () => {
    const doc = buildLayoutDoc(design, square());
    expect(doc.nets['+5V'].color).toBe(COLOR_PLUS);
    expect(doc.nets.GND.color).toBe(COLOR_GND);
  });

  test('a stale saved shape shows up in doc.warnings', () => {
    const s = square();
    s.wirePaths['/NOPE|a1|a9'] = { points: [] };
    expect(buildLayoutDoc(design, s).warnings).toContain('hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; dropped');
  });
});

describe('the flat board', () => {
  test('square wires are drawn along the routed paths, the same ones the 3D board uses', () => {
    const doc = buildLayoutDoc(design, square());
    const svg = renderSvg(doc, { wireStyle: 'orthogonal' });
    for (const r of doc.routes!) expect(svg).toContain(`d="${r.plan.map(([x, y], k) => `${k ? 'L' : 'M'} ${x} ${y}`).join(' ')}"`);
    expect(svg).not.toContain('stroke-dasharray');
  });

  test('the arc style is byte-for-byte what it was, routes or no routes', () => {
    const arc = buildLayoutDoc(design, emptySidecar());
    expect(renderSvg({ ...arc, routes: buildLayoutDoc(design, square()).routes })).toBe(renderSvg(arc));
    expect(renderSvg(arc)).toBe(readFileSync(new URL('./fixtures/PL1_1.flat.svg', import.meta.url), 'utf8'));
  });
});
```

- [ ] **Step 2: Run them to check they fail**

Run: `bun test test/route3d-pipeline.test.ts`
Expected: FAIL: `doc.routes` is undefined for square wires, and the stale-shape warning is missing.

- [ ] **Step 3: Route in the pipeline**

In `src/pipeline.ts`:

a. Find:

```ts
import type { Design } from './netlist.ts';
import { buildSimModel, truthTable, type SimModel, type TruthTable } from './sim/index.ts';
```

Replace with:

```ts
import type { Design } from './netlist.ts';
import { routeWires, type WireRoute } from './render/route3d.ts';
import { buildSimModel, truthTable, type SimModel, type TruthTable } from './sim/index.ts';
```

b. Find:

```ts
  sim: { model: SimModel; truthTable: TruthTable | null; note: string | null };
}
```

Replace with:

```ts
  sim: { model: SimModel; truthTable: TruthTable | null; note: string | null };
  /**
   * Square-cornered jumper routes, one per wire, present only when the
   * sidecar asks for square wires. The flat board and the 3D board both draw
   * these, so the two views always agree.
   */
  routes?: WireRoute[];
}
```

c. Find:

```ts
  if (!note && model.notSimulated.length) note = `not simulated: ${model.notSimulated.join(', ')}`;
  return { ...res, steps: buildSteps(design, res, model), pinouts: buildPinouts(design, res), partsList: buildPartsList(res), checks, sim: { model, truthTable: table, note } };
}
```

Replace with:

```ts
  if (!note && model.notSimulated.length) note = `not simulated: ${model.notSimulated.join(', ')}`;
  const doc: LayoutDoc = { ...res, steps: buildSteps(design, res, model), pinouts: buildPinouts(design, res), partsList: buildPartsList(res), checks, sim: { model, truthTable: table, note } };
  if (sidecar.options.wireStyle !== 'orthogonal') return doc;
  // Routed here rather than at draw time so the stale-shape warnings reach
  // doc.warnings and every view draws the one set of paths.
  const routed = routeWires(res, sidecar.wirePaths ?? {});
  return { ...doc, routes: routed.routes, warnings: [...res.warnings, ...routed.warnings] };
}
```

- [ ] **Step 4: Draw the routes on the flat board**

In `src/render/index.ts`:

a. Find:

```ts
import { wireControls, type Control } from './routing.ts';
import { wirePolylines, type Point as OrthoPoint } from './ortho.ts';
import type { EngineResult } from '../layout/engine.ts';
```

Replace with:

```ts
import { wireControls, type Control } from './routing.ts';
import { routeWires, type Point as OrthoPoint, type WireRoute } from './route3d.ts';
import type { EngineResult } from '../layout/engine.ts';
```

b. Find:

```ts

/** A square-cornered jumper: a dark edge under the coloured run, mitred corners, and a dot in each hole. */
function drawOrthoWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined, pts: OrthoPoint[]): string {
  const rail = isRail(w.a.row) || isRail(w.b.row);
```

Replace with:

```ts

/**
 * A square-cornered jumper: a dark edge under the coloured run, mitred
 * corners, and a dot in each hole. One the router could not route cleanly is
 * dashed, the same flag the 3D board shows as a red tint.
 */
function drawOrthoWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined, pts: OrthoPoint[], warn: boolean): string {
  const rail = isRail(w.a.row) || isRail(w.b.row);
```

c. Find:

```ts
    el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.38)', 'stroke-width': width + 1.6, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round' }) +
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round' }) +
      el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) +
```

Replace with:

```ts
    el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.38)', 'stroke-width': width + 1.6, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round' }) +
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round', 'stroke-dasharray': warn ? '5 3' : undefined }) +
      el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) +
```

d. Find:

```ts

export function renderSvg(res: EngineResult, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;
```

Replace with:

```ts

/**
 * `res.routes` is what the pipeline routed for square wires (LayoutDoc has it
 * when the sidecar asks for them); a bare engine result is routed here.
 */
export function renderSvg(res: EngineResult & { routes?: WireRoute[] }, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;
```

e. Find:

```ts
  const controls = ortho ? [] : wireControls(res.wires);
  const polylines = ortho ? wirePolylines(res.wires, res.packages, res.board) : [];
  const ctx: SkinContext = { parts: res.parts, board: res.board, ledColors: res.ledColors ?? {}, leds: Object.fromEntries(res.parts.filter((p) => p.style === 'LED').map((p) => [p.id, ledState(p.id, sim)])) };
```

Replace with:

```ts
  const controls = ortho ? [] : wireControls(res.wires);
  const routes = ortho ? (res.routes ?? routeWires(res).routes) : [];
  const ctx: SkinContext = { parts: res.parts, board: res.board, ledColors: res.ledColors ?? {}, leds: Object.fromEntries(res.parts.filter((p) => p.style === 'LED').map((p) => [p.id, ledState(p.id, sim)])) };
```

f. Find:

```ts
    el('g', { class: 'parts' }, res.parts.map((p) => drawPart(p, res, t, sim, dimPart, sk)).join('')),
    el('g', { class: 'wires' }, res.wires.map((w, i) => (ortho ? drawOrthoWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), polylines[i]) : drawWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), sk, controls[i]))).join('')),
    drawSupply(res, t, hl?.wire !== undefined ? () => undefined : dim),
```

Replace with:

```ts
    el('g', { class: 'parts' }, res.parts.map((p) => drawPart(p, res, t, sim, dimPart, sk)).join('')),
    el('g', { class: 'wires' }, res.wires.map((w, i) => (ortho ? drawOrthoWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), routes[i].plan, !!routes[i].warning) : drawWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), sk, controls[i]))).join('')),
    drawSupply(res, t, hl?.wire !== undefined ? () => undefined : dim),
```

- [ ] **Step 5: Keep the part-drag verdict from routing**

In `client/editor3d/manipulate.ts`:

a. Find:

```ts
        if (drag.verdict.ok) {
          const doc = buildLayoutDoc(p.design, { ...p.sidecar, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } });
          const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
```

Replace with:

```ts
        if (drag.verdict.ok) {
          // Curved wires for this check: only the engine's warnings are read,
          // and routing square wires on every snapped move would stall a big board.
          const doc = buildLayoutDoc(p.design, { ...p.sidecar, options: { ...p.sidecar.options, wireStyle: 'arc' }, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } });
          const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `bun test test/route3d-pipeline.test.ts test/ortho.test.ts test/render.test.ts`
Expected: PASS. `ortho.test.ts` still passes: it tests `wirePolylines` itself, and its render test builds a doc with curved wires, which `renderSvg` routes on the spot.

Run: `bun test` and `bun run typecheck`
Expected: 379 pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline.ts src/render/index.ts client/editor3d/manipulate.ts test/route3d-pipeline.test.ts
git commit -m "feat(pipeline): route square wires into the doc; the flat board draws them"
```

---

### Task 4: Saving a wire shape (Service, REST, client API)

**Files:**
- Modify: `server/service.ts`, `server/api.ts`, `server/openapi.ts`, `client/api.ts`, `client/panels.ts`, `test/service.test.ts`, `test/api.test.ts`

**Interfaces:**
- Consumes: `normalizeWirePath`, `WirePath` (Task 1); `checkPlan`, `pathToPlan`, `wireKey` (Task 1).
- Produces:
  ```ts
  // server/service.ts
  async setWirePath(id: string, key: string, path: WirePath | null): Promise<OpenProject>;  // key '*' + null clears all
  // POST /api/projects/:id/layout/wire   body { key: string, path: WirePath | null }  -> LayoutDoc
  // 400 malformed body or refused shape, 404 unknown project or wire key
  // client/api.ts
  wirePath: (id: string, key: string, path: WirePath | null) => Promise<LayoutDoc>;
  ```

- [ ] **Step 1: Write the failing tests**

In `test/service.test.ts`:

a. Find:

```ts
import { Service, ServiceError, type ProjectEvent } from '../server/service.ts';
import { Events } from '../server/watch.ts';
```

Replace with:

```ts
import { Service, ServiceError, type ProjectEvent } from '../server/service.ts';
import { LANE, planToPath, wireKey } from '../src/render/route3d.ts';
import { Events } from '../server/watch.ts';
```

b. Find:

```ts
    expect(backups.length).toBe(6);
  });
});
```

Replace with:

```ts
    expect(backups.length).toBe(6);
  });
});

describe('hand-shaped wires', () => {
  test('setWirePath keeps a shape, the doc routes it as saved, and null or "*" forgets it', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const square = await service.setOptions(p.info.id, { wireStyle: 'orthogonal' });
    const i = square.doc.routes!.findIndex((r) => r.plan.length >= 4);
    const w = square.doc.wires[i];
    const auto = square.doc.routes![i].plan;
    // Slide the second run one lane over, as a hand drag would.
    const across = auto[1][0] === auto[2][0] ? 0 : 1;
    const shaped = auto.map((q, n) => (n === 1 || n === 2 ? ((across ? [q[0], q[1] + LANE] : [q[0] + LANE, q[1]]) as [number, number]) : q));
    const key = wireKey(w);
    const saved = await service.setWirePath(p.info.id, key, planToPath(w, shaped)!);
    expect(saved.doc.routes![i].plan).toEqual(shaped);
    expect(saved.doc.routes![i].locked).toBe(true);
    expect(JSON.parse(readFileSync(sidecarPath(sch), 'utf8')).wirePaths[key]).toEqual(planToPath(w, shaped));
    const cleared = await service.setWirePath(p.info.id, key, null);
    expect(cleared.sidecar.wirePaths[key]).toBeUndefined();
    expect(cleared.doc.routes![i].locked).toBeUndefined();
    await service.setWirePath(p.info.id, key, planToPath(w, shaped)!);
    const all = await service.setWirePath(p.info.id, '*', null);
    expect(all.sidecar.wirePaths).toEqual({});
  });

  test('setWirePath refuses an unknown wire, a malformed path, a path through a chip and "*" with a path', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const w = p.doc.wires[0];
    await expect(service.setWirePath(p.info.id, '/NOPE|a1|a2', null)).rejects.toThrow(/no jumper/);
    await expect(service.setWirePath(p.info.id, wireKey(w), { points: [{ col: 3, gap: 'x|y', lane: 0 }] })).rejects.toThrow(/path must be/);
    await expect(service.setWirePath(p.info.id, wireKey(w), { nope: 1 } as never)).rejects.toThrow(/path must be/);
    // d22 to d27 runs above U3; down into the centre channel and along it goes straight through the chip.
    const over = p.doc.wires.find((k) => wireKey(k) === 'Net-(U3-Pad13)|d22|d27')!;
    const through = { points: [{ col: 22, gap: 'e|f', lane: 0 }, { col: 27, gap: 'e|f', lane: 0 }] };
    await expect(service.setWirePath(p.info.id, wireKey(over), through)).rejects.toThrow('cannot shape the Net-(U3-Pad13) jumper: the path runs through U3');
    await expect(service.setWirePath(p.info.id, '*', { points: [] })).rejects.toThrow(/only clears/);
    const reset = await service.resetLayout(p.info.id);
    expect(reset.sidecar.wirePaths).toEqual({});
  });
});
```

In `test/api.test.ts`:

a. Find:

```ts
    expect(col.nets['/A'].color).toBe('#abcdef');
    const reset = await (await json(`/api/projects/${id}/layout/reset`, {})).json();
```

Replace with:

```ts
    expect(col.nets['/A'].color).toBe('#abcdef');
    const wire = await json(`/api/projects/${id}/layout/wire`, { key: '*', path: null });
    expect(wire.status).toBe(200);
    const badWire = await json(`/api/projects/${id}/layout/wire`, { key: '/NOPE|a1|a2', path: null });
    expect(badWire.status).toBe(404);
    expect((await json(`/api/projects/${id}/layout/wire`, { path: null })).status).toBe(400);
    const reset = await (await json(`/api/projects/${id}/layout/reset`, {})).json();
```

- [ ] **Step 2: Run them to check they fail**

Run: `bun test test/service.test.ts test/api.test.ts`
Expected: FAIL: `service.setWirePath is not a function`, and `layout/wire` answers 404.

- [ ] **Step 3: Add Service.setWirePath**

In `server/service.ts`:

a. Find:

```ts
import { parseSchematic, type Schematic } from '../src/kicad/schematic.ts';
import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist, type Design } from '../src/netlist.ts';
```

Replace with:

```ts
import { parseSchematic, type Schematic } from '../src/kicad/schematic.ts';
import type { Hole, Options, Sidecar, WirePath } from '../src/layout/types.ts';
import { emptySidecar, normalizeWirePath } from '../src/layout/types.ts';
import { parseNetlist, type Design } from '../src/netlist.ts';
```

b. Find:

```ts
import { LED_COLOURS, type LedColour } from '../src/parts/led.ts';
import { simulate, type SimResult } from '../src/sim/index.ts';
```

Replace with:

```ts
import { LED_COLOURS, type LedColour } from '../src/parts/led.ts';
import { checkPlan, pathToPlan, wireKey } from '../src/render/route3d.ts';
import { simulate, type SimResult } from '../src/sim/index.ts';
```

c. Find:

```ts
  /**
   * Choose an LED's colour on the board. Stored in the sidecar, never in the
```

Replace with:

```ts
  /**
   * Keep the hand shape of one jumper (or, with null, forget it), keyed as
   * wireKey() makes it: net|holeA|holeB with the holes sorted. Key "*" with
   * null forgets every one. Only the layout sidecar changes, never the
   * schematic. A shape that is not square, does not leave its holes along
   * their columns, leaves the board or runs through a package is refused.
   */
  async setWirePath(id: string, key: string, path: WirePath | null): Promise<OpenProject> {
    const p = this.get(id);
    if (key === '*') {
      if (path !== null) throw new ServiceError('key "*" only clears every hand shape: send "path": null');
      p.sidecar.wirePaths = {};
      return this.rebuild(p);
    }
    const wire = p.doc.wires.find((w) => wireKey(w) === key);
    if (!wire) throw new ServiceError(`no jumper ${key} on the board (a key is net|holeA|holeB with the holes sorted, for example "/A|a12|e20")`, 404);
    if (path === null) {
      delete p.sidecar.wirePaths[key];
      return this.rebuild(p);
    }
    const clean = normalizeWirePath(path);
    const plan = clean && pathToPlan(wire, clean);
    if (!clean || !plan) throw new ServiceError('path must be {"points": [{"col": 12.5, "gap": "c|d", "lane": 0}, ...]}, with corridors named "top", "T+|T-", "a|b" ... "B-|B+", "bottom"');
    const why = checkPlan(plan, p.doc.packages, p.doc.board);
    if (why) throw new ServiceError(`cannot shape the ${wire.net} jumper: ${why}`);
    p.sidecar.wirePaths[key] = clean;
    return this.rebuild(p);
  }

  /**
   * Choose an LED's colour on the board. Stored in the sidecar, never in the
```

- [ ] **Step 4: Add the endpoint and document it**

In `server/api.ts`:

a. Find:

```ts
import { streamSSE } from 'hono/streaming';
import { PART_ALIASES, resolveAlias } from '../src/parts/aliases.ts';
```

Replace with:

```ts
import { streamSSE } from 'hono/streaming';
import type { WirePath } from '../src/layout/types.ts';
import { PART_ALIASES, resolveAlias } from '../src/parts/aliases.ts';
```

b. Find:

```ts
  });
  api.post('/projects/:id/layout/reset', async (c) => c.json((await service.resetLayout(c.req.param('id'))).doc));
```

Replace with:

```ts
  });
  api.post('/projects/:id/layout/wire', async (c) => {
    const body = (await c.req.json()) as { key?: string; path?: WirePath | null };
    if (!body.key || body.path === undefined) throw new ServiceError('body must be {"key": "/A|a12|e20", "path": {"points": [{"col": 12.5, "gap": "c|d", "lane": 0}]} | null}');
    return c.json((await service.setWirePath(c.req.param('id'), body.key, body.path)).doc);
  });
  api.post('/projects/:id/layout/reset', async (c) => c.json((await service.resetLayout(c.req.param('id'))).doc));
```

In `server/openapi.ts`:

a. Find:

```ts
      '/api/projects/{id}/layout/colors': { post: op('Set a net colour', { requestBody: body({ type: 'object', required: ['net'], properties: { net: { type: 'string' }, color: { type: ['string', 'null'] } } }) }) },
      '/api/projects/{id}/layout/reset': { post: op('Forget pinned placements, options and colours') },
      '/api/projects/{id}/erc': { post: op('Run KiCad ERC') },
```

Replace with:

```ts
      '/api/projects/{id}/layout/colors': { post: op('Set a net colour', { requestBody: body({ type: 'object', required: ['net'], properties: { net: { type: 'string' }, color: { type: ['string', 'null'] } } }) }) },
      '/api/projects/{id}/layout/wire': { post: op('Keep or forget the hand shape of one jumper (key "*" with path null forgets all)', { requestBody: body({ type: 'object', required: ['key', 'path'], properties: { key: { type: 'string', description: 'net|holeA|holeB, the two holes sorted, e.g. "/A|a12|e20"' }, path: { type: ['object', 'null'], properties: { points: { type: 'array', items: { type: 'object', properties: { col: { type: 'number' }, gap: { type: 'string' }, lane: { type: 'integer' } } } } } } } }) }) },
      '/api/projects/{id}/layout/reset': { post: op('Forget pinned placements, options, colours and wire shapes') },
      '/api/projects/{id}/erc': { post: op('Run KiCad ERC') },
```

- [ ] **Step 5: Add the client call, and clear shapes on Reset in the store**

In `client/api.ts`:

a. Find:

```ts

import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
```

Replace with:

```ts

import type { Hole, Options, Sidecar, WirePath } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
```

b. Find:

```ts
  ledColor: (id: string, ref: string, color: string | null) => post<LayoutDoc>(`/api/projects/${id}/layout/ledcolor`, { ref, color }),
  reset: (id: string) => post<LayoutDoc>(`/api/projects/${id}/layout/reset`, {}),
```

Replace with:

```ts
  ledColor: (id: string, ref: string, color: string | null) => post<LayoutDoc>(`/api/projects/${id}/layout/ledcolor`, { ref, color }),
  /** Keep a jumper's hand shape, or forget it with null; key "*" and null forget them all. */
  wirePath: (id: string, key: string, path: WirePath | null) => post<LayoutDoc>(`/api/projects/${id}/layout/wire`, { key, path }),
  reset: (id: string) => post<LayoutDoc>(`/api/projects/${id}/layout/reset`, {}),
```

In `client/panels.ts` (the server's `resetLayout` already starts from `emptySidecar()`, which clears `wirePaths`; the store has to agree):

a. Find:

```ts
        const doc = await api.reset(p.id);
        store.setProject({ doc, sidecar: { ...p.sidecar, pinned: {}, colors: {}, options: doc.board ? { ...p.sidecar.options, board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {}, wireStyle: 'arc' } : p.sidecar.options } });
      } catch (err) {
```

Replace with:

```ts
        const doc = await api.reset(p.id);
        store.setProject({ doc, sidecar: { ...p.sidecar, pinned: {}, colors: {}, wirePaths: {}, options: doc.board ? { ...p.sidecar.options, board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {}, wireStyle: 'arc' } : p.sidecar.options } });
      } catch (err) {
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `bun test test/service.test.ts test/api.test.ts`
Expected: PASS.

Run: `bun test` and `bun run typecheck`
Expected: 381 pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add server/service.ts server/api.ts server/openapi.ts client/api.ts client/panels.ts test/service.test.ts test/api.test.ts
git commit -m "feat(api): layout/wire saves or forgets a jumper's hand shape"
```

---

### Task 5: Hand edits to a wire plan (pure)

**Files:**
- Create: `src/edit/wireshape.ts`, `test/wireshape.test.ts`

**Interfaces:**
- Consumes: `P`, `X0` from `src/render/geometry.ts`; `GAPS`, `LANE`, `ROW_YS`, `simplify`, `Point` from `src/render/route3d.ts`.
- Produces:
  ```ts
  export interface Handle { kind: 'segment' | 'bend'; index: number; at: Point; horizontal: boolean }
  export function handles(plan: Point[]): Handle[];
  export function snapAcross(horizontal: boolean, v: number): number;
  export function moveSegment(plan: Point[], i: number, to: number): Point[];
  export function moveBend(plan: Point[], k: number, to: Point): Point[];
  export function nearestRun(plan: Point[], p: Point): number;
  export function addBendPair(plan: Point[], i: number, at: Point): Point[];   // returns `plan` itself when the run is too short
  export function removeBend(plan: Point[], k: number): Point[] | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/wireshape.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { addBendPair, handles, moveBend, moveSegment, nearestRun, removeBend, snapAcross } from '../src/edit/wireshape.ts';
import { P, ROWY, X0 } from '../src/render/geometry.ts';
import { LANE, ROW_YS, type Point } from '../src/render/route3d.ts';

// Hole a12 up into corridor T-|a, along to column 20, down into a20.
const x = (col: number) => X0 + (col - 1) * P;
const U: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), ROWY.a]];
/** Square corners, and the first and last runs along the holes' columns. */
const square = (plan: Point[]) => {
  for (let i = 0; i + 1 < plan.length; i++) expect(plan[i][0] === plan[i + 1][0] || plan[i][1] === plan[i + 1][1]).toBe(true);
  expect(plan[0][0]).toBe(plan[1][0]);
  expect(plan[plan.length - 1][0]).toBe(plan[plan.length - 2][0]);
};

describe('snapAcross', () => {
  test('runs across the board snap to corridor lanes, never onto a row of holes', () => {
    expect(snapAcross(true, 66)).toBe(66);
    expect(snapAcross(true, ROWY.c + 1)).not.toBe(ROWY.c);
    for (let y = 0; y < 350; y += 3) expect(ROW_YS.has(snapAcross(true, y))).toBe(false);
  });

  test('runs down the board snap between columns, never onto a column of holes', () => {
    expect(snapAcross(false, x(12))).toBe(x(12) + P / 2);
    expect(snapAcross(false, x(12) - 2)).toBe(x(12) - P / 2);
    expect(snapAcross(false, x(12) + P / 2 + 3)).toBe(x(12) + P / 2);
  });
});

describe('handles', () => {
  test('a segment handle on each run over two pitches, a bend handle on each corner', () => {
    const h = handles(U);
    expect(h.filter((k) => k.kind === 'segment').map((k) => k.index)).toEqual([1]);
    expect(h.find((k) => k.kind === 'segment')!.at).toEqual([(x(12) + x(20)) / 2, 66]);
    expect(h.find((k) => k.kind === 'segment')!.horizontal).toBe(true);
    expect(h.filter((k) => k.kind === 'bend').map((k) => k.index)).toEqual([1, 2]);
  });
});

describe('moveSegment', () => {
  test('a middle run moves across itself and its neighbours stretch', () => {
    const out = moveSegment(U, 1, 57);
    expect(out).toEqual([[x(12), ROWY.a], [x(12), 57], [x(20), 57], [x(20), ROWY.a]]);
  });

  test('a run out of a hole keeps its hole and gets a jog half a pitch out', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 174], [x(20), 174], [x(20), ROWY.j]];
    const out = moveSegment(long, 0, x(12) + P / 2);
    square(out);
    expect(out[0]).toEqual([x(12), ROWY.a]);
    expect(out[1]).toEqual([x(12), ROWY.a + LANE]);
    expect(out[2]).toEqual([x(12) + P / 2, ROWY.a + LANE]);
    expect(out[3]).toEqual([x(12) + P / 2, 174]);
  });

  test('a straight hole-to-hole run jogs out of both ends', () => {
    const out = moveSegment([[x(5), ROWY['T+']], [x(5), ROWY['B+']]], 0, x(5) + P / 2);
    square(out);
    expect(out.length).toBe(6);
    expect(out[0]).toEqual([x(5), ROWY['T+']]);
    expect(out[5]).toEqual([x(5), ROWY['B+']]);
  });
});

describe('moveBend', () => {
  test('a corner takes one coordinate from each of its runs and the path stays square', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(16), 66], [x(16), 111], [x(20), 111], [x(20), ROWY.c]];
    const out = moveBend(long, 2, [x(17) - P / 2 + P, 57]);
    square(out);
    expect(out).toContainEqual([x(17) + P / 2, 57]);
    expect(out[0]).toEqual(long[0]);
    expect(out[out.length - 1]).toEqual(long[long.length - 1]);
  });

  test('a corner next to a hole jogs rather than dragging the hole', () => {
    const out = moveBend(U, 1, [x(12) + P / 2, 57]);
    square(out);
    expect(out[0]).toEqual(U[0]);
    expect(out).toContainEqual([x(12) + P / 2, 57]);
  });
});

describe('addBendPair and removeBend', () => {
  test('a double-click puts a small Z in a run; removing either new corner takes the pair out again', () => {
    const z = addBendPair(U, 1, [x(16), 66]);
    square(z);
    expect(z.length).toBe(U.length + 2);
    expect(z).toContainEqual([x(16), 66]);
    const k = z.findIndex((p) => p[0] === x(16) && p[1] === 66);
    // Either new corner takes the pair out: one leaves the run on the new line, the other puts it back.
    expect(removeBend(z, k + 1)).toEqual(U);
    const other = removeBend(z, k)!;
    square(other);
    expect(other.length).toBe(U.length);
  });

  test('a Z in the run into a hole moves the part away from the hole', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), 174], [x(24), 174], [x(24), ROWY.j]];
    const z = addBendPair(long, 4, [x(24), 210]);
    square(z);
    expect(z[z.length - 1]).toEqual(long[long.length - 1]);
    expect(z[z.length - 2][0]).toBe(x(24));
  });

  test('a run too short for a Z (a single half-pitch jog) is left as it is', () => {
    const jog: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(12) + LANE, 66], [x(12) + LANE, 30]];
    expect(addBendPair(jog, 1, [x(12) + 4, 66])).toBe(jog);
  });

  test('a corner that holds a hole-end run on its column cannot be removed', () => {
    expect(removeBend(U, 1)).toBeNull();
    expect(removeBend(U, 0)).toBeNull();
  });

  test('nearestRun picks the run under a point', () => {
    expect(nearestRun(U, [x(15), 70])).toBe(1);
    expect(nearestRun(U, [x(12) - 3, 75])).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to check they fail**

Run: `bun test test/wireshape.test.ts`
Expected: FAIL: cannot find module `../src/edit/wireshape.ts`.

- [ ] **Step 3: Write the module**

Create `src/edit/wireshape.ts`:

```ts
// Hand edits to a square-cornered jumper, as pure functions on its plan (SVG
// units, from hole a to hole b). The 3D editor drives them from handles:
//
// - a segment handle drags one run sideways; its neighbours stretch. The
//   run out of a hole cannot leave its hole, so it gets a jog half a pitch
//   out and the rest of it moves (the "auto-jog" of JointJS and draw.io);
// - a bend handle moves one coordinate of each of its two runs, so the path
//   stays square;
// - a double-click adds a small Z to a run, or takes a bend out.
//
// Every result is simplified (no repeated or straight-through points). Runs
// across the board snap to corridor lanes and runs down it to the lines
// between columns, so a wire is never left lying along a row or column of
// holes by hand.

import { P, X0 } from '../render/geometry.ts';
import { GAPS, LANE, ROW_YS, simplify, type Point } from '../render/route3d.ts';

export interface Handle {
  kind: 'segment' | 'bend';
  /** segment: the run from plan[index] to plan[index + 1]; bend: plan[index]. */
  index: number;
  at: Point;
  /** segment: whether the run lies across the board (it then drags up and down). */
  horizontal: boolean;
}

const isH = (plan: Point[], i: number) => Math.abs(plan[i][1] - plan[i + 1][1]) < 0.01;
const runLength = (plan: Point[], i: number) => Math.abs(plan[i][0] - plan[i + 1][0]) + Math.abs(plan[i][1] - plan[i + 1][1]);

/** A segment handle on every run longer than about two pitches, and a bend handle on every corner. */
export function handles(plan: Point[]): Handle[] {
  const out: Handle[] = [];
  for (let i = 0; i + 1 < plan.length; i++) {
    if (runLength(plan, i) <= 2 * P - 0.01) continue;
    out.push({ kind: 'segment', index: i, at: [(plan[i][0] + plan[i + 1][0]) / 2, (plan[i][1] + plan[i + 1][1]) / 2], horizontal: isH(plan, i) });
  }
  for (let k = 1; k + 1 < plan.length; k++) out.push({ kind: 'bend', index: k, at: [plan[k][0], plan[k][1]], horizontal: false });
  return out;
}

const LANE_YS: number[] = (() => {
  const out: number[] = [];
  for (let y = GAPS[0].y; y <= GAPS[GAPS.length - 1].y + 0.01; y += LANE) if (!ROW_YS.has(y)) out.push(y);
  return out;
})();

/**
 * The nearest line a hand-moved run may lie on: a corridor lane for a run
 * across the board (never a row of holes), the line between two columns for
 * a run down it (never a column of holes).
 */
export function snapAcross(horizontal: boolean, v: number): number {
  if (horizontal) return LANE_YS.reduce((best, y) => (Math.abs(y - v) < Math.abs(best - v) ? y : best), LANE_YS[0]);
  return X0 + (Math.round((v - X0) / P - 0.5) + 0.5) * P;
}

/** Move run i so it lies on `to` across itself, without simplifying (moveBend does two in a row). */
function shift(plan: Point[], i: number, to: number): Point[] {
  const across = isH(plan, i) ? 1 : 0;
  const along = 1 - across;
  const out = plan.map((p) => [p[0], p[1]] as Point);
  const n = out.length;
  const jog = (hole: Point, toward: Point): Point => {
    const p: Point = [hole[0], hole[1]];
    p[along] += Math.sign(toward[along] - hole[along]) * LANE;
    return p;
  };
  if (n === 2) {
    // Hole to hole in one run: jog out of both ends.
    const [a, b] = [out[0], out[1]];
    const [ja, jb] = [jog(a, b), jog(b, a)];
    const [ma, mb] = [[...ja] as Point, [...jb] as Point];
    ma[across] = to;
    mb[across] = to;
    return [a, ja, ma, mb, jb, b];
  }
  if (i === 0) {
    const ja = jog(out[0], out[1]);
    const m: Point = [...ja] as Point;
    m[across] = to;
    out[1][across] = to;
    return [out[0], ja, m, ...out.slice(1)];
  }
  if (i === n - 2) {
    const jb = jog(out[n - 1], out[n - 2]);
    const m: Point = [...jb] as Point;
    m[across] = to;
    out[n - 2][across] = to;
    return [...out.slice(0, n - 1), m, jb, out[n - 1]];
  }
  out[i][across] = to;
  out[i + 1][across] = to;
  return out;
}

/** Drag run i sideways to `to` (a coordinate across the run; snap it first). */
export function moveSegment(plan: Point[], i: number, to: number): Point[] {
  return simplify(shift(plan, i, to));
}

/** Drag the corner plan[k] to `to`: the run before it and the run after it each take one of its coordinates. */
export function moveBend(plan: Point[], k: number, to: Point): Point[] {
  // The later run first: a jog it adds at the far end does not move index k - 1.
  const after = shift(plan, k, isH(plan, k) ? to[1] : to[0]);
  return simplify(shift(after, k - 1, isH(after, k - 1) ? to[1] : to[0]));
}

/** The run of a plan nearest a point, for a double-click on the wire. */
export function nearestRun(plan: Point[], p: Point): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < plan.length; i++) {
    const [a, b] = [plan[i], plan[i + 1]];
    const x = Math.min(Math.max(p[0], Math.min(a[0], b[0])), Math.max(a[0], b[0]));
    const y = Math.min(Math.max(p[1], Math.min(a[1], b[1])), Math.max(a[1], b[1]));
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * Put a small Z into run i at the point nearest `at`: one part of the run
 * steps one line over. The part that steps is the one away from a hole, so
 * the ends stay put; a run from hole to hole gets a bump instead.
 */
export function addBendPair(plan: Point[], i: number, at: Point): Point[] {
  const h = isH(plan, i);
  const across = h ? 1 : 0;
  const along = 1 - across;
  const [a, b] = [plan[i], plan[i + 1]];
  const lo = Math.min(a[along], b[along]) + LANE;
  const hi = Math.max(a[along], b[along]) - LANE;
  if (hi < lo) return plan;
  // On the half-pitch grid along the run, a lane in from each end.
  const origin = along === 0 ? X0 : GAPS[0].y;
  const mid = Math.min(hi, Math.max(lo, origin + Math.round((at[along] - origin) / LANE) * LANE));
  const c = a[across];
  const next = snapAcross(h, c + LANE + 0.01);
  const pt = (t: number, v: number): Point => (h ? [t, v] : [v, t]);
  const last = plan.length - 2;
  if (plan.length === 2) {
    const [m1, m2] = [mid - LANE, mid + LANE].map((t) => Math.min(hi, Math.max(lo, t)));
    const s = Math.sign(b[along] - a[along]) || 1;
    const [p1, p2] = s > 0 ? [m1, m2] : [m2, m1];
    return simplify([a, pt(p1, c), pt(p1, next), pt(p2, next), pt(p2, c), b]);
  }
  if (i === last) {
    // The part before the Z steps over; the run into hole b stays on its column.
    return simplify([...plan.slice(0, i), pt(a[along], next), pt(mid, next), pt(mid, c), b]);
  }
  return simplify([...plan.slice(0, i + 1), pt(mid, c), pt(mid, next), pt(b[along], next), ...plan.slice(i + 2)]);
}

/**
 * Take the corner plan[k] out by swapping it for the opposite corner of the
 * rectangle its two runs span; with a straight run either side that removes
 * the pair. Null when the result would no longer leave a hole along its
 * column, or nothing changed.
 */
export function removeBend(plan: Point[], k: number): Point[] | null {
  if (k < 1 || k > plan.length - 2) return null;
  const [p, c, q] = [plan[k - 1], plan[k], plan[k + 1]];
  const out = simplify([...plan.slice(0, k), [p[0] + q[0] - c[0], p[1] + q[1] - c[1]], ...plan.slice(k + 1)]);
  const n = out.length;
  if (n === plan.length || Math.abs(out[0][0] - out[1][0]) > 0.01 || Math.abs(out[n - 1][0] - out[n - 2][0]) > 0.01) return null;
  return out;
}
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `bun test test/wireshape.test.ts`
Expected: PASS (13 tests).

Run: `bun test` and `bun run typecheck`
Expected: 394 pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/edit/wireshape.ts test/wireshape.test.ts
git commit -m "feat(edit): pure hand edits for square wires (runs, bends, bend pairs)"
```

---

### Task 6: The flat jumper tube

**Files:**
- Create: `client/wiretube-math.ts`, `test/wiretube.test.ts`, `client/wiretube.ts`

**Interfaces:**
- Consumes: `Lift`, `Point`, `WIRE_R`, `WIRE_D` (Task 1); `P` from `src/render/geometry.ts`; `TOP`, `WIRE_END_Y`, `Kit` from `client/board3d-parts.ts` (only in `wiretube.ts`).
- Produces (`client/wiretube-math.ts`, pure):
  ```ts
  export type V3 = [number, number, number];
  export const BEND_R = 4, STUB_R = 3, ARC_STEP = Math.PI / 12, STRIP = 7, HUMP = 18;
  export const dist: (a: V3, b: V3) => number;
  export function pathLength(pts: V3[]): number;
  export function centreLine(plan: Point[], lifts: Lift[], base: number, endY: number): V3[];
  export function dropCollinear(pts: V3[]): V3[];
  export function fillet(pts: V3[], radius: (i: number) => number, step?: number): V3[];
  export function trim(pts: V3[], from: number, to: number): V3[];
  export interface TubeData { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array }
  export function tubeData(centre: V3[], radius: number, sides: number, caps?: boolean): TubeData;
  export function mergeTubes(a: TubeData, b: TubeData): TubeData;
  export interface WireShape { jacket: TubeData; tin: TubeData; length: number; line: V3[] }
  export function wireShape(plan: Point[], lifts: Lift[], o: { base: number; endY: number; top: number; radius: number; core: number; sides: number; coreSides: number }): WireShape;
  ```
- Produces (`client/wiretube.ts`, three.js):
  ```ts
  export function tubeGeometry(t: TubeData): THREE.BufferGeometry;
  export interface WireMeshes { jacket: THREE.Mesh; tin: THREE.Mesh; line: V3[]; length: number; base: number }
  export function buildWireMeshes(kit: Kit, plan: Point[], lifts: Lift[], base: number, jacket: THREE.Material, tin: THREE.Material): WireMeshes;  // jacket.userData.rest = jacket material
  export function reshapeWire(kit: Kit, m: WireMeshes, plan: Point[], lifts: Lift[], base: number): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/wiretube.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ARC_STEP, BEND_R, centreLine, dist, dropCollinear, fillet, mergeTubes, pathLength, STRIP, trim, tubeData, wireShape, type TubeData, type V3 } from '../client/wiretube-math.ts';
import { WIRE_D, WIRE_R, type Point } from '../src/render/route3d.ts';

const OPTS = { base: WIRE_R, endY: -4, top: 0, radius: WIRE_R, core: 2.1, sides: 10, coreSides: 8 };
/** A typical jumper: up out of a hole, along a corridor, down into another. */
const Z: Point[] = [[40, 84], [40, 93], [220, 93], [220, 84]];

const vertexCount = (t: TubeData) => t.positions.length / 3;

describe('centreLine', () => {
  test('goes up out of each hole, lies at the base height, and keeps only its corners', () => {
    const line = centreLine(Z, [], WIRE_R, -4);
    expect(line).toEqual([[40, -4, 84], [40, WIRE_R, 84], [40, WIRE_R, 93], [220, WIRE_R, 93], [220, WIRE_R, 84], [220, -4, 84]]);
  });

  test('a lift raises the line by its height over the middle third of two pitches', () => {
    const line = centreLine([[40, 84], [40, 93], [400, 93], [400, 84]], [{ at: 189, height: WIRE_D }], WIRE_R, -4);
    const top = Math.max(...line.map((p) => p[1]));
    expect(top).toBe(WIRE_R + WIRE_D);
    // The crossing is 180 along the run from x = 40; the hump is level within a third of a pitch-and-a-half either side.
    const high = line.filter((p) => p[1] === top).map((p) => p[0]);
    expect(Math.min(...high)).toBeCloseTo(220 - 6, 5);
    expect(Math.max(...high)).toBeCloseTo(220 + 6, 5);
  });
});

describe('dropCollinear', () => {
  test('removes points on a straight line and repeats, keeps the ends and the turns', () => {
    expect(dropCollinear([[0, 0, 0], [1, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 5], [2, 0, 9]])).toEqual([[0, 0, 0], [2, 0, 0], [2, 0, 9]]);
  });
});

describe('fillet', () => {
  test('a square corner with room becomes a quarter circle of the bend radius, one sample per 15 degrees', () => {
    const out = fillet([[0, 0, 0], [50, 0, 0], [50, 0, 50]], () => BEND_R);
    expect(out.length).toBe(2 + Math.ceil(Math.PI / 2 / ARC_STEP) + 1);
    const arc = out.slice(1, -1);
    const centre: V3 = [50 - BEND_R, 0, BEND_R];
    for (const p of arc) expect(dist(p, centre)).toBeCloseTo(BEND_R, 6);
    expect(arc[0]).toEqual([50 - BEND_R, 0, 0]);
    expect(arc[arc.length - 1][0]).toBeCloseTo(50, 9);
    expect(arc[arc.length - 1][2]).toBeCloseTo(BEND_R, 9);
  });

  test('a corner between short runs is clamped to half of each and stays a true arc inside them', () => {
    const out = fillet([[0, 0, 0], [4, 0, 0], [4, 0, 4]], () => 10);
    const arc = out.slice(1, -1);
    // d = min(10, 2, 2) = 2, so r = 2 for a right angle.
    for (const p of arc) expect(dist(p, [2, 0, 2])).toBeCloseTo(2, 6);
    for (const p of arc) expect(p[0] >= -1e-9 && p[0] <= 4 + 1e-9 && p[2] >= -1e-9 && p[2] <= 4 + 1e-9).toBe(true);
  });

  test('the filleted line is never longer than the corner it rounds, and is continuous', () => {
    const raw = centreLine(Z, [], WIRE_R, -4);
    const out = fillet(raw, () => BEND_R);
    expect(pathLength(out)).toBeLessThan(pathLength(raw));
    for (let i = 1; i < out.length; i++) expect(dist(out[i - 1], out[i])).toBeLessThanOrEqual(180 + 1e-9);
  });
});

describe('trim', () => {
  test('cuts a line at two distances along it, interpolating the cut points', () => {
    const t = trim([[0, 0, 0], [10, 0, 0], [10, 0, 10]], 5, 15);
    expect(t).toEqual([[5, 0, 0], [10, 0, 0], [10, 0, 5]]);
    expect(pathLength(t)).toBeCloseTo(10, 9);
  });
});

describe('tubeData', () => {
  test('one ring per sample, every ring joined to the next, faces looking outwards', () => {
    const line = fillet(centreLine(Z, [], WIRE_R, -4), () => BEND_R);
    const t = tubeData(line, WIRE_R, 10);
    expect(vertexCount(t)).toBe(line.length * 11);
    expect(t.indices.length).toBe((line.length - 1) * 10 * 6);
    for (let k = 0; k < t.indices.length; k += 3) {
      const [a, b, c] = [t.indices[k], t.indices[k + 1], t.indices[k + 2]].map((i) => [t.positions[i * 3], t.positions[i * 3 + 1], t.positions[i * 3 + 2]] as V3);
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const face: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const i = t.indices[k];
      const nrm: V3 = [t.normals[i * 3], t.normals[i * 3 + 1], t.normals[i * 3 + 2]];
      expect(face[0] * nrm[0] + face[1] * nrm[1] + face[2] * nrm[2]).toBeGreaterThan(0);
    }
  });

  test('every ring vertex sits one radius from its centre, and the seam faces the board on a flat run', () => {
    const line = fillet(centreLine(Z, [], WIRE_R, -4), () => BEND_R);
    const t = tubeData(line, WIRE_R, 10);
    line.forEach((c, i) => {
      for (let j = 0; j <= 10; j++) {
        const v = (i * 11 + j) * 3;
        expect(dist([t.positions[v], t.positions[v + 1], t.positions[v + 2]], c)).toBeCloseTo(WIRE_R, 4);
      }
    });
    const mid = line.findIndex((p) => p[0] > 100);
    expect(t.normals[mid * 11 * 3 + 1]).toBeCloseTo(-1, 4);
  });

  test('caps close both ends', () => {
    const t = tubeData([[0, 4, 0], [50, 4, 0]], WIRE_R, 10, true);
    expect(vertexCount(t)).toBe(2 * 11 + 2 * 12);
    expect(t.indices.length).toBe(10 * 6 + 2 * 10 * 3);
  });

  test('merging two tubes shifts the second one\'s indices', () => {
    const a = tubeData([[0, 0, 0], [0, 10, 0]], 1, 4);
    const m = mergeTubes(a, a);
    expect(vertexCount(m)).toBe(2 * vertexCount(a));
    expect(m.indices[a.indices.length]).toBe(a.indices[0] + vertexCount(a));
  });
});

describe('wireShape', () => {
  test('a two-bend jumper stays inside the vertex budget', () => {
    const w = wireShape(Z, [], OPTS);
    expect(vertexCount(w.jacket) + vertexCount(w.tin)).toBeLessThanOrEqual(450);
    expect(vertexCount(w.jacket)).toBeLessThanOrEqual(400);
  });

  test('the jacket stops STRIP above the board at each end, the bare ends reach into the holes', () => {
    const w = wireShape(Z, [], OPTS);
    const bare = OPTS.top - OPTS.endY + STRIP;
    const jacketLine = trim(w.line, bare, w.length - bare);
    expect(pathLength(jacketLine)).toBeCloseTo(w.length - 2 * bare, 6);
    const lowest = Math.min(...Array.from({ length: w.tin.positions.length / 3 }, (_, i) => w.tin.positions[i * 3 + 1]));
    expect(lowest).toBeCloseTo(OPTS.endY, 4);
  });
});
```

- [ ] **Step 2: Run them to check they fail**

Run: `bun test test/wiretube.test.ts`
Expected: FAIL: cannot find module `../client/wiretube-math.ts`.

- [ ] **Step 3: Write the pure tube maths**

Create `client/wiretube-math.ts`:

```ts
// The geometry of a flat jumper, as plain numbers: the 3D centre line built
// from a routed plan, a fillet at every corner, and the rings of a tube along
// it. client/wiretube.ts turns the result into three.js BufferGeometry.
//
// Not three's TubeGeometry: it samples its curve evenly by length, so a tight
// fillet between two long runs gets one or two samples and comes out faceted
// or folds through itself. Here a straight run costs two rings and a bend
// gets one ring per 15 degrees of turn, wherever it is.
//
// Pure (no three, no DOM), so it is unit tested.

import type { Lift, Point } from '../src/render/route3d.ts';
import { P } from '../src/render/geometry.ts';

export type V3 = [number, number, number];

/** Bend radius along the board, about one wire diameter as a real jumper is bent. */
export const BEND_R = 4;
/** Bend radius where the wire comes up out of its hole: a little tighter. */
export const STUB_R = 3;
/** One ring per this much turn in a fillet. */
export const ARC_STEP = Math.PI / 12;
/** Bare wire showing above the board at each end, as a stripped jumper has. */
export const STRIP = 7;
/** Half the length of a hump over another wire: about two pitches in all. */
export const HUMP = P;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
};
export const dist = (a: V3, b: V3) => len(sub(a, b));

export function pathLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/**
 * The centre line of a jumper in the scene's axes (x, y up, z = plan y): up
 * out of hole a from `endY`, onto the board at `base`, along the plan with a
 * hump at every lift, and back down into hole b.
 */
export function centreLine(plan: Point[], lifts: Lift[], base: number, endY: number): V3[] {
  // Distance along the plan to each corner.
  const at: number[] = [0];
  for (let i = 1; i < plan.length; i++) at.push(at[i - 1] + Math.abs(plan[i][0] - plan[i - 1][0]) + Math.abs(plan[i][1] - plan[i - 1][1]));
  const total = at[at.length - 1];
  const where = (s: number): Point => {
    let i = 1;
    while (i < at.length - 1 && at[i] < s) i++;
    const k = at[i] > at[i - 1] ? (s - at[i - 1]) / (at[i] - at[i - 1]) : 0;
    return [plan[i - 1][0] + (plan[i][0] - plan[i - 1][0]) * k, plan[i - 1][1] + (plan[i][1] - plan[i - 1][1]) * k];
  };
  // A hump is a trapezoid: up over the outer third, level over the middle.
  const rise = (s: number) => lifts.reduce((h, l) => Math.max(h, l.height * Math.min(1, Math.max(0, (HUMP - Math.abs(s - l.at)) / (HUMP * (2 / 3))))), 0);
  const keys = new Set<number>(at);
  for (const l of lifts) for (const d of [-HUMP, -HUMP / 3, HUMP / 3, HUMP]) keys.add(Math.min(total, Math.max(0, l.at + d)));
  const out: V3[] = [[plan[0][0], endY, plan[0][1]]];
  for (const s of [...keys].sort((p, q) => p - q)) {
    const [x, z] = where(s);
    out.push([x, base + rise(s), z]);
  }
  out.push([plan[plan.length - 1][0], endY, plan[plan.length - 1][1]]);
  return dropCollinear(out);
}

/** Drop repeated points and points that do not turn the line (|u.v| above 0.9999); the ends stay. */
export function dropCollinear(pts: V3[]): V3[] {
  const out: V3[] = [];
  for (const p of pts) {
    if (out.length && dist(out[out.length - 1], p) < 1e-6) continue;
    while (out.length >= 2) {
      const u = norm(sub(out[out.length - 2], out[out.length - 1]));
      const v = norm(sub(p, out[out.length - 1]));
      if (Math.abs(dot(u, v)) > 0.9999) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

/**
 * Round every corner. At corner P between A and B: u = A - P, v = B - P
 * (normalised), theta the angle between them; the arc starts and ends a
 * distance d = min(r / tan(theta/2), |PA|/2, |PB|/2) from P, and r is worked
 * out again from d so a clamped corner is still a true arc. One sample per
 * ARC_STEP of turn.
 */
export function fillet(pts: V3[], radius: (i: number) => number, step = ARC_STEP): V3[] {
  const out: V3[] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i];
    const u = norm(sub(pts[i - 1], p));
    const v = norm(sub(pts[i + 1], p));
    const cos = dot(u, v);
    if (Math.abs(cos) > 0.9999) {
      out.push(p);
      continue;
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
    const d = Math.min(radius(i) / Math.tan(theta / 2), dist(p, pts[i - 1]) / 2, dist(p, pts[i + 1]) / 2);
    const turn = Math.PI - theta;
    const centre = add(p, scale(norm(add(u, v)), d / Math.cos(theta / 2)));
    const a = sub(add(p, scale(u, d)), centre);
    const b = sub(add(p, scale(v, d)), centre);
    const n = Math.max(1, Math.ceil(turn / step - 1e-9));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      out.push(add(centre, scale(add(scale(a, Math.sin((1 - t) * turn)), scale(b, Math.sin(t * turn))), 1 / Math.sin(turn))));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The part of a line between two distances along it. */
export function trim(pts: V3[], from: number, to: number): V3[] {
  const out: V3[] = [];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const l = dist(a, b);
    const lerp = (x: number): V3 => add(a, scale(sub(b, a), l ? (x - s) / l : 0));
    if (s + l >= from && s <= to) {
      if (!out.length) out.push(lerp(Math.max(from, s)));
      if (s + l <= to) out.push(b);
      else {
        out.push(lerp(to));
        break;
      }
    }
    s += l;
  }
  return dropRepeats(out);
}

const dropRepeats = (pts: V3[]) => pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-6);

export interface TubeData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Rotate v about the unit axis k by angle (Rodrigues). */
function rotate(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/**
 * A tube of `sides` round a centre line: one ring per sample, frames carried
 * from ring to ring by parallel transport (the smallest rotation taking one
 * tangent to the next) so the tube never twists, and seeded pointing down on
 * the flattest run so the ring's seam lies against the board. `caps` closes
 * both ends.
 */
export function tubeData(centre: V3[], radius: number, sides: number, caps = false): TubeData {
  const n = centre.length;
  const tangents: V3[] = centre.map((_, i) => norm(sub(centre[Math.min(n - 1, i + 1)], centre[Math.max(0, i - 1)])));
  let seed = 0;
  for (let i = 1; i < n; i++) if (Math.abs(tangents[i][1]) < Math.abs(tangents[seed][1])) seed = i;
  const normals: V3[] = new Array(n);
  const down: V3 = [0, -1, 0];
  normals[seed] = norm(sub(down, scale(tangents[seed], dot(down, tangents[seed]))));
  const carry = (from: number, to: number) => {
    const [t0, t1] = [tangents[from], tangents[to]];
    const axis = cross(t0, t1);
    const sin = len(axis);
    let v = normals[from];
    if (sin > 1e-9) v = rotate(v, scale(axis, 1 / sin), Math.atan2(sin, dot(t0, t1)));
    normals[to] = norm(sub(v, scale(t1, dot(v, t1))));
  };
  for (let i = seed + 1; i < n; i++) carry(i - 1, i);
  for (let i = seed - 1; i >= 0; i--) carry(i + 1, i);

  const ring = sides + 1;
  const count = n * ring + (caps ? 2 * (ring + 1) : 0);
  const positions = new Float32Array(count * 3);
  const norms = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices: number[] = [];
  let s = 0;
  let vi = 0;
  const put = (p: V3, nn: V3, u: number, v: number) => {
    positions.set(p, vi * 3);
    norms.set(nn, vi * 3);
    uvs.set([u, v], vi * 2);
    return vi++;
  };
  for (let i = 0; i < n; i++) {
    if (i) s += dist(centre[i - 1], centre[i]);
    const b = cross(tangents[i], normals[i]);
    for (let j = 0; j <= sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const dir = add(scale(normals[i], Math.cos(a)), scale(b, Math.sin(a)));
      put(add(centre[i], scale(dir, radius)), dir, s / 20, j / sides);
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * ring + j;
      const b = a + ring;
      // Wound so the faces look outwards.
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (caps) {
    for (const [i, facing] of [[0, -1], [n - 1, 1]] as const) {
      const out = scale(tangents[i], facing);
      const mid = put(centre[i], out, 0, 0);
      const first = vi;
      for (let j = 0; j <= sides; j++) put(Array.from(positions.subarray((i * ring + j) * 3, (i * ring + j) * 3 + 3)) as V3, out, 0, 0);
      for (let j = 0; j < sides; j++) indices.push(...(facing > 0 ? [mid, first + j, first + j + 1] : [mid, first + j + 1, first + j]));
    }
  }
  return { positions, normals: norms, uvs, indices: Uint32Array.from(indices) };
}

/** Two tubes as one buffer set, so both bare ends of a wire are one draw. */
export function mergeTubes(a: TubeData, b: TubeData): TubeData {
  const offset = a.positions.length / 3;
  const cat = (x: Float32Array, y: Float32Array) => {
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  indices.set(b.indices.map((i) => i + offset), a.indices.length);
  return { positions: cat(a.positions, b.positions), normals: cat(a.normals, b.normals), uvs: cat(a.uvs, b.uvs), indices };
}

export interface WireShape {
  /** The jacket, stopping STRIP short of the board at each end, capped. */
  jacket: TubeData;
  /** The two bare tinned ends, from inside each hole to just under the jacket. */
  tin: TubeData;
  /** Centre-line length in scene units. */
  length: number;
  /** The filleted centre line, for the selection outline and the card's anchor. */
  line: V3[];
}

/**
 * Everything a jumper's meshes need. `base` is the height of the centre line
 * where it lies on the board (the board top plus the jacket radius), `endY`
 * the depth its tips reach inside the holes, `top` the board top.
 */
export function wireShape(plan: Point[], lifts: Lift[], o: { base: number; endY: number; top: number; radius: number; core: number; sides: number; coreSides: number }): WireShape {
  const raw = centreLine(plan, lifts, o.base, o.endY);
  // The corners where the wire comes out of its holes are the first and last.
  const line = fillet(raw, (i) => (i === 1 || i === raw.length - 2 ? STUB_R : BEND_R));
  const length = pathLength(line);
  const bare = o.top - o.endY + STRIP;
  const jacket = tubeData(trim(line, bare, length - bare), o.radius, o.sides, true);
  // A little under the jacket at each end, so no gap shows between the two.
  const tin = mergeTubes(tubeData(trim(line, 0, bare + 1), o.core, o.coreSides), tubeData(trim(line, length - bare - 1, length), o.core, o.coreSides));
  return { jacket, tin, length, line };
}
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `bun test test/wiretube.test.ts`
Expected: PASS (13 tests). A two-bend jumper's jacket is under 400 vertices.

- [ ] **Step 5: Write the three.js assembly**

Create `client/wiretube.ts` (no unit test: there is no WebGL in Bun; Task 7's e2e scenarios cover it):

```ts
// three.js meshes for a flat jumper, from the numbers wiretube-math.ts works
// out. Kept thin on purpose: everything that can be tested without WebGL
// lives in that module.

import * as THREE from 'three';
import type { Lift, Point } from '../src/render/route3d.ts';
import { WIRE_R } from '../src/render/route3d.ts';
import { TOP, WIRE_END_Y, type Kit } from './board3d-parts.ts';
import { wireShape, type TubeData, type V3 } from './wiretube-math.ts';

/** The tinned core's radius: 22 AWG copper is about 0.64 mm across. */
const CORE_R = 2.1;

export function tubeGeometry(t: TubeData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(t.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export interface WireMeshes {
  jacket: THREE.Mesh;
  tin: THREE.Mesh;
  /** The filleted centre line, for the selection line and the card's anchor. */
  line: V3[];
  length: number;
  /** The centre line's height where it lies flat. */
  base: number;
}

const shapeOf = (plan: Point[], lifts: Lift[], base: number) => wireShape(plan, lifts, { base, endY: WIRE_END_Y, top: TOP, radius: WIRE_R, core: CORE_R, sides: 10, coreSides: 8 });

/** A jumper's jacket and bare ends. `base` is the centre line's height where it lies flat. */
export function buildWireMeshes(kit: Kit, plan: Point[], lifts: Lift[], base: number, jacket: THREE.Material, tin: THREE.Material): WireMeshes {
  const s = shapeOf(plan, lifts, base);
  const m = { jacket: kit.mesh(tubeGeometry(s.jacket), jacket), tin: kit.mesh(tubeGeometry(s.tin), tin), line: s.line, length: s.length, base };
  // What the jacket goes back to after a red drag preview.
  m.jacket.userData.rest = jacket;
  return m;
}

/**
 * Give an existing jumper a new shape in place, for the live preview while a
 * handle is dragged: only this wire's buffers are rebuilt, and the old ones
 * are freed at once. The kit keeps the new ones, so a rebuild frees them too.
 */
export function reshapeWire(kit: Kit, m: WireMeshes, plan: Point[], lifts: Lift[], base: number): void {
  const s = shapeOf(plan, lifts, base);
  m.jacket.geometry.dispose();
  m.tin.geometry.dispose();
  m.jacket.geometry = kit.keep(tubeGeometry(s.jacket));
  m.tin.geometry = kit.keep(tubeGeometry(s.tin));
  m.line = s.line;
  m.length = s.length;
}
```

- [ ] **Step 6: Run everything**

Run: `bun test` and `bun run typecheck`
Expected: 407 pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add client/wiretube-math.ts client/wiretube.ts test/wiretube.test.ts
git commit -m "feat(3d): filleted flat jumper tube with parallel-transport frames"
```

---

### Task 7: Flat wires in the scene, and WebGL context loss

**Files:**
- Modify: `client/board3d.ts`, `client/editor3d/workspace.ts`, `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `routeWires`, `WIRE_R`, `WireRoute`, `Point` (Tasks 1-2); `Handle` (Task 5); `buildWireMeshes`, `reshapeWire`, `WireMeshes`, `V3` (Task 6); `LayoutDoc.routes` (Task 3).
- Produces (`client/board3d.ts`):
  ```ts
  export type Pick = { kind: 'part'; ref: string } | { kind: 'wire'; net: string; index: number } | { kind: 'switch'; key: string } | null;
  // Board3D gains:
  setWireSelected(index: number | null): void;
  setWirePreview(index: number, plan: PlanPoint[] | null, bad?: boolean): void;  // square wires only
  setHandles(list: Handle[], selectedBend?: number | null): void;
  pickHandle(e: { clientX: number; clientY: number }): { kind: 'segment' | 'bend'; index: number } | null;
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  wireAnchor(index: number): { x: number; y: number; visible: boolean } | null;
  // Board3DOptions gains: onContextLost?(): void;
  // mount3d's return adds internals for the e2e hook: _wireTop(), _loseContext(), _handles()
  ```
- Produces (`window.__e3d`, e2e only): `routes()`, `wires()`, `wireScreen(i)`, `wireTop()`, `loseContext()`.

- [ ] **Step 1: Write the failing e2e scenarios**

In `scripts/e2e-3d.ts`:

a. Find:

```ts
const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
```

Replace with:

```ts
/** Square wires and no hand shapes, set on the server and picked up by a fresh page. */
async function squareWires(page: CDP, id: string) {
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post(`/api/projects/${id}/layout/options`, { wireStyle: 'orthogonal' });
  await post(`/api/projects/${id}/layout/wire`, { key: '*', path: null });
  await page.reload();
  await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
```

b. Find:

```ts
    await page.until(`!document.querySelector('.ws-card:not([hidden])')`, 'the card to close');
  },
};
```

Replace with:

```ts
    await page.until(`!document.querySelector('.ws-card:not([hidden])')`, 'the card to close');
  },
  async 'square wires lie flat on the board and match the flat board'(page, id) {
    await squareWires(page, id);
    await open3d(page);
    await page.until(`__e3d.routes() && __e3d.routes().length === __e3d.wires().length`, 'routed square wires');
    // Flat: the centre line sits one radius up, a hump adds one diameter, the jacket one more radius.
    const top = await page.eval<number>(`__e3d.wireTop()`);
    if (!(top > 0 && top <= 4 + 8 + 4 + 0.5)) throw new Error(`the highest jacket reaches y = ${top}; flat wires stay under 16.5`);
    // The page's flat board draws the very same paths.
    const same = await page.eval<boolean>(
      `(() => { const d = [...document.querySelectorAll('#board .wire')].map((g) => g.querySelectorAll('path')[1]?.getAttribute('d')); const want = __e3d.routes().map((p) => p.map(([x, y], k) => (k ? 'L ' : 'M ') + x + ' ' + y).join(' ')); return d.length === want.length && d.every((v, i) => v === want[i]); })()`,
    );
    if (!same) throw new Error('the flat board and the 3D board draw different wire paths');
  },
  async 'losing the WebGL context closes the editor with a toast, and 3D opens again'(page) {
    await open3d(page);
    await page.eval(`__e3d.loseContext()`);
    await page.until(`!document.querySelector('.ws') && !window.__e3d`, 'the editor to close');
    await page.until(`(document.getElementById('toast')?.textContent ?? '').includes('graphics context')`, 'the context-loss toast');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D');
    await open3d(page);
  },
};
```

- [ ] **Step 2: Build and run them to check they fail**

Run: `bun run build && bun scripts/e2e-3d.ts "square wires lie flat on the board and match the flat board" "losing the WebGL context closes the editor with a toast, and 3D opens again"`
Expected: both FAIL (`__e3d.routes is not a function`, `__e3d.loseContext is not a function`).

- [ ] **Step 3: Build flat wires in the scene, pick them by index, and add the wire editor's scene methods**

In `client/board3d.ts`, make these replacements in order (each "find" text occurs exactly once):

a. Find:

```ts
import type { Tint } from '../src/edit/placement.ts';
import { isRail } from '../src/layout/board.ts';
```

Replace with:

```ts
import type { Tint } from '../src/edit/placement.ts';
import type { Handle } from '../src/edit/wireshape.ts';
import { isRail } from '../src/layout/board.ts';
```

b. Find:

```ts
import { wireControls } from '../src/render/routing.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';
```

Replace with:

```ts
import { wireControls } from '../src/render/routing.ts';
import { routeWires, WIRE_R, type Point as PlanPoint, type WireRoute } from '../src/render/route3d.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';
```

c. Find:

```ts
import { flyControls } from './fly.ts';
```

Replace with:

```ts
import { flyControls } from './fly.ts';
import type { V3 } from './wiretube-math.ts';
import { buildWireMeshes, reshapeWire, type WireMeshes } from './wiretube.ts';
```

d. Find:

```ts

export type Pick = { kind: 'part'; ref: string } | { kind: 'wire'; net: string } | { kind: 'switch'; key: string } | null;
```

Replace with:

```ts

export type Pick = { kind: 'part'; ref: string } | { kind: 'wire'; net: string; index: number } | { kind: 'switch'; key: string } | null;
```

e. Find:

```ts
  setOrbit(on: boolean): void;
}
```

Replace with:

```ts
  setOrbit(on: boolean): void;
  /** Mark one jumper as selected with an accent line along its top; null clears it. */
  setWireSelected(index: number | null): void;
  /**
   * Draw a jumper along `plan` while its handle is dragged, red when `bad`;
   * null puts back its routed shape. Only this wire's buffers are rebuilt.
   * Square wires only.
   */
  setWirePreview(index: number, plan: PlanPoint[] | null, bad?: boolean): void;
  /** Draw drag handles (an empty list clears them); `selectedBend` is drawn picked. */
  setHandles(list: Handle[], selectedBend?: number | null): void;
  /** The handle under a pointer event, if any. */
  pickHandle(e: { clientX: number; clientY: number }): { kind: 'segment' | 'bend'; index: number } | null;
  /** Screen position (CSS px, relative to the canvas) of a point in the scene. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  /** Screen position of the middle of a jumper, for the wire card. */
  wireAnchor(index: number): { x: number; y: number; visible: boolean } | null;
}
```

f. Find:

```ts
  wireStyle?: 'arc' | 'orthogonal';
}
```

Replace with:

```ts
  wireStyle?: 'arc' | 'orthogonal';
  /** The browser took the WebGL context away (a GPU reset, too many contexts). The board is dead after this. */
  onContextLost?(): void;
}
```

g. Find:

```ts
  partObj: Map<string, THREE.Object3D>;
  doc: LayoutDoc;
```

Replace with:

```ts
  partObj: Map<string, THREE.Object3D>;
  /** Square wires, in wire order (null for arcs): their meshes, for the drag preview. */
  shapes: (WireMeshes | null)[];
  /** The routes those were built from, so a preview can be put back. */
  routes: WireRoute[];
  /** Every jumper's centre line, in wire order, for the selection line and the wire card. */
  lines: V3[][];
  /** Jackets of wires the router could not route cleanly, one material per net. */
  warnMat: Map<string, THREE.MeshStandardMaterial>;
  doc: LayoutDoc;
```

h. Find:

```ts

export function mount3d(container: HTMLElement, doc: LayoutDoc, opts: Board3DOptions = {}): Board3D & { /** internal, e2e only */ _tintCount(): number } {
  const depth = 350;
```

Replace with:

```ts

export function mount3d(container: HTMLElement, doc: LayoutDoc, opts: Board3DOptions = {}): Board3D & { /** internal, e2e only */ _tintCount(): number; _wireTop(): number; _loseContext(): void; _handles(): { kind: 'segment' | 'bend'; index: number; x: number; y: number }[] } {
  const depth = 350;
```

i. Find:

```ts
    const square = wireStyle === 'orthogonal';
    const plans = square ? wirePolylines(doc.wires, doc.packages, doc.board) : [];
    // Square runs cross each other at right angles, so each wire takes the
    // lowest level none of the wires it crosses is using: a graph colouring,
    // greedy in wire order, which is enough for a breadboard.
    const levels: number[] = new Array(doc.wires.length).fill(0);
    if (square) {
      const segs = plans.map((pts) => pts.slice(0, -1).map((p, k) => [p, pts[k + 1]] as const));
      const crosses = (i: number, j: number) =>
        segs[i].some(([a1, a2]) =>
          segs[j].some(([b1, b2]) => {
            const ah = a1[1] === a2[1];
            const bh = b1[1] === b2[1];
            if (ah === bh) return false;
            const [h1, h2, v1, v2] = ah ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
            const [hx0, hx1] = [Math.min(h1[0], h2[0]), Math.max(h1[0], h2[0])];
            const [vz0, vz1] = [Math.min(v1[1], v2[1]), Math.max(v1[1], v2[1])];
            return v1[0] > hx0 && v1[0] < hx1 && h1[1] > vz0 && h1[1] < vz1;
          }),
        );
      for (let i = 0; i < doc.wires.length; i++) {
        const used = new Set<number>();
        for (let j = 0; j < i; j++) if (crosses(i, j)) used.add(levels[j]);
        while (used.has(levels[i])) levels[i]++;
      }
    }
    for (const [i, w] of doc.wires.entries()) {
```

Replace with:

```ts
    const square = wireStyle === 'orthogonal';
    const routes: WireRoute[] = square ? (doc.routes ?? routeWires(doc).routes) : [];
    const shapes: (WireMeshes | null)[] = [];
    const lines: V3[][] = [];
    // A wire the router could not route cleanly keeps its colour but glows red.
    const warnMat = new Map<string, THREE.MeshStandardMaterial>();
    const warnFor = (net: string) => {
      let m = warnMat.get(net);
      if (!m) {
        m = kit.std({ color: doc.nets[net]?.color ?? '#444', emissive: '#ff2a2a', emissiveIntensity: 0.55, roughness: 0.38, metalness: 0.02 });
        warnMat.set(net, m);
      }
      return m;
    };
    for (const [i, w] of doc.wires.entries()) {
```

j. Find:

```ts
      if (square) {
        // Straight up out of each hole, along the plan at one level, straight
        // down into the other: tinned where it is stripped, jacketed between.
        const plan = plans[i];
        const riseA = endRise(a);
        const riseB = endRise(b);
        let y = Math.max(riseA, riseB, TOP + 10) + levels[i] * 5;
        // Anything the plan passes over has to be cleared too.
        for (const o of obstacles) for (const [px, pz] of plan) if (px >= o.x0 - 2 && px <= o.x1 + 2 && pz >= o.z0 - 2 && pz <= o.z1 + 2) y = Math.max(y, o.top + WIRE_CLEARANCE + levels[i] * 5);
        const objs: THREE.Object3D[] = [];
        const strip = 7;
        const jacket = jacketFor(w.net);
        const add = (m: THREE.Mesh) => {
          root.add(m);
          objs.push(m);
        };
        add(tube(kit, a, a.clone().setY(WIRE_END_Y + strip), 2.1, tinFor(w.net), 8));
        add(tube(kit, b, b.clone().setY(WIRE_END_Y + strip), 2.1, tinFor(w.net), 8));
        const pts: THREE.Vector3[] = [a.clone().setY(WIRE_END_Y + strip), ...plan.map(([px, pz]) => v(px, y, pz)), b.clone().setY(WIRE_END_Y + strip)];
        for (let k = 0; k + 1 < pts.length; k++) {
          const m = tube(kit, pts[k], pts[k + 1], 4, jacket, 10);
          m.userData.net = w.net;
          add(m);
          m.layers.enable(2);
          wirePick.push(m);
          if (k + 2 < pts.length) {
            const corner = kit.mesh(new THREE.SphereGeometry(4, 12, 10), jacket);
            corner.position.copy(pts[k + 1]);
            add(corner);
          }
        }
        wireObjs.push({ net: w.net, objs });
        continue;
      }
      // Putting both cubic controls on the quadratic's own control point keeps
```

Replace with:

```ts
      if (square) {
        // Flat on the board, as a hand-wired board is: up out of each hole,
        // down onto the plastic, along the routed plan with a hump wherever it
        // crosses a wire laid before it, and down into the other hole.
        const r = routes[i];
        let base = TOP + WIRE_R;
        // Only the simple router's fallback can pass over a body: lift it clear.
        if (r.warning) for (const o of obstacles) for (const [px, pz] of r.plan) if (px >= o.x0 - 2 && px <= o.x1 + 2 && pz >= o.z0 - 2 && pz <= o.z1 + 2) base = Math.max(base, o.top + WIRE_CLEARANCE);
        const jacket = r.warning ? warnFor(w.net) : jacketFor(w.net);
        const built = buildWireMeshes(kit, r.plan, r.lifts, base, jacket, tinFor(w.net));
        built.jacket.userData.net = w.net;
        built.jacket.userData.wire = i;
        built.jacket.layers.enable(2);
        root.add(built.jacket, built.tin);
        wirePick.push(built.jacket);
        wireObjs.push({ net: w.net, objs: [built.jacket, built.tin] });
        shapes.push(built);
        lines.push(built.line);
        continue;
      }
      shapes.push(null);
      // Putting both cubic controls on the quadratic's own control point keeps
```

k. Find:

```ts
      mesh.userData.net = w.net;
      root.add(mesh);
```

Replace with:

```ts
      mesh.userData.net = w.net;
      mesh.userData.wire = i;
      lines.push(jacket.getPoints(56).map((p) => [p.x, p.y, p.z] as V3));
      root.add(mesh);
```

l. Find:

```ts

    return { kit, root, ways, displays, leds, pickable, wirePick, wireObjs, netMat, netColour, tinMat, partObj, doc };
  }
```

Replace with:

```ts

    return { kit, root, ways, displays, leds, pickable, wirePick, wireObjs, netMat, netColour, tinMat, partObj, shapes, routes, lines, warnMat, doc };
  }
```

m. Find:

```ts
  /** Nearest hit on one layer, walked up to the object that carries `key`, with how far away it is. */
  const hitOn = (layer: number, key: 'switchKey' | 'ref' | 'net', within: THREE.Object3D[]): { id: string; distance: number } | null => {
    ray.layers.set(layer);
```

Replace with:

```ts
  /** Nearest hit on one layer, walked up to the object that carries `key`, with how far away it is. */
  const hitOn = (layer: number, key: 'switchKey' | 'ref' | 'net', within: THREE.Object3D[]): { id: string; distance: number; obj: THREE.Object3D } | null => {
    ray.layers.set(layer);
```

n. Find:

```ts
      if (hidden) continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (typeof o.userData[key] === 'string') return { id: o.userData[key] as string, distance: hit.distance };
    }
```

Replace with:

```ts
      if (hidden) continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (typeof o.userData[key] === 'string') return { id: o.userData[key] as string, distance: hit.distance, obj: o };
    }
```

o. Find:

```ts
    if (part && (!wire || part.distance <= wire.distance)) return { kind: 'part', ref: part.id };
    return wire ? { kind: 'wire', net: wire.id } : null;
  };
```

Replace with:

```ts
    if (part && (!wire || part.distance <= wire.distance)) return { kind: 'part', ref: part.id };
    return wire ? { kind: 'wire', net: wire.id, index: wire.obj.userData.wire as number } : null;
  };
```

p. Find:

```ts
      if (tin) fade(tin, faded);
    }
  };
  const setHoveredNet = (net: string | null) => {
```

Replace with:

```ts
      if (tin) fade(tin, faded);
    }
    for (const [id, m] of c.warnMat) fade(m, !!net && id !== net);
  };
  const setHoveredNet = (net: string | null) => {
```

q. Find:

```ts
  const tmp = new THREE.Vector3();
  const anchor = (ref: string) => {
```

Replace with:

```ts
  const tmp = new THREE.Vector3();
  const project = (x: number, y: number, z: number) => {
    tmp.set(x, y, z).project(camera);
    const rect = dom.getBoundingClientRect();
    return { x: ((tmp.x + 1) / 2) * rect.width, y: ((1 - tmp.y) / 2) * rect.height, visible: tmp.z < 1 };
  };
  const anchor = (ref: string) => {
```

r. Find:

```ts
    box.setFromObject(obj);
    tmp.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(camera);
    const rect = dom.getBoundingClientRect();
    return { x: ((tmp.x + 1) / 2) * rect.width, y: ((1 - tmp.y) / 2) * rect.height, visible: tmp.z < 1 };
  };
```

Replace with:

```ts
    box.setFromObject(obj);
    return project((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  };
  /** Halfway along a jumper, measured along it. */
  const wireAnchor = (index: number) => {
    const line = c.lines[index];
    if (!line || line.length < 2) return null;
    const lens = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1], p[2] - line[i][2]));
    let left = lens.reduce((s, l) => s + l, 0) / 2;
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i] || i === lens.length - 1) {
        const k = lens[i] ? Math.min(1, left / lens[i]) : 0;
        const [p, q] = [line[i], line[i + 1]];
        return project(p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k + WIRE_R, p[2] + (q[2] - p[2]) * k);
      }
      left -= lens[i];
    }
    return null;
  };

  // ---------- a selected jumper ----------
  // An accent line along the top of the wire, drawn over everything. A tube
  // is smooth all round, so an EdgesGeometry outline would find nothing.
  const wireLineMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.95 });
  let wireLine: THREE.Line | null = null;
  let selectedWire: number | null = null;
  const setWireSelected = (index: number | null) => {
    selectedWire = index;
    if (wireLine) {
      scene.remove(wireLine);
      wireLine.geometry.dispose();
      wireLine = null;
    }
    const line = index === null ? undefined : c.lines[index];
    if (!line) return;
    wireLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line.map(([x, y, z]) => new THREE.Vector3(x, y + WIRE_R + 0.6, z))), wireLineMat);
    wireLine.renderOrder = 10;
    wireLine.raycast = () => {};
    scene.add(wireLine);
  };

  const badMat = new THREE.MeshStandardMaterial({ color: '#ef4444', emissive: '#7f1d1d', roughness: 0.4 });
  const setWirePreview = (index: number, plan: PlanPoint[] | null, bad = false) => {
    const shape = c.shapes[index];
    const route = c.routes[index];
    if (!shape || !route) return;
    // While dragging, the wire lies flat: humps come back with the real route.
    reshapeWire(c.kit, shape, plan ?? route.plan, plan ? [] : route.lifts, shape.base);
    shape.jacket.material = plan && bad ? badMat : (shape.jacket.userData.rest as THREE.Material);
    c.lines[index] = shape.line;
    if (selectedWire === index) setWireSelected(index);
  };

  // ---------- handles ----------
  // Discs floating just above the wires, on their own pick layer, drawn over
  // everything so a handle under a part can still be found.
  const HANDLE_LAYER = 4;
  const HANDLE_Y = TOP + 2 * WIRE_R + 1.5;
  const handleGeo = { segment: new THREE.CircleGeometry(5, 20).rotateX(-Math.PI / 2), bend: new THREE.CircleGeometry(3.6, 16).rotateX(-Math.PI / 2) };
  const handleMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const handlePicked = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, side: THREE.DoubleSide });
  const handleGroup = new THREE.Group();
  scene.add(handleGroup);
  const setHandles = (list: Handle[], selectedBend: number | null = null) => {
    handleGroup.clear();
    for (const h of list) {
      const m = new THREE.Mesh(handleGeo[h.kind], h.kind === 'bend' && h.index === selectedBend ? handlePicked : handleMat);
      m.position.set(h.at[0], HANDLE_Y, h.at[1]);
      m.renderOrder = 12;
      m.userData.handle = `${h.kind}:${h.index}`;
      m.layers.enable(HANDLE_LAYER);
      handleGroup.add(m);
    }
    // Picked before the next frame is drawn (a click right after a save), so
    // the world matrices cannot wait for the render to bring them up to date.
    handleGroup.updateMatrixWorld(true);
  };
  const pickHandle = (e: { clientX: number; clientY: number }) => {
    toNdc(e);
    ray.layers.set(HANDLE_LAYER);
    const hit = ray.intersectObjects(handleGroup.children, false)[0];
    if (!hit) return null;
    const [kind, index] = (hit.object.userData.handle as string).split(':');
    return { kind: kind as 'segment' | 'bend', index: Number(index) };
  };
```

s. Find:

```ts
  const onLeave = () => setHoveredNet(null);
  dom.addEventListener('pointerdown', onDown);
```

Replace with:

```ts
  const onLeave = () => setHoveredNet(null);
  // Losing the context loses every buffer: nothing here can be drawn again,
  // so the owner is told and takes the board down.
  const onLost = () => opts.onContextLost?.();
  dom.addEventListener('webglcontextlost', onLost);
  dom.addEventListener('pointerdown', onDown);
```

t. Find:

```ts
    if (hov && c.partObj.has(hov)) setHovered(hov);
    // The held highlight hides wires by visibility, which the new wires do not
```

Replace with:

```ts
    if (hov && c.partObj.has(hov)) setHovered(hov);
    // The selection line follows the wire onto its new shape. Handles are the
    // wire editor's; it has already placed them for the new doc.
    setWireSelected(selectedWire !== null && selectedWire < c.lines.length ? selectedWire : null);
    // The held highlight hides wires by visibility, which the new wires do not
```

u. Find:

```ts
    setOrbit,
    // Internal, for the e2e hook: how many strip tints are showing.
    _tintCount: () => tintMesh.count,
    dispose() {
```

Replace with:

```ts
    setOrbit,
    setWireSelected,
    setWirePreview,
    setHandles,
    pickHandle,
    project,
    wireAnchor,
    // Internal, for the e2e hook: how many strip tints are showing.
    _tintCount: () => tintMesh.count,
    // Internal, for the e2e hook: the highest point of any square jumper's jacket.
    _wireTop: () =>
      c.shapes.reduce((top, s) => {
        if (!s) return top;
        s.jacket.geometry.computeBoundingBox();
        return Math.max(top, s.jacket.geometry.boundingBox!.max.y);
      }, -Infinity),
    // Internal, for the e2e hook: what a GPU reset does.
    _loseContext: () => renderer.forceContextLoss(),
    // Internal, for the e2e hook: the handles on screen (CSS px, page coordinates).
    _handles: () => {
      const rect = dom.getBoundingClientRect();
      return handleGroup.children.map((m) => {
        const [kind, index] = (m.userData.handle as string).split(':');
        const at = project(m.position.x, m.position.y, m.position.z);
        return { kind: kind as 'segment' | 'bend', index: Number(index), x: rect.left + at.x, y: rect.top + at.y };
      });
    },
    dispose() {
```

v. Find:

```ts
      observer.disconnect();
      dom.removeEventListener('pointerdown', onDown);
```

Replace with:

```ts
      observer.disconnect();
      dom.removeEventListener('webglcontextlost', onLost);
      dom.removeEventListener('pointerdown', onDown);
```

w. Find:

```ts
      lineMat.hov.dispose();
      tintGeo.dispose();
```

Replace with:

```ts
      lineMat.hov.dispose();
      setWireSelected(null);
      wireLineMat.dispose();
      badMat.dispose();
      handleGroup.clear();
      handleGeo.segment.dispose();
      handleGeo.bend.dispose();
      handleMat.dispose();
      handlePicked.dispose();
      tintGeo.dispose();
```

- [ ] **Step 4: Close on context loss, and expose the wires to the e2e hook**

In `client/editor3d/workspace.ts`:

a. Find:

```ts
import { attachManipulation, commitMove } from './manipulate.ts';
```

Replace with:

```ts
import { attachManipulation, commitMove } from './manipulate.ts';
import { wireKey } from '../../src/render/route3d.ts';
```

b. Find:

```ts
      onMode(mode) {
        hintEl.textContent = mode === 'fly' ? FLY_HINT : ORBIT_HINT;
      },
    });
```

Replace with:

```ts
      onMode(mode) {
        hintEl.textContent = mode === 'fly' ? FLY_HINT : ORBIT_HINT;
      },
      onContextLost() {
        // Every buffer went with the context, so the board cannot be drawn
        // again. Close the way Back does; pressing 3D mounts a fresh one.
        if (closed) return;
        toast('The 3D view lost its graphics context and was closed. Press 3D to open it again.');
        history.back();
      },
    });
```

c. Find:

```ts
        move: (ref: string, holes: Parameters<typeof commitMove>[1]) => commitMove(ref, holes),
      };
```

Replace with:

```ts
        move: (ref: string, holes: Parameters<typeof commitMove>[1]) => commitMove(ref, holes),
        // Wires (phase 2).
        routes: () => store.get().project?.doc.routes?.map((r) => r.plan) ?? null,
        wires: () => store.get().project?.doc.wires.map(wireKey) ?? [],
        wireScreen(i: number) {
          const a = board.wireAnchor(i);
          const r = canvasHost.getBoundingClientRect();
          return a ? { x: r.left + a.x, y: r.top + a.y } : null;
        },
        wireTop: () => (board as unknown as { _wireTop(): number })._wireTop(),
        loseContext: () => (board as unknown as { _loseContext(): void })._loseContext(),
      };
```

- [ ] **Step 5: Typecheck and run the unit tests**

Run: `bun run typecheck` and `bun test`
Expected: typecheck clean; 407 pass.

- [ ] **Step 6: Build and run the two scenarios to check they pass**

Run: `bun run build && bun scripts/e2e-3d.ts "square wires lie flat on the board and match the flat board" "losing the WebGL context closes the editor with a toast, and 3D opens again"`
Expected: `ok` for both.

- [ ] **Step 7: Run the whole e2e suite**

Run: `bun scripts/e2e-3d.ts`
Expected: 19 `ok`, no `FAIL`.

- [ ] **Step 8: Commit**

```bash
git add client/board3d.ts client/editor3d/workspace.ts scripts/e2e-3d.ts
git commit -m "feat(3d): flat routed jumpers with humps; close the editor on WebGL context loss"
```

---

### Task 8: Editing wires in 3D

**Files:**
- Create: `client/editor3d/wireEdit.ts`
- Modify: `client/editor3d/workspace.ts`, `client/styles.css`, `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `handles`, `moveSegment`, `moveBend`, `nearestRun`, `addBendPair`, `removeBend`, `snapAcross`, `Handle` (Task 5); `checkPlan`, `planLength`, `planToPath`, `wireKey` (Task 1); `api.wirePath`, `api.color` (Task 4); the Board3D methods of Task 7; `history`, `Command` from `client/editor3d/history.ts`; `addKeyHandler`, `Workspace` from `workspace.ts`.
- Produces (`client/editor3d/wireEdit.ts`):
  ```ts
  export const WIRE_COLOURS: string[];   // 1 red, 2 black, 3 blue, 4 green, 5 orange, 6 yellow, 7 white, 8 violet, 9 grey
  export async function commitWirePath(key: string, path: WirePath | null): Promise<boolean>;
  export function wirePathCommand(key: string, before: WirePath | null, after: WirePath | null, label: string): Command;
  export interface WireEdit { detach(): void; selected(): string | null; select(key: string | null): void }
  export function attachWireEdit(ws: Workspace): WireEdit;
  ```
- Produces (`window.__e3d`, e2e only): `selectedWire()`, `selectWire(key)`, `handles()`, `wirePath(key)`, `netColor(net)`.

- [ ] **Step 1: Write the failing e2e scenarios**

In `scripts/e2e-3d.ts`:

a. Find:

```ts
const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
```

Replace with:

```ts
/**
 * A jumper whose middle picks as itself (a part can stand in front of it).
 * With `run`, only one with a run across the board longer than two pitches,
 * which has a segment handle to drag up and down the screen; `seg` is that run.
 */
async function pickableWire(page: CDP, run = false) {
  const hit = await page.eval<{ key: string; index: number; net: string; x: number; y: number; seg: number } | null>(
    `(() => { const plans = __e3d.routes(); const keys = __e3d.wires(); for (let i = 0; i < keys.length; i++) { const p = plans?.[i]; const seg = p ? p.findIndex((q, k) => k + 1 < p.length && q[1] === p[k + 1][1] && Math.abs(q[0] - p[k + 1][0]) > 36) : -1; if (${run} && seg < 0) continue; const at = __e3d.wireScreen(i); const hit = at && __e3d.pickAt(at.x, at.y); if (hit && hit.kind === 'wire' && hit.index === i) return { key: keys[i], index: i, net: hit.net, x: at.x, y: at.y, seg }; } return null; })()`,
  );
  if (!hit) throw new Error('no jumper could be picked at its middle');
  return hit;
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
```

b. Find:

```ts
    await open3d(page);
  },
};
```

Replace with:

```ts
    await open3d(page);
  },
  async 'clicking a jumper selects it and opens the wire card'(page, id) {
    await squareWires(page, id);
    await open3d(page);
    const hit = await pickableWire(page);
    await page.mouse('mousePressed', hit.x, hit.y);
    await page.mouse('mouseReleased', hit.x, hit.y);
    await page.until(`__e3d.selectedWire() === ${JSON.stringify(hit.key)}`, `the jumper ${hit.key} to be selected`);
    await page.until(`document.querySelector('.ws-wirecard:not([hidden])')?.dataset.wire === ${JSON.stringify(hit.key)}`, 'the wire card');
    await page.until(`__e3d.handles().length > 0`, 'the handles');
    await page.key('Escape', 'Escape');
    await page.until(`__e3d.selectedWire() === null && document.querySelector('.ws-wirecard').hidden`, 'Esc to drop the wire');
    if (!(await page.eval<boolean>(`!!document.querySelector('.ws')`))) throw new Error('Esc with a wire selected closed the editor');
  },
  async 'dragging a segment handle reshapes a wire, undo puts it back, and the shape survives a reload'(page, id) {
    await squareWires(page, id);
    await open3d(page);
    const hit = await pickableWire(page, true);
    await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
    await page.until(`__e3d.handles().some((h) => h.kind === 'segment' && h.index === ${hit.seg})`, 'the segment handle');
    const before = await page.eval<string>(`JSON.stringify(__e3d.routes()[${hit.index}])`);
    let shaped = false;
    // Up or down the screen moves a run that lies across the board; some lanes may be refused.
    for (const dy of [70, -70, 110, -110]) {
      const h = await page.eval<{ x: number; y: number }>(`__e3d.handles().find((h) => h.kind === 'segment' && h.index === ${hit.seg})`);
      await page.mouse('mousePressed', h.x, h.y);
      for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', h.x, h.y + (dy * k) / 6);
      await page.mouse('mouseReleased', h.x, h.y + dy);
      if (await settles(page, `__e3d.wirePath(${JSON.stringify(hit.key)}) !== null`, 3000)) {
        shaped = true;
        break;
      }
    }
    if (!shaped) throw new Error('no drag of the segment handle kept a shape');
    const after = await page.eval<string>(`JSON.stringify(__e3d.routes()[${hit.index}])`);
    if (after === before) throw new Error('the shape was saved but the wire did not change');
    await page.until(`!document.querySelector('[data-ws=undo]').disabled`, 'Undo to enable');
    await page.key('z', 'KeyZ', 2 /* ctrl */);
    await page.until(`__e3d.wirePath(${JSON.stringify(hit.key)}) === null && JSON.stringify(__e3d.routes()[${hit.index}]) === ${JSON.stringify(before)}`, 'undo to restore the routed shape');
    await page.key('Z', 'KeyZ', 2 | 8 /* ctrl+shift */);
    await page.until(`JSON.stringify(__e3d.routes()[${hit.index}]) === ${JSON.stringify(after)}`, 'redo to shape it again');
    await page.reload();
    await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page after reload');
    await open3d(page);
    await page.until(`JSON.stringify(__e3d.routes()?.[${hit.index}]) === ${JSON.stringify(after)}`, 'the hand shape to survive a reload');
  },
  async 'double-click adds a bend pair and Delete on a picked bend takes it out'(page, id) {
    await squareWires(page, id);
    await open3d(page);
    const hit = await pickableWire(page, true);
    await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
    await page.until(`__e3d.handles().length > 0`, 'the handles');
    const start = await page.eval<number>(`__e3d.routes()[${hit.index}].length - 2`);
    // Double-click the wire itself, halfway along it.
    const at = await page.eval<{ x: number; y: number }>(`__e3d.wireScreen(${hit.index})`);
    await page.mouse('mousePressed', at.x, at.y);
    await page.mouse('mouseReleased', at.x, at.y);
    await page.mouse('mousePressed', at.x, at.y, 2);
    await page.mouse('mouseReleased', at.x, at.y, 2);
    await page.until(`__e3d.routes()[${hit.index}].length - 2 === ${start + 2}`, 'a bend pair to be added', 6000);
    // Pick one of the new corners (not one under the wire card, which floats over the canvas) and press Delete.
    const corner = await page.eval<{ x: number; y: number } | null>(
      `(() => { const plan = __e3d.routes()[${hit.index}]; const hs = __e3d.handles().filter((h) => h.kind === 'bend'); return hs.find((h) => h.index > 1 && h.index < plan.length - 2 && document.elementFromPoint(h.x, h.y)?.tagName === 'CANVAS') ?? null; })()`,
    );
    if (!corner) throw new Error('no inner bend handle to pick');
    await page.mouse('mousePressed', corner.x, corner.y);
    await page.mouse('mouseReleased', corner.x, corner.y);
    await sleep(300);
    await page.key('Delete', 'Delete');
    await page.until(`__e3d.routes()[${hit.index}].length - 2 === ${start}`, 'Delete to take the pair out', 6000);
  },
  async "digit keys recolour the selected wire's net"(page, id) {
    await squareWires(page, id);
    await open3d(page);
    const hit = await pickableWire(page);
    await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
    await page.until(`__e3d.selectedWire() === ${JSON.stringify(hit.key)}`, 'the wire to be selected');
    await page.key('4', 'Digit4');
    await page.until(`__e3d.netColor(${JSON.stringify(hit.net)})?.toLowerCase() === '#2e9e4f'`, 'the net to turn green');
    await fetch(`${base}/api/projects/${id}/layout/colors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ net: hit.net, color: null }) });
  },
};
```

- [ ] **Step 2: Build and run them to check they fail**

Run: `bun run build && bun scripts/e2e-3d.ts "clicking a jumper selects it and opens the wire card" "dragging a segment handle reshapes a wire, undo puts it back, and the shape survives a reload" "double-click adds a bend pair and Delete on a picked bend takes it out" "digit keys recolour the selected wire's net"`
Expected: all four FAIL (`__e3d.selectedWire is not a function` and similar).

- [ ] **Step 3: Write the wire editor**

Create `client/editor3d/wireEdit.ts`:

```ts
// Jumpers in the 3D editor. Click one to select it: its net is followed
// softly, an accent line runs along it, and the wire card opens with its net,
// length and colour. With square wires it also grows handles:
//
// - drag a segment handle to slide that run sideways (snapped to a corridor
//   lane, never onto a row or column of holes; a run out of a hole jogs);
// - drag a bend handle to move the corner;
// - double-click the wire to put a small Z in it, double-click a bend (or
//   click it and press Delete) to take it out.
//
// A shape that would cross a chip goes red and is refused on release. A kept
// shape is saved through layout/wire as one undoable command, and every other
// wire is re-routed round it by the server. Digit keys 1-9 recolour the
// selected wire's net: colour belongs to the net, as it always has.

import { addBendPair, handles as handlesOf, moveBend, moveSegment, nearestRun, removeBend, snapAcross, type Handle } from '../../src/edit/wireshape.ts';
import { holeKey } from '../../src/layout/board.ts';
import { COLOR_GND, COLOR_PLUS, PALETTE } from '../../src/layout/engine.ts';
import type { WirePath } from '../../src/layout/types.ts';
import { P } from '../../src/render/geometry.ts';
import { checkPlan, planLength, planToPath, wireKey, type Point } from '../../src/render/route3d.ts';
import { api } from '../api.ts';
import { esc, toast } from '../main.ts';
import { store } from '../state.ts';
import { history, type Command } from './history.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** The kit's colours, for keys 1 to 9: red, black, then the signal colours, then two spares. */
export const WIRE_COLOURS = [COLOR_PLUS, COLOR_GND, ...PALETTE, '#8E44AD', '#8A8D91'];
const MM = P / 2.54;
/** Movement under this, in CSS px, is a click rather than a drag. */
const CLICK_PX = 4;

/**
 * Save one wire's hand shape (null forgets it; key "*" with null forgets
 * them all) and take the server's doc. False, with a toast, when refused.
 */
export async function commitWirePath(key: string, path: WirePath | null): Promise<boolean> {
  const p = store.get().project;
  if (!p) return false;
  try {
    const doc = await api.wirePath(p.id, key, path);
    const q = store.get().project;
    if (!q || q.id !== p.id) return false;
    const wirePaths = key === '*' ? {} : { ...q.sidecar.wirePaths };
    if (key !== '*') {
      if (path) wirePaths[key] = path;
      else delete wirePaths[key];
    }
    store.setProject({ doc, sidecar: { ...q.sidecar, wirePaths } });
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  }
}

/** A wire reshape as an undoable command: the saved shape before and after (null: routed). */
export function wirePathCommand(key: string, before: WirePath | null, after: WirePath | null, label: string): Command {
  return { label, run: () => commitWirePath(key, after), undo: () => commitWirePath(key, before) };
}

/** Forget every hand shape; undo puts each one back. */
function tidyCommand(before: Record<string, WirePath>): Command {
  return {
    label: 'tidy all wires',
    run: () => commitWirePath('*', null),
    async undo() {
      for (const [key, path] of Object.entries(before)) if (!(await commitWirePath(key, path))) return false;
      return true;
    },
  };
}

export interface WireEdit {
  detach(): void;
  /** The selected wire's key, or null. For the e2e hook. */
  selected(): string | null;
  select(key: string | null): void;
}

export function attachWireEdit(ws: Workspace): WireEdit {
  const { board } = ws;
  const dom = board.dom;
  let selected: string | null = null;
  /** The bend picked by a click on its handle, for Delete. */
  let bend: number | null = null;
  let press: { x: number; y: number; t: number } | null = null;
  let drag: { key: string; index: number; pointerId: number; handle: Handle; origin: Point[]; x: number; y: number; moved: boolean; plan: Point[] | null; bad: string | null } | null = null;

  const current = () => {
    const p = store.get().project;
    if (!p || !selected) return null;
    const index = p.doc.wires.findIndex((w) => wireKey(w) === selected);
    if (index < 0) return null;
    return { p, index, wire: p.doc.wires[index], route: p.doc.routes?.[index] ?? null, square: p.sidecar.options.wireStyle === 'orthogonal' };
  };

  const card = document.createElement('div');
  card.className = 'ws-card ws-wirecard';
  card.hidden = true;
  ws.canvasHost.appendChild(card);
  let cardFor = '';
  /** Bumped with every new doc, so the card is rebuilt only when something it shows can have changed. */
  let docSeq = 0;
  let lastDoc = store.get().project?.doc;
  let handlesFor = '';
  let placed = '';

  const renderCard = (c: NonNullable<ReturnType<typeof current>>) => {
    const key = `${selected}|${docSeq}|${c.square}`;
    if (key === cardFor && !card.hidden) return;
    cardFor = key;
    const colour = (c.p.doc.nets[c.wire.net]?.color ?? '').toLowerCase();
    const saved = !!c.p.sidecar.wirePaths[selected!];
    const shaped = Object.keys(c.p.sidecar.wirePaths).length > 0;
    const about = c.route ? `${Math.round(planLength(c.route.plan) / MM)} mm along the board` : 'curved jumper';
    card.hidden = false;
    card.dataset.wire = selected!;
    card.innerHTML =
      `<header><b>${esc(c.p.doc.nets[c.wire.net]?.name ?? c.wire.net)}</b><span>${esc(holeKey(c.wire.a))} to ${esc(holeKey(c.wire.b))}</span><button type="button" class="ws-card-x" data-wire="close" title="Deselect (Esc)">×</button></header>` +
      `<p class="ws-card-note">${about}${saved ? ' · shaped by hand' : ''}${c.route?.warning ? ` · ${esc(c.route.warning)}` : ''}</p>` +
      `<div class="ws-swatches">${WIRE_COLOURS.map((col, i) => `<button type="button" data-colour="${col}" title="${i + 1}" style="background:${col}"${col.toLowerCase() === colour ? ' class="is-on"' : ''}></button>`).join('')}</div>` +
      `<footer>${c.square && saved ? '<button type="button" data-wire="reroute" title="Forget this wire\'s hand shape">Re-route</button>' : ''}${c.square && shaped ? '<button type="button" data-wire="tidy" title="Forget every hand shape">Tidy all wires</button>' : ''}</footer>` +
      `<p class="ws-card-hint">${c.square ? 'drag a handle to reshape · double-click to add or remove a bend · 1-9 colour' : 'switch Wires to square to reshape · 1-9 colour'}</p>`;
    placed = '';
  };

  const paint = () => {
    const c = current();
    if (!c) {
      selected = null;
      bend = null;
      board.setWireSelected(null);
      if (handlesFor) board.setHandles([]);
      handlesFor = '';
      card.hidden = true;
      delete card.dataset.wire;
      return;
    }
    board.setWireSelected(c.index);
    const list = c.square && c.route && !drag ? handlesOf(c.route.plan) : [];
    const key = `${JSON.stringify(list)}|${bend}`;
    if (key !== handlesFor) {
      handlesFor = key;
      board.setHandles(list, bend);
    }
    renderCard(c);
  };

  const select = (key: string | null) => {
    selected = key;
    bend = null;
    if (key && store.get().project?.selectedRef) store.setProject({ selectedRef: null });
    paint();
  };

  const place = () => {
    const c = card.hidden ? null : current();
    if (!c) return;
    const a = board.wireAnchor(c.index);
    if (!a) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const host = ws.canvasHost.getBoundingClientRect();
    const pad = 12;
    let x = a.x - w / 2;
    let y = a.y - h - 22;
    if (y < pad) y = a.y + 28;
    x = Math.min(Math.max(pad, x), host.width - w - pad);
    y = Math.min(Math.max(pad, y), host.height - h - pad);
    const key = `${Math.round(x)},${Math.round(y)},${a.visible}`;
    if (key === placed) return;
    placed = key;
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    card.style.visibility = a.visible ? 'visible' : 'hidden';
  };

  const save = async (key: string, index: number, plan: Point[], label: string) => {
    const p = store.get().project;
    if (!p) return;
    const path = planToPath(p.doc.wires[index], plan);
    if (!path) {
      board.setWirePreview(index, null);
      toast('This wire is off the lane grid (the simple router drew it); Re-route it first');
      return;
    }
    const before = p.sidecar.wirePaths[key] ?? null;
    const ok = await history.execute(wirePathCommand(key, before, path, `${label} the ${p.doc.wires[index].net} jumper`));
    // A kept shape rebuilds the board from the new doc; a refusal needs the routed shape back.
    if (!ok && store.get().project?.doc === p.doc) board.setWirePreview(index, null);
  };

  const recolour = (colour: string) => {
    const c = current();
    if (!c) return;
    const { id } = c.p;
    const net = c.wire.net;
    api
      .color(id, net, colour)
      .then((doc) => {
        const q = store.get().project;
        if (q?.id === id) store.setProject({ doc, sidecar: { ...q.sidecar, colors: { ...q.sidecar.colors, [net]: colour } } });
      })
      .catch((err: Error) => toast(err.message));
  };

  const straighten = (k: number) => {
    const c = current();
    if (!c?.route) return;
    const out = removeBend(c.route.plan, k);
    if (!out) return void toast("That bend holds the wire's end on its column");
    bend = null;
    void save(selected!, c.index, out, 'straighten');
  };

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    board.setOrbit(true);
    if (dom.hasPointerCapture(d.pointerId)) dom.releasePointerCapture(d.pointerId);
    ws.hint('');
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || board.flying || drag) return;
    press = { x: e.clientX, y: e.clientY, t: performance.now() };
    const c = current();
    if (!c?.square || !c.route) return;
    const h = board.pickHandle(e);
    const handle = h && handlesOf(c.route.plan).find((k) => k.kind === h.kind && k.index === h.index);
    if (!handle) return;
    // A press on a handle is the editor's, decided before OrbitControls sees it.
    board.setOrbit(false);
    e.stopImmediatePropagation();
    dom.setPointerCapture(e.pointerId);
    drag = { key: selected!, index: c.index, pointerId: e.pointerId, handle, origin: c.route.plan, x: e.clientX, y: e.clientY, moved: false, plan: null, bad: null };
  };

  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = store.get().project;
    const at = board.boardPoint(e);
    if (!p || !at) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < CLICK_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      board.setHandles([]);
      handlesFor = '';
    }
    const { handle, origin } = drag;
    const next = handle.kind === 'segment' ? moveSegment(origin, handle.index, snapAcross(handle.horizontal, handle.horizontal ? at[1] : at[0])) : moveBend(origin, handle.index, [snapAcross(false, at[0]), snapAcross(true, at[1])]);
    if (drag.plan && JSON.stringify(drag.plan) === JSON.stringify(next)) return;
    drag.plan = next;
    drag.bad = checkPlan(next, p.doc.packages, p.doc.board);
    board.setWirePreview(drag.index, next, !!drag.bad);
    ws.hint(drag.bad ? `can't shape it like that: ${drag.bad}` : 'release to keep this shape');
  };

  const onUp = (e: PointerEvent) => {
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      const d = drag;
      endDrag();
      press = null;
      if (!d.moved) {
        // A click on a bend picks it, for Delete.
        if (d.handle.kind === 'bend') bend = bend === d.handle.index ? null : d.handle.index;
        return paint();
      }
      const changed = !!d.plan && JSON.stringify(d.plan) !== JSON.stringify(d.origin);
      if (!changed || d.bad) {
        board.setWirePreview(d.index, null);
        if (d.bad) toast(`Not reshaped: ${d.bad}`);
        return paint();
      }
      void save(d.key, d.index, d.plan!, 'reshape');
      return;
    }
    const start = press;
    press = null;
    if (!start || e.button !== 0 || board.flying) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX || performance.now() - start.t > 600) return;
    const hit = board.pick(e);
    const p = store.get().project;
    if (hit?.kind === 'wire' && p?.doc.wires[hit.index]) select(wireKey(p.doc.wires[hit.index]));
    else if (hit?.kind !== 'switch' && selected) select(null);
  };

  const onDbl = (e: MouseEvent) => {
    const c = current();
    if (!c?.square || !c.route || board.flying) return;
    const h = board.pickHandle(e);
    if (h?.kind === 'bend') return straighten(h.index);
    const hit = board.pick(e);
    const at = board.boardPoint(e);
    if (hit?.kind !== 'wire' || hit.index !== c.index || !at) return;
    const out = addBendPair(c.route.plan, nearestRun(c.route.plan, at), at);
    if (out === c.route.plan) return void toast('That run is too short to bend');
    const why = checkPlan(out, c.p.doc.packages, c.p.doc.board);
    if (why) return void toast(`Can't bend it there: ${why}`);
    void save(selected!, c.index, out, 'bend');
  };

  // The browser took the pointer away: neither a click nor a drop.
  const onCancel = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    endDrag();
    board.setWirePreview(d.index, null);
    paint();
  };

  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const colour = t.closest<HTMLElement>('[data-colour]')?.dataset.colour;
    if (colour) return recolour(colour);
    const what = t.closest<HTMLElement>('[data-wire]')?.dataset.wire;
    const c = current();
    if (!what || !c) return;
    if (what === 'close') select(null);
    if (what === 'reroute') void history.execute(wirePathCommand(selected!, c.p.sidecar.wirePaths[selected!] ?? null, null, `re-route the ${c.wire.net} jumper`));
    if (what === 'tidy') void history.execute(tidyCommand({ ...c.p.sidecar.wirePaths }));
  });

  const offKey = addKeyHandler((e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (drag) {
      if (e.key !== 'Escape') return e.key === 'f' || e.key === 'F';
      const d = drag;
      endDrag();
      board.setWirePreview(d.index, null);
      paint();
      return true;
    }
    if (!selected) return false;
    if (/^[1-9]$/.test(e.key)) {
      if (!e.repeat) recolour(WIRE_COLOURS[Number(e.key) - 1]);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && bend !== null) {
      straighten(bend);
      return true;
    }
    if (e.key === 'Escape') {
      if (bend !== null) {
        bend = null;
        paint();
      } else select(null);
      return true;
    }
    return false;
  });

  let lastRef = store.get().project?.selectedRef ?? null;
  const offStore = store.subscribe((s) => {
    const q = s.project;
    if (q?.doc !== lastDoc) {
      lastDoc = q?.doc;
      docSeq++;
      // A new doc (a kept shape, an edit elsewhere, a reload): any drag is
      // over, and a picked bend may no longer be the same corner.
      if (drag) endDrag();
      bend = null;
    }
    // Picking a part drops the wire.
    if (q?.selectedRef && q.selectedRef !== lastRef) selected = null;
    lastRef = q?.selectedRef ?? null;
    paint();
  });
  const offFrame = board.onFrame(place);

  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('dblclick', onDbl);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('lostpointercapture', onCancel);
  return {
    selected: () => selected,
    select,
    detach() {
      offKey();
      offStore();
      offFrame();
      endDrag();
      dom.removeEventListener('pointerdown', onDown, true);
      dom.removeEventListener('pointermove', onMove, true);
      dom.removeEventListener('pointerup', onUp, true);
      dom.removeEventListener('dblclick', onDbl);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('lostpointercapture', onCancel);
      card.remove();
    },
  };
}
```

- [ ] **Step 4: Attach it in the workspace, follow nets softly, and extend the e2e hook**

In `client/editor3d/workspace.ts`:

a. Find:

```ts
import { attachManipulation, commitMove } from './manipulate.ts';
```

Replace with:

```ts
import { attachManipulation, commitMove } from './manipulate.ts';
import { attachWireEdit } from './wireEdit.ts';
```

b. Find:

```ts
const ORBIT_HINT = 'drag to orbit · right-drag to pan · scroll to zoom · click a part to select it · F focus · R rotate · Shift+R flip chip · Del delete · Ctrl+Z undo · Esc close';
```

Replace with:

```ts
const ORBIT_HINT = 'drag to orbit · right-drag to pan · scroll to zoom · click a part or a wire to select it · F focus · R rotate · Shift+R flip chip · 1-9 wire colour · Del delete · Ctrl+Z undo · Esc close';
```

c. Find:

```ts
  let offHistory = () => {};
  const release = () => {
```

Replace with:

```ts
  let offHistory = () => {};
  let detachWires = () => {};
  const release = () => {
```

d. Find:

```ts
    offDel();
    detachCard();
```

Replace with:

```ts
    offDel();
    detachWires();
    detachCard();
```

e. Find:

```ts
        if (net) store.setProject({ highlight: { net }, activeStep: null, selectedRef: null });
```

Replace with:

```ts
        // Softly: the rest of the board stays as glass, so the wire reads in place.
        if (net) store.setProject({ highlight: { net, soft: true }, activeStep: null, selectedRef: null });
```

f. Find:

```ts
    detachCard = attachCard(ws);
    offDel = addKeyHandler((e) => {
```

Replace with:

```ts
    detachCard = attachCard(ws);
    const wires = attachWireEdit(ws);
    detachWires = () => wires.detach();
    offDel = addKeyHandler((e) => {
```

g. Find:

```ts
        wireTop: () => (board as unknown as { _wireTop(): number })._wireTop(),
```

Replace with:

```ts
        selectedWire: () => wires.selected(),
        selectWire: (key: string | null) => wires.select(key),
        handles: () => (board as unknown as { _handles(): { kind: string; index: number; x: number; y: number }[] })._handles(),
        wirePath: (key: string) => store.get().project?.sidecar.wirePaths[key] ?? null,
        netColor: (net: string) => store.get().project?.doc.nets[net]?.color ?? null,
        wireTop: () => (board as unknown as { _wireTop(): number })._wireTop(),
```

- [ ] **Step 5: Style the wire card**

In `client/styles.css`:

a. Find:

```css
.ws-card-confirm { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .1); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
```

Replace with:

```css
.ws-card-confirm { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .1); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ws-wirecard .ws-card-note { margin: 0 0 8px; opacity: .75; }
.ws-swatches { display: flex; gap: 5px; margin-bottom: 8px; }
.ws-swatches button { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .25); cursor: pointer; }
.ws-swatches button.is-on { border-color: #4da3ff; box-shadow: 0 0 0 2px rgba(77, 163, 255, .35); }
.ws-card-hint { margin: 8px 0 0; font-size: 11px; opacity: .6; }
```

- [ ] **Step 6: Typecheck and run the unit tests**

Run: `bun run typecheck` and `bun test`
Expected: typecheck clean; 407 pass.

- [ ] **Step 7: Build and run the four scenarios to check they pass**

Run: `bun run build && bun scripts/e2e-3d.ts "clicking a jumper selects it and opens the wire card" "dragging a segment handle reshapes a wire, undo puts it back, and the shape survives a reload" "double-click adds a bend pair and Delete on a picked bend takes it out" "digit keys recolour the selected wire's net"`
Expected: `ok` for all four.

- [ ] **Step 8: Run the whole e2e suite**

Run: `bun scripts/e2e-3d.ts`
Expected: 23 `ok`, no `FAIL`.

- [ ] **Step 9: Commit**

```bash
git add client/editor3d/wireEdit.ts client/editor3d/workspace.ts client/styles.css scripts/e2e-3d.ts
git commit -m "feat(3d): select, reshape and recolour jumpers; shapes undo and persist"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/editor3d.md`, `AGENTS.md`, `README.md`

**Interfaces:**
- Consumes: the behaviour of Tasks 1-8 as built.
- Produces: the phase 2 sections of the human guide, the agent guide's module map, invariants and `__e3d` members, and the README's 3D paragraph.

- [ ] **Step 1: Update the human guide**

In `docs/editor3d.md`:

a. Find:

```markdown
A full-screen 3D view of the breadboard where you can select parts, move them, turn or flip them, and edit their values. It works on the same project as the flat board.
```

Replace with:

```markdown
A full-screen 3D view of the breadboard where you can select parts, move them, turn or flip them, edit their values, and shape the jumper wires by hand. It works on the same project as the flat board.
```

b. Find:

```markdown
## Undo

Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and the bar has Undo and Redo buttons.

Covered: moves, turns and flips. They run one at a time, in order.

Not covered: value edits and deletes.
```

Replace with:

```markdown
## Wires

The **Wires** button switches between curved arcs and square wires. Square wires are the ones you can shape.

Square wires lie flat on the board, the way a carefully hand-wired board looks: straight up out of each hole, down onto the plastic, along the gaps between the rows with tight square bends, and back down into the other hole. They never cross a chip. Wires that share a gap run side by side in lanes, ordered so that a bundle does not cross itself where its wires peel off. Where two wires still cross, the one laid later hops over the other. The flat board's square view draws exactly the same paths.

Click a wire to select it. Its net is followed softly, an accent line runs along it, and the wire card opens beside it:

- the net and the two holes it joins, and its length along the board;
- colour swatches. Colour belongs to the net, so every jumper of that net changes. Keys 1 to 9 do the same: 1 red, 2 black, 3 blue, 4 green, 5 orange, 6 yellow, 7 white, 8 violet, 9 grey;
- **Re-route** (only for a wire you have shaped) forgets its shape;
- **Tidy all wires** (when any wire has been shaped) forgets every shape.

With square wires, a selected wire has handles:

- a large disc at the middle of every run longer than about two pitches. Drag it to slide that run sideways. It snaps to the lanes between the rows (or between the columns), never onto a row or column of holes. The run coming out of a hole cannot leave its hole, so it gets a small jog half a pitch out;
- a small disc on every bend. Drag it to move the corner; the two runs either side follow.

Double-click a wire to put a small Z (two new bends) into the run under the pointer. Double-click a bend, or click it (it turns white) and press Delete, to take it out again. A bend that holds a wire's end straight out of its hole cannot be removed.

While you drag, the wire follows the pointer. It turns red, and the hint line says why, when the shape would cross a chip or leave the board; releasing then leaves the wire as it was. When you release a valid shape it is saved and every other wire is routed again around it.

### How shapes are kept

A shape is saved in the layout sidecar (`NAME.breadboard.json`, under `wirePaths`), never in the schematic. It is keyed by the wire's net and its two holes, and it records only the bends, in board units (columns, the gap between two rows, and a lane within that gap), so it survives the board changing size. If a part moves so that the wire's holes change, the old shape no longer matches any wire: it is dropped, and the checks list a warning naming the net.

## Undo

Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and the bar has Undo and Redo buttons.

Covered: moves, turns and flips, and wire shapes (a drag, a new or removed bend, Re-route and Tidy all wires). They run one at a time, in order.

Not covered: wire colours, value edits and deletes.
```

c. Find:

```markdown
| Move, turn, flip (and their undo) | Yes (`NAME.breadboard.json`, pinned holes) | No |
```

Replace with:

```markdown
| Move, turn, flip (and their undo) | Yes (`NAME.breadboard.json`, pinned holes) | No |
| Shape a wire, Re-route, Tidy all wires | Yes (`wirePaths`) | No |
| Wire colour (swatch or 1 to 9) | Yes (`colors`, per net) | No |
```

d. Find:

```markdown
| Click | Select a part |
```

Replace with:

```markdown
| Click | Select a part or a wire |
```

e. Find:

```markdown
| Delete, Backspace | Open the delete confirm in the card |
```

Replace with:

```markdown
| Drag a wire handle | Slide a run, or move a bend |
| Double-click a wire | Add a pair of bends |
| Double-click a bend | Remove it |
| 1 to 9 | Recolour the selected wire's net |
| Delete, Backspace | With a bend picked, remove it; otherwise open the delete confirm in the part card |
```

f. Find:

```markdown
| Esc | Cancel a drag; else deselect; else close. In fly mode, back to orbit |
```

Replace with:

```markdown
| Esc | Cancel a drag; else unpick a bend; else deselect the wire or part; else close. In fly mode, back to orbit |
```

g. Find:

```markdown
- **The board reloaded by itself.**
```

Replace with:

```markdown
- **A wire is red in 3D, or dashed on the flat board.** The router could not find a clean path for it in time and drew it the simple way, which may pass over a chip. The checks name it. Moving a part to open up room usually fixes it; such a wire cannot be shaped until it has a clean route.
- **A wire's shape went back to the automatic one.** One of its holes changed (a part moved), so the saved shape no longer matched the wire. The checks list which one.
- **The 3D view closed with a "graphics context" message.** The browser took WebGL away (a GPU reset, or too many 3D pages open). Press 3D to open it again.
- **The board reloaded by itself.**
```

h. Find:

```markdown
- Phase 2: clean wire routing and hand-shaped wires.
- Phase 3
```

Replace with:

```markdown
- Phase 3
```

- [ ] **Step 2: Update the agent guide**

In `AGENTS.md`:

a. Find:

```markdown
- `client/editor3d/`: the 3D editor.
  - `workspace.ts`: the shell and key routing.
  - `manipulate.ts`: select, drag, rotate and flip.
  - `card.ts`: the part card.
  - `history.ts`: undo.
  - `focus-math.ts`: camera framing.
```

Replace with:

```markdown
- `src/render/route3d.ts`: pure router for square wires: A* over a half-pitch lattice, lane packing (nudging), rip-up rounds, humps at crossings, saved shapes. `ortho.ts` is only its fallback now.
- `src/edit/wireshape.ts`: pure hand edits to a wire plan (handles, snap, move a run or a bend, add or remove a bend pair).
- `client/wiretube-math.ts` (pure) and `client/wiretube.ts` (three.js): the flat jumper tube, with fillets and parallel-transport frames.
- `client/editor3d/`: the 3D editor.
  - `workspace.ts`: the shell and key routing.
  - `manipulate.ts`: select, drag, rotate and flip.
  - `card.ts`: the part card.
  - `wireEdit.ts`: wire selection, handles, the wire card, reshape commands.
  - `history.ts`: undo.
  - `focus-math.ts`: camera framing.
```

b. Find:

```markdown
- `src/**`, `client/editor3d/history.ts` and `client/editor3d/focus-math.ts` stay free of DOM and three.js.
```

Replace with:

```markdown
- `src/**`, `client/editor3d/history.ts`, `client/editor3d/focus-math.ts` and `client/wiretube-math.ts` stay free of DOM and three.js.
- Wire shapes go through `api.wirePath` -> `POST /api/projects/:id/layout/wire` `{ key, path }` -> `Service.setWirePath`, which writes `sidecar.wirePaths` and refuses a shape that is not square, does not leave its holes along their columns, leaves the board or crosses a package (`checkPlan`). `key: "*"` with `path: null` clears them all. In the editor every shape change is a `wirePathCommand` on the History stack.
- `wirePaths` keys are `${net}|${holeA}|${holeB}` with the two holes in MCP naming sorted as strings (`wireKey()`), and a `WirePath` stores only the bends in grid units: `col` in pitches (half steps between columns), `gap` (the corridor, `top`, `T+|T-`, `a|b` ... `B-|B+`, `bottom`) and `lane` (half pitches from the corridor centre). A saved key that matches no wire is dropped with a warning in `doc.warnings`.
- `LayoutDoc.routes` exists only when `options.wireStyle` is `orthogonal`; `buildLayoutDoc` routes then, so the flat board and the 3D board draw one set of paths. The arc style never routes and its SVG is byte-identical to before. A doc built only for a check (the part-drag verdict in `manipulate.ts`) uses the arc style so it does not route on every snapped move.
- Routes never lie on a leg or on another wire's end, never cross a package body (plus 3 units), and leave every hole straight along its column. Two wires of different nets never lie along each other or meet at a bend; of each crossing pair the later one humps over by one wire diameter.
```

c. Find:

```markdown
- The `?e2e` URL flag exposes `window.__e3d`: `ready`, `selected`, `holes`, `screenOf`, `parts`, `lead2`, `chips`, `select`, `pickAt`, `tintCount`, `value` (a part's value in the store's design), `wireStyle`, `move` (a layout move outside the pointer path). It also honours the test-only knobs `window.__e3dDelay` (ms to hold the three.js download) and `window.__e3dFailMount` (make mounting throw).
```

Replace with:

```markdown
- The `?e2e` URL flag exposes `window.__e3d`: `ready`, `selected`, `holes`, `screenOf`, `parts`, `lead2`, `chips`, `select`, `pickAt`, `tintCount`, `value` (a part's value in the store's design), `wireStyle`, `move` (a layout move outside the pointer path); and for wires `routes` (each square wire's plan), `wires` (their keys), `wireScreen(i)` (page point halfway along wire i), `selectedWire`, `selectWire(key)`, `handles` (page points of the drawn handles), `wirePath(key)` (the saved shape in the store), `netColor(net)`, `wireTop` (highest jacket point) and `loseContext` (force a WebGL context loss). It also honours the test-only knobs `window.__e3dDelay` (ms to hold the three.js download) and `window.__e3dFailMount` (make mounting throw).
- Handles are picked on raycast layer 4. Anything picked right after it is created must have its world matrix updated first (`updateMatrixWorld`): the harness renders at about 3 fps, so the next frame may not have happened yet.
```

- [ ] **Step 3: Update the README**

In `README.md`:

a. Find:

```markdown
Press **3D** on a project to open the full-screen 3D editor. Click a part to select it, then drag it to new holes, turn it (R), flip a chip (Shift+R), edit its value or delete it from the card beside it, and press F to fly to it. Ctrl+Z undoes layout changes.
```

Replace with:

```markdown
Press **3D** on a project to open the full-screen 3D editor. Click a part to select it, then drag it to new holes, turn it (R), flip a chip (Shift+R), edit its value or delete it from the card beside it, and press F to fly to it. With square wires, click a jumper to reshape it by its handles or recolour its net (keys 1 to 9). Ctrl+Z undoes layout changes.
```

- [ ] **Step 4: Check the docs against the code**

Read `docs/editor3d.md` top to bottom with the editor open (`bun run build && bun server/index.ts`, open a project, press 3D, switch Wires to square) and confirm every control and shortcut it names works as written. Then run the full gate once more:

Run: `bun test`, `bun run typecheck`, `bun run build && bun scripts/e2e-3d.ts`
Expected: 407 pass; typecheck clean; 23 `ok`.

- [ ] **Step 5: Commit**

```bash
git add docs/editor3d.md AGENTS.md README.md
git commit -m "docs: 3D editor phase 2, clean wires"
```

---

## Self-review

**Spec coverage.**
- §5.1 router: A* with heading state and bend, share, cross costs, fewer-bends tie-break (Task 1); chips as hard obstacles with a flagged fallback (Tasks 1, 3, 7); search cap with the ortho.ts fallback (Task 1); hand shapes first, stale ones dropped with a warning naming the net (Tasks 1, 3); left-edge lane packing with vertical (peel-off) order, for corridors and column tracks (Task 2); humps at crossings (Tasks 1, 6); output `{ plan, lifts, warning }` (Task 1); the 2D square view switched to it, arcs unchanged (Task 3).
- §5.2 tube: fillets with the clamped-radius rule, collinear points dropped, rings per run and per 15 degrees, parallel transport seeded seam-down, 10 sides, jacket 7 short of each hole, vertex budget, per-wire rebuild during a drag (Tasks 6, 7); colours per net, power red and ground black (Task 3 test; clarification 12).
- §5.3 editing: select, soft follow, selection overlay, wire card with net, length, swatches, Re-route and Tidy all wires; segment and bend handles; perpendicular drag snapped to lanes, auto-jog at a hole; double-click add and remove, Delete on a picked bend; redundant points removed; red and refused through a chip; saved through `layout/wire` as a `SetWirePath` command; other wires re-pack; digit keys recolour the net (Tasks 5, 7, 8).
- §3 sidecar `wirePaths` and `WirePath` in grid units, `normalizeSidecar` tolerant of old files, `POST /layout/wire` and `service.setWirePath` (Tasks 1, 4); MCP tool list unchanged.
- §7: router failures never throw and fall back with a warning (Task 1); server refusals toast and restore (Task 8 `commitWirePath`); WebGL context loss (Task 7).
- §9: route3d, wiretube, sidecar and service tests (Tasks 1-6); render snapshot (clarification 13, Task 3); e2e for shaping a wire and reloading it (Task 8). Refusing a shorting jumper and tray drops are phase 3.
- §10: docs (Task 9).

**Placeholder scan.** No step says "similar to", "add error handling" or leaves code out; every code step carries the code or an exact find-and-replace.

**Type consistency.** `WireRoute`, `Point`, `Lift`, `WirePath` and `wireKey` are defined once (Tasks 1, 1, 1, 1, 1) and imported by name everywhere after. `Board3D.setHandles(list, selectedBend)`, `pickHandle`, `setWirePreview`, `setWireSelected`, `wireAnchor` and `project` are defined in Task 7 and called with those signatures in Task 8. `WireMeshes.base` and `jacket.userData.rest` are set in Task 6 and read in Task 7. The `__e3d` members added in Tasks 7 and 8 are the ones the scenarios call and the ones Task 9 documents.

**Verification before writing.** The code in every step was run before this plan was written: all 407 unit tests pass, typecheck is clean, and all 23 e2e scenarios pass against a build (the six new ones included).
