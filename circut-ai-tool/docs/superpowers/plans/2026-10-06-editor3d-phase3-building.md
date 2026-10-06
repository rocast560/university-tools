# 3D editor phase 3: building the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the full-screen 3D editor you can pick a part from a tray and drop it on the breadboard (it is added to the schematic), draw a jumper between two holes, duplicate and delete parts; and the clean-wire router works on stacked boards too.

**Architecture:** The lattice router learns stacked boards by routing each board in its own local frame and shifting the result. New pure modules (`src/edit/newpart.ts`, additions to `src/edit/placement.ts`) hold every decision that can be tested without a browser: where a dropped part's legs go, which nets they join, what a jumper does. The browser side adds a tray (`client/editor3d/tray.ts`), a translucent ghost on `Board3D`, a wire tool (`client/editor3d/wiretool.ts`) and a Duplicate key, all routed through the existing `Workspace`, `addKeyHandler`, `board.boardPoint` and `setStripTint` seams. Schematic edits go through the existing `/edit/*` routes and reload with `loadProject`.

**Tech Stack:** bun 1.3, TypeScript, three.js 0.185 (vanilla), Hono server, `bun test`, headless-Chrome e2e in `scripts/e2e-3d.ts`.

**Spec:** `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md` §6 (phase 3), §7 (errors), §9 (testing), §10 (docs). Read it alongside this plan.

## Global Constraints

- Work on branch `editor3d` in `C:\Users\rober\Desktop\university-tools\.worktrees\editor3d`; the app lives in `circut-ai-tool/` (note the spelling).
- Commit messages: conventional style (`feat(3d): …`), **no** `Co-Authored-By: Claude` or "Generated with Claude Code" lines.
- A tray drop **adds a real component to the schematic** (with a backup), the same as `add_component` (spec §1 decisions table).
- Merging two different nets from 3D is **refused** with a message; use the schematic (spec §1 out of scope).
- Every drag has a single-pointer alternative: tap to arm, tap a hole (WCAG 2.2 SC 2.5.7, spec §2, §6.2).
- Pointer Events only, never HTML5 drag-and-drop (spec §2, §6.2).
- Schematic edits stay off the undo stack (`client/editor3d/history.ts` header): they are undone by the server backup, not Ctrl+Z.
- After every task: `bun run typecheck` and `bun test` clean in `circut-ai-tool/`.
- **Proposed deviation from spec §6.1 (needs the user's OK before Task 6):** tray thumbnails reuse the 2D part pictures from `client/part-icons.ts` (already in the parts list) instead of offscreen WebGL renders. 3D thumbnails come back with the high-fidelity models in phase 4.

## Review Focus

1. **A drop on a stacked board's lower half** must land in the holes under the pointer (tier offset), not on the top board. → Task 3 test `holeNear on a stacked board picks the lower board`.
2. **A part dropped across the centre channel the wrong way** (a DIP not straddling e/f) must be refused with a reason, not added. → Task 3 test `a DIP whose rows do not straddle the channel has no default holes`.
3. **The add succeeds but the move fails** (server refuses the holes): the part must stay in the schematic, be auto-placed, and the user must be told. → Task 6 step "drop flow" plus e2e scenario `a refused move after add still leaves the part placed`.
4. **A jumper between two strips with different nets** must stay red and change nothing. → Task 4 test `two different nets are refused`.
5. **Tray search with no matches / Esc while armed** must leave nothing armed and no ghost on the board. → Task 6 e2e scenario `Esc disarms and clears the ghost`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/render/route3d.ts` (modify) | Stacked boards: route each board locally; tier-aware `nodeKey`, `takenNodes`, `checkPlan`, `pathToPlan`, `planToPath`. |
| `src/edit/newpart.ts` (create) | Pure: a part's pins and footprint from its library symbol; default holes for a footprint at a hole; `holeNear` (pointer → hole, tier-aware). |
| `src/edit/placement.ts` (modify) | Pure: `legsToConnections`, `jumperOutcome`. |
| `server/api.ts`, `server/service.ts` (modify) | `GET /api/projects/:id/parts/footprint?part=…`. |
| `client/api.ts` (modify) | `parts`, `footprint`, `editAdd`, `editConnect`. |
| `client/board3d.ts` (modify) | `setGhost(ghost \| null)`. |
| `client/editor3d/tray.ts` (create) | Tray UI: search, groups, tiles, drag and tap-to-arm, drop flow. |
| `client/editor3d/wiretool.ts` (create) | W key / button: hole → hole jumper with live verdict. |
| `client/editor3d/duplicate.ts` (create) | D key / card button. |
| `client/editor3d/workspace.ts`, `card.ts` (modify) | Mount the tray, wire tool and duplicate; Duplicate button on the card. |
| `docs/editor3d.md`, `README.md` (modify) | User docs for the new tools. |
| `scripts/e2e-3d.ts` (modify) | New scenarios. |

---

### Task 1: The lattice router on stacked boards

**Files:**
- Modify: `src/render/route3d.ts` (imports :24-27; `nodeKey` :233; `takenNodes` :240; `checkPlan` :261-267; `pathToPlan` :292; `planToPath` :318; `routeWires` :812-815)
- Modify: `client/editor3d/wireEdit.ts:53,163` (pass `doc.board`)
- Test: `test/route3d.test.ts` (replace the `stacked and double boards` describe added in the merge)

**Interfaces:**
- Produces: `pathToPlan(w: Wire, path: WirePath, board?: BoardSpec): Point[] | null`, `planToPath(w: Wire, plan: Point[], board?: BoardSpec): WirePath | null`, `takenNodes(input: Pick<RouteInput, 'pinHoles' | 'wires'> & { board?: BoardSpec }): Taken`. Saved `WirePoint.col` on a stacked board is the **global** column (1–126).

Design: a stacked board is `tiers` single boards of `tierCols` columns, drawn `TIER_PITCH` apart (`src/render/geometry.ts:21-50`). A wire with both ends on one board is routed by the existing single-board router on that board alone (columns renumbered from 1, only that board's packages and legs), then shifted down by `t * TIER_PITCH`. A wire joining two boards keeps the corridor router's plan (`wirePolylines`), exactly as today.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('stacked and double boards', …)` block at the end of `test/route3d.test.ts` with:

```ts
describe('stacked boards', () => {
  const board = { cols: 126, kind: 'stacked' as const, splitCol: 63, railGapEvery: 6, tiers: 2 };
  const w = (a: string, b: string) => {
    const h = (s: string) => ({ row: s.replace(/\d+$/, '') as never, col: Number(/\d+$/.exec(s)![0]) });
    return { net: '/N', a: h(a), b: h(b), role: 'signal' as const };
  };

  test('a wire on the lower board is routed there by the lattice, square and on that board', () => {
    const r = routeWires({ wires: [w('a70', 'a80')], packages: [], board, pinHoles: {} });
    expect(r.warnings).toEqual([]);
    const plan = r.routes[0].plan;
    // Both ends where placeAt puts them: lower board, columns 7 and 17 of it.
    expect(plan[0]).toEqual(placeAt(board, { col: 70, row: 'a' }));
    expect(plan[plan.length - 1]).toEqual(placeAt(board, { col: 80, row: 'a' }));
    expect(plan.every(([, y]) => y > TIER_PITCH - 30)).toBe(true);
    expect(checkPlan(plan, [], board)).toBeNull();
  });

  test('a wire joining the two boards keeps the corridor plan', () => {
    const wires = [w('a5', 'j70')];
    const r = routeWires({ wires, packages: [], board, pinHoles: {} });
    expect(r.routes[0].plan).toEqual(wirePolylines(wires, [], board)[0]);
  });

  test('a lower-board plan round-trips through planToPath with global columns', () => {
    const wire = w('a70', 'a80');
    const plan = routeWires({ wires: [wire], packages: [], board, pinHoles: {} }).routes[0].plan;
    const path = planToPath(wire, plan, board)!;
    expect(path).not.toBeNull();
    for (const p of path.points) expect(p.col).toBeGreaterThan(63);
    expect(pathToPlan(wire, path, board)).toEqual(plan);
  });

  test('a saved shape on the lower board is kept by the router', () => {
    const wire = w('a70', 'a80');
    const path = { points: [{ col: 70, gap: 'T-|a', lane: 0 }, { col: 80, gap: 'T-|a', lane: 0 }] };
    const r = routeWires({ wires: [wire], packages: [], board, pinHoles: {} }, { [wireKey(wire)]: path });
    expect(r.routes[0].locked).toBe(true);
  });

  test('legs on the lower board are taken nodes there, not on the upper board', () => {
    const taken = takenNodes({ wires: [], pinHoles: { R1: { '1': { col: 70, row: 'c' } } }, board });
    expect([...taken.values()]).toEqual(['a leg at c70']);
    expect(taken.has(nodeKey(placeAt(board, { col: 70, row: 'c' }))!)).toBe(true);
    expect(taken.has(nodeKey(pt({ col: 7, row: 'c' }))!)).toBe(false);
  });
});
```

Add to the imports at the top of the file: `placeAt, TIER_PITCH` from `'../src/render/geometry.ts'` (next to `pt`).

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test test/route3d.test.ts`
Expected: FAIL — the first test fails `checkPlan` ("the path leaves the board"), the round-trip test gets `null` from `planToPath`, the saved-shape test is not `locked`, and `takenNodes` keys the leg at the upper board's coordinates.

- [ ] **Step 3: Implement**

In `src/render/route3d.ts`:

1. Imports (:26): `import { HEIGHT, P, placeAt, pt, ROWY, tierCols, tierCount, tierOf, TIER_PITCH, X0 } from './geometry.ts';`

2. Replace `nodeKey` (:233-237) so a node on a lower board gets its own key space:

```ts
/** A point's lattice node as "k,j" (half pitches from X0 and Y0, on the top board) or "t:k,j" on stacked board t; null off the lattice. */
export function nodeKey([x, y]: Point): string | null {
  const t = Math.max(0, Math.floor((y + (TIER_PITCH - HEIGHT) / 2) / TIER_PITCH));
  const yl = y - t * TIER_PITCH;
  const k = Math.round((x - X0) / LANE);
  const j = Math.round((yl - Y0) / LANE);
  if (Math.abs(X0 + k * LANE - x) >= 0.01 || Math.abs(Y0 + j * LANE - yl) >= 0.01) return null;
  return t ? `${t}:${k},${j}` : `${k},${j}`;
}
```

3. `takenNodes` (:240): change the parameter to `input: Pick<RouteInput, 'pinHoles' | 'wires'> & { board?: BoardSpec }` and every `pt(h)` inside it to `at(h)` where `const at = (h: Hole) => (input.board ? placeAt(input.board, h) : pt(h));`. (`LayoutDoc` and `RouteInput` both carry `board`, so existing callers pick it up unchanged.)

4. `checkPlan` (:266-267): replace the width/height lines with

```ts
  const width = 2 * X0 + (tierCols(board) - 1) * P;
  const height = HEIGHT + (tierCount(board) - 1) * TIER_PITCH;
  if (plan.some(([x, y]) => x < WIRE_R || x > width - WIRE_R || y < WIRE_R || y > height - WIRE_R)) return 'the path leaves the board';
```

5. Add, above `pathToPlan`:

```ts
/** The board both ends of `w` sit on, or null when it joins two stacked boards. */
function tierOfWire(w: Wire, board: BoardSpec): number | null {
  const t = tierOf(board, w.a.col);
  return tierOf(board, w.b.col) === t ? t : null;
}

/** `w` and `path` as they read on board `t` alone: columns from 1 on that board. */
function localWire(w: Wire, board: BoardSpec, t: number): Wire {
  const lo = t * tierCols(board);
  return { ...w, a: { ...w.a, col: w.a.col - lo }, b: { ...w.b, col: w.b.col - lo } };
}
const shiftPath = (path: WirePath, dc: number): WirePath => ({ points: path.points.map((p) => ({ ...p, col: p.col + dc })) });
const shiftPlan = (plan: Point[], dy: number): Point[] => plan.map(([x, y]) => [x, y + dy]);
```

6. `pathToPlan`: new signature `pathToPlan(w: Wire, path: WirePath, board?: BoardSpec): Point[] | null`. At the top:

```ts
  if (board && tierCount(board) > 1) {
    const t = tierOfWire(w, board);
    if (t === null) return null;
    const plan = pathToPlan(localWire(w, board, t), shiftPath(path, -t * tierCols(board)));
    return plan && shiftPlan(plan, t * TIER_PITCH);
  }
```

   and pass `board` from `shapePlan` (:310): `pathToPlan(w, path, board)`.

7. `planToPath`: new signature `planToPath(w: Wire, plan: Point[], board?: BoardSpec): WirePath | null`. At the top:

```ts
  if (board && tierCount(board) > 1) {
    const t = tierOfWire(w, board);
    if (t === null) return null;
    const path = planToPath(localWire(w, board, t), shiftPlan(plan, -t * TIER_PITCH));
    return path && shiftPath(path, t * tierCols(board));
  }
```

8. `routeWires`: replace the early-out at :813-815 with

```ts
  if (tierCount(input.board) > 1) return routeStacked(input, saved, opts);
```

   and add below `routeWires`:

```ts
/**
 * A stacked board: each board routed on its own by the lattice, in its own
 * columns, then moved down to where it is drawn; a wire joining two boards
 * keeps the corridor router's plan. Saved shapes are keyed and numbered
 * globally, so they are translated on the way in.
 */
function routeStacked(input: RouteInput, saved: Record<string, WirePath>, opts: { maxExpand?: number }): RouteResult {
  const board = input.board;
  const cols = tierCols(board);
  const fallback = wirePolylines(input.wires, input.packages, board);
  const routes: WireRoute[] = fallback.map((plan) => ({ plan, lifts: [] }));
  const warnings: string[] = [];
  const single: BoardSpec = { cols, kind: 'full', splitCol: null, railGapEvery: board.railGapEvery };
  for (let t = 0; t < tierCount(board); t++) {
    const lo = t * cols;
    const on = (h: Hole) => tierOf(board, h.col) === t;
    const local = (h: Hole): Hole => ({ ...h, col: h.col - lo });
    const idx = input.wires.map((w, i) => (on(w.a) && on(w.b) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const wires = idx.map((i) => localWire(input.wires[i], board, t));
    const pinHoles: Record<string, Record<string, Hole>> = {};
    for (const [ref, pins] of Object.entries(input.pinHoles)) {
      const mine = Object.entries(pins).filter(([, h]) => on(h));
      if (mine.length) pinHoles[ref] = Object.fromEntries(mine.map(([p, h]) => [p, local(h)]));
    }
    const packages = input.packages.filter((p) => tierOf(board, p.col0) === t).map((p) => ({ ...p, col0: p.col0 - lo }));
    const localSaved: Record<string, WirePath> = {};
    idx.forEach((i, n) => {
      const path = saved[wireKey(input.wires[i])];
      if (path) localSaved[wireKey(wires[n])] = shiftPath(path, -lo);
    });
    const r = routeWires({ wires, packages, board: single, pinHoles }, localSaved, opts);
    idx.forEach((i, n) => {
      routes[i] = { ...r.routes[n], plan: shiftPlan(r.routes[n].plan, t * TIER_PITCH) };
    });
    warnings.push(...r.warnings);
  }
  return { routes, warnings };
}
```

9. In `client/editor3d/wireEdit.ts`: `:53` `planToPath(w, plan, doc.board)` and `:163` `!planToPath(wire, route.plan, doc.board)` (the doc in scope there is the workspace doc; check the surrounding function for its name and use it). Also grep for any other `pathToPlan(` / `planToPath(` call and pass the board.

- [ ] **Step 4: Run the tests**

Run: `bun test test/route3d.test.ts test/route3d-nudge.test.ts test/route3d-pipeline.test.ts test/stacked.test.ts`
Expected: PASS (all old single-board tests still pass: `nodeKey` returns the same `"k,j"` on the top board).

- [ ] **Step 5: Full check and commit**

Run: `bun run typecheck && bun test` — expected clean.

```bash
git add src/render/route3d.ts client/editor3d/wireEdit.ts test/route3d.test.ts
git commit -m "feat(3d): route clean wires on stacked boards, one board at a time"
```

---

### Task 2: A new part's pins and footprint (server)

**Files:**
- Create: `src/edit/newpart.ts` (only `componentFromSymbol` in this task)
- Modify: `server/service.ts` (add `partFootprint`), `server/api.ts` (route)
- Test: `test/newpart.test.ts`, `test/api.test.ts` (one route test)

**Interfaces:**
- Produces: `componentFromSymbol(lib: LibSymbol, value: string, ref?: string): Component`; `service.partFootprint(part: string): Promise<{ alias: string; libId: string; value: string; pins: string[]; footprint: Footprint }>`; `GET /api/parts/footprint?part=<alias>` → that object; 404 with `{ error }` for an unknown alias.

- [ ] **Step 1: Failing test for the pure helper**

`test/newpart.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parse } from '../src/sexpr.ts';
import { parseLibSymbol } from '../src/kicad/schematic.ts';
import { classify } from '../src/parts/catalog.ts';
import { componentFromSymbol } from '../src/edit/newpart.ts';

// A two-pin symbol in the shape extractLibSymbol returns.
const R = `(symbol "Device:R" (symbol "R_0_1") (symbol "R_1_1"
  (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
  (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;

describe('componentFromSymbol', () => {
  test('a resistor symbol becomes an unconnected two-lead resistor', () => {
    const comp = componentFromSymbol(parseLibSymbol(parse(R)), '1k');
    expect(comp).toMatchObject({ lib: 'Device', part: 'R', value: '1k' });
    expect([...comp.pins.keys()].sort()).toEqual(['1', '2']);
    expect([...comp.pins.values()].every((p) => p.net === '')).toBe(true);
    expect(classify(comp)).toMatchObject({ kind: 'lead2', style: 'R' });
  });
});
```

If `parse` returns a wrapper list rather than the symbol node itself, adjust the test to take the first child — check `src/sexpr.ts:31` and how `server/lab3-example.ts` feeds `parseLibSymbol`.

Run: `bun test test/newpart.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 2: Implement `componentFromSymbol`**

`src/edit/newpart.ts`:

```ts
// A part that is not in the schematic yet: its pins and breadboard footprint,
// worked out from its library symbol, and where its legs would go if dropped
// at a hole. Pure, so the tray's choices are testable without a browser.

import type { LibSymbol } from '../kicad/schematic.ts';
import type { Component, DesignPin } from '../netlist.ts';

/** Every pin of every unit, unconnected: what classify() needs to pick a footprint. */
export function componentFromSymbol(lib: LibSymbol, value: string, ref = 'NEW?'): Component {
  const [libName, part] = lib.id.includes(':') ? [lib.id.slice(0, lib.id.indexOf(':')), lib.name] : ['', lib.name];
  const pins = new Map<string, DesignPin>();
  for (const list of lib.units.values()) for (const p of list) if (!pins.has(p.number)) pins.set(p.number, { net: '', name: p.name, type: p.type } as DesignPin);
  return { ref, value, lib: libName, part, pins };
}
```

Check `DesignPin`'s fields in `src/netlist.ts` and fill them all (drop the cast if every field is provided).

Run: `bun test test/newpart.test.ts` — Expected: PASS.

- [ ] **Step 3: Failing route test**

In `test/api.test.ts`, following the file's existing pattern for building the app with a real symbol directory, add:

```ts
test('GET /api/parts/footprint describes a part from its symbol', async () => {
  const res = await app.request('/api/parts/footprint?part=resistor');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ libId: 'Device:R', pins: ['1', '2'], footprint: { kind: 'lead2', style: 'R' } });
  expect((await app.request('/api/parts/footprint?part=nope')).status).toBe(404);
});
```

Use whatever alias in `src/parts/aliases.ts` maps to `Device:R` (check the exact alias string). Run it — Expected: FAIL (404 for both).

- [ ] **Step 4: Implement the route**

`server/service.ts` — add a method (import `createLibraryLookup` from `./libraries.ts`, `KICAD_SYMBOL_DIR` from `./config.ts`, `resolveAlias` from `../src/parts/aliases.ts`, `parse` from `../src/sexpr.ts`, `parseLibSymbol` from `../src/kicad/schematic.ts`, `classify` from `../src/parts/catalog.ts`, `componentFromSymbol` from `../src/edit/newpart.ts`, `footprintPins` from `../src/layout/engine.ts`):

```ts
  private libs = createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR });

  /** What a tray part would be on the board: its footprint and leg order, before it exists. */
  async partFootprint(part: string) {
    const alias = resolveAlias(part);
    if (!alias) throw new ServiceError(`no part called "${part}"`, 404);
    const lib = parseLibSymbol(parse(await this.libs.symbolText(alias.libId)));
    const value = alias.defaultValue ?? lib.name;
    const comp = componentFromSymbol(lib, value);
    const footprint = classify(comp);
    const pins = footprint.kind === 'power' || footprint.kind === 'supply' || footprint.kind === 'unsupported' ? [] : footprintPins(footprint, comp);
    return { alias: alias.alias, libId: alias.libId, value, pins, footprint };
  }
```

`server/api.ts`, next to `api.get('/parts', …)` (:215), **before** any `/parts/:x` route:

```ts
  api.get('/parts/footprint', async (c) => c.json(await service.partFootprint(c.req.query('part') ?? '')));
```

(Errors go through the file's existing `ServiceError` handler — confirm 404 maps to status 404.)

- [ ] **Step 5: Run and commit**

Run: `bun test test/newpart.test.ts test/api.test.ts && bun run typecheck` — Expected: PASS.

```bash
git add src/edit/newpart.ts server/service.ts server/api.ts test/newpart.test.ts test/api.test.ts
git commit -m "feat(3d): describe a tray part's footprint before it is added"
```

---

### Task 3: Where a dropped part's legs go

**Files:**
- Modify: `src/edit/newpart.ts`
- Test: `test/newpart.test.ts`

**Interfaces:**
- Consumes: `Footprint` (`src/parts/catalog.ts:8`), `placeAt`, `tierAtY`, `tierCols`, `ROWY`, `X0`, `P` (`src/render/geometry.ts`), `inBoard` (`src/edit/placement.ts:32`).
- Produces: `holeNear(board: BoardSpec, p: [number, number]): Hole | null`; `defaultHoles(fp: Footprint, pins: string[], at: Hole, board: BoardSpec): Record<string, Hole> | null`; `LEAD_SPAN: Record<string, number>`.

Rules (match how the engine and the lab kit seat parts):
- `lead2`: pin `pins[0]` at `at`, `pins[1]` on the same row `LEAD_SPAN[style]` columns to the right (R 4, LED 1, C 1, Cpol 1, D 4, Z 4, L 4, SW 2, BTN 2, X 2; default 3).
- `dip` / `dipswitch` (pins = 2n in order 1…2n): `at` must be in row `f` or `e`; pins 1…n go along row `f` from `at.col` rightwards, pins n+1…2n along row `e` from `at.col + n - 1` leftwards (pin 1 bottom-left, notch left — the same pattern as the engine and the saved U8 placement in lab 6). If `at.row` is `e`, use the same columns. Any other row: `null`.
- `to92` / `pot3`: three consecutive columns on `at.row`.
- `sevenseg`, `module`, `power`, `supply`, `unsupported`: `null` (the drop adds the part and lets the engine place it).
- Any resulting hole failing `inBoard`, or a DIP/to92 run crossing from one stacked board onto the next (`tierOf` differs between first and last column): `null`.

- [ ] **Step 1: Failing tests** (append to `test/newpart.test.ts`)

```ts
import { defaultHoles, holeNear } from '../src/edit/newpart.ts';
import { placeAt } from '../src/render/geometry.ts';

const full = { cols: 63, kind: 'full' as const, splitCol: null, railGapEvery: 6 };
const stacked = { cols: 126, kind: 'stacked' as const, splitCol: 63, railGapEvery: 6, tiers: 2 };

describe('holeNear', () => {
  test('snaps a point to the nearest hole', () => {
    const [x, y] = placeAt(full, { col: 12, row: 'c' });
    expect(holeNear(full, [x + 4, y - 3])).toEqual({ col: 12, row: 'c' });
  });
  test('holeNear on a stacked board picks the lower board', () => {
    const [x, y] = placeAt(stacked, { col: 70, row: 'h' });
    expect(holeNear(stacked, [x, y])).toEqual({ col: 70, row: 'h' });
  });
  test('off the board is null', () => {
    expect(holeNear(full, [-200, 10])).toBeNull();
  });
});

describe('defaultHoles', () => {
  const R = { kind: 'lead2', style: 'R', a: '1', b: '2', polarized: false, aLabel: '', bLabel: '' } as const;
  test('a resistor spans four columns along its row', () => {
    expect(defaultHoles(R, ['1', '2'], { col: 10, row: 'b' }, full)).toEqual({ '1': { col: 10, row: 'b' }, '2': { col: 14, row: 'b' } });
  });
  test('a 14-pin DIP straddles the channel with pin 1 bottom-left', () => {
    const pins = Array.from({ length: 14 }, (_, i) => String(i + 1));
    const h = defaultHoles({ kind: 'dip', pins: 14 }, pins, { col: 20, row: 'f' }, full)!;
    expect(h['1']).toEqual({ col: 20, row: 'f' });
    expect(h['7']).toEqual({ col: 26, row: 'f' });
    expect(h['8']).toEqual({ col: 26, row: 'e' });
    expect(h['14']).toEqual({ col: 20, row: 'e' });
  });
  test('a DIP whose rows do not straddle the channel has no default holes', () => {
    const pins = Array.from({ length: 14 }, (_, i) => String(i + 1));
    expect(defaultHoles({ kind: 'dip', pins: 14 }, pins, { col: 20, row: 'b' }, full)).toBeNull();
  });
  test('a DIP running off the end of the top board is refused on a stacked board', () => {
    const pins = Array.from({ length: 16 }, (_, i) => String(i + 1));
    expect(defaultHoles({ kind: 'dip', pins: 16 }, pins, { col: 60, row: 'f' }, stacked)).toBeNull();
  });
  test('a display has no default holes: the engine places it', () => {
    expect(defaultHoles({ kind: 'sevenseg', pins: 10, common: 'anode', segments: {}, commonPins: [] }, [], { col: 5, row: 'f' }, full)).toBeNull();
  });
});
```

Run: `bun test test/newpart.test.ts` — Expected: FAIL (not exported).

- [ ] **Step 2: Implement** (append to `src/edit/newpart.ts`)

```ts
import type { Footprint } from '../parts/catalog.ts';
import type { BoardSpec, Hole, Row } from '../layout/types.ts';
import { P, ROWY, tierAtY, tierCols, tierOf, X0 } from '../render/geometry.ts';
import { inBoard, ROW_ORDER } from './placement.ts';

/** Columns between a two-lead part's legs, by style, when it is dropped flat along a row. */
export const LEAD_SPAN: Record<string, number> = { R: 4, D: 4, Z: 4, L: 4, LED: 1, C: 1, Cpol: 1, SW: 2, BTN: 2, X: 2 };

/** The hole under a point in plan (SVG) units, on whichever stacked board it falls; null off the board. */
export function holeNear(board: BoardSpec, [x, y]: [number, number]): Hole | null {
  const { tier, y: yl } = tierAtY(board, y);
  let row: Row = ROW_ORDER[0];
  for (const r of ROW_ORDER) if (Math.abs(ROWY[r] - yl) < Math.abs(ROWY[row] - yl)) row = r;
  if (Math.abs(ROWY[row] - yl) > P) return null;
  const local = Math.round((x - X0) / P) + 1;
  if (local < 1 || local > tierCols(board)) return null;
  const h = { col: local + tier * tierCols(board), row };
  return inBoard(h, board) ? h : null;
}

/** Where each leg goes when a part with footprint `fp` is dropped with its first leg at `at`; null when it cannot sit there. */
export function defaultHoles(fp: Footprint, pins: string[], at: Hole, board: BoardSpec): Record<string, Hole> | null {
  const out: Record<string, Hole> = {};
  const sameBoard = (c0: number, c1: number) => tierOf(board, c0) === tierOf(board, c1);
  switch (fp.kind) {
    case 'lead2': {
      const span = LEAD_SPAN[fp.style] ?? 3;
      if (!sameBoard(at.col, at.col + span)) return null;
      out[pins[0]] = { ...at };
      out[pins[1]] = { col: at.col + span, row: at.row };
      break;
    }
    case 'dip':
    case 'dipswitch': {
      if (at.row !== 'e' && at.row !== 'f') return null;
      const n = pins.length / 2;
      if (!Number.isInteger(n) || !sameBoard(at.col, at.col + n - 1)) return null;
      for (let i = 0; i < n; i++) out[pins[i]] = { col: at.col + i, row: 'f' };
      for (let i = 0; i < n; i++) out[pins[n + i]] = { col: at.col + n - 1 - i, row: 'e' };
      break;
    }
    case 'to92':
    case 'pot3': {
      if (!sameBoard(at.col, at.col + 2)) return null;
      pins.forEach((p, i) => (out[p] = { col: at.col + i, row: at.row }));
      break;
    }
    default:
      return null;
  }
  return Object.values(out).every((h) => inBoard(h, board)) ? out : null;
}
```

Note for `dipswitch`: the footprint pins come from `footprintPins` as `fp.pairs.flat()` (`[1, 14, 2, 13, …]`), not 1…2n. Before laying out a dipswitch, re-order: `const order = [...pins].sort((a, b) => Number(a) - Number(b));` and use `order` in place of `pins` in that case. Add a test: a 7-position switch dropped at `f20` puts pin 1 at `f20`, pin 7 at `f26`, pin 8 at `e26`, pin 14 at `e20`.

- [ ] **Step 3: Run and commit**

Run: `bun test test/newpart.test.ts && bun run typecheck` — Expected: PASS.

```bash
git add src/edit/newpart.ts test/newpart.test.ts
git commit -m "feat(3d): default leg holes for a dropped part, tier-aware"
```

---

### Task 4: Which nets a drop joins, and what a jumper does

**Files:**
- Modify: `src/edit/placement.ts`
- Test: `test/placement.test.ts`

**Interfaces:**
- Consumes: `stripNets(doc, design, except)` (:43), `stripOf` (`src/layout/board.ts`), `takenHoles` (:62).
- Produces:
  - `legsToConnections(doc: LayoutDoc, design: Design, holes: Record<string, Hole>): Record<string, string>` — pin → net for every leg whose strip carries exactly one net; legs in empty strips are left out (they stay unconnected).
  - `type JumperOutcome = { kind: 'connect'; net: string; pins: { ref: string; pin: string }[] } | { kind: 'same'; net: string } | { kind: 'refuse'; reason: string }`
  - `jumperOutcome(doc: LayoutDoc, design: Design, a: Hole, b: Hole): JumperOutcome`

`jumperOutcome` follows spec §6.3's table: strip nets come from `stripNets(doc, design, null)`; the unconnected pins of a strip are the legs in it (`doc.pinHoles`) whose design pin has `net === ''` or a net name starting `unconnected-`.

| a strip | b strip | result |
|---|---|---|
| empty, has unconnected pins | has net N (one) | `connect` those pins to N |
| has net N | empty, has unconnected pins | same, mirrored |
| net A | net B, A ≠ B | `refuse`: `would join A and B. Merge nets in the schematic` (names via `displayName`) |
| net A | net A | `same` |
| empty | empty | `refuse`: `nothing to connect yet. Place a part first` |
| either strip carries 2+ nets | — | `refuse`: `that strip already joins two nets` |
| a === b strip | — | `refuse`: `both ends are in the same strip` |

- [ ] **Step 1: Failing tests** (append to `test/placement.test.ts`, using the file's existing doc/design fixture helpers — read the top of the file and reuse its builder; the sketch below assumes one called `fixture()` returning `{ doc, design }` with R1 legs at `a5` (net `/A`) and `a10` (net `/B`), and an unconnected R2 leg at `c20`. Adapt names to the real fixture, or add a small one built with the same helpers.)

```ts
describe('legsToConnections', () => {
  test('a leg in a strip with a net joins it; a leg in an empty strip stays unconnected', () => {
    const { doc, design } = fixture();
    expect(legsToConnections(doc, design, { '1': { col: 5, row: 'c' }, '2': { col: 30, row: 'c' } })).toEqual({ '1': '/A' });
  });
});

describe('jumperOutcome', () => {
  test('two different nets are refused', () => {
    const { doc, design } = fixture();
    expect(jumperOutcome(doc, design, { col: 5, row: 'e' }, { col: 10, row: 'e' })).toEqual({ kind: 'refuse', reason: 'would join A and B. Merge nets in the schematic' });
  });
  test('an unconnected leg joins the net at the other end', () => {
    const { doc, design } = fixture();
    expect(jumperOutcome(doc, design, { col: 20, row: 'e' }, { col: 5, row: 'e' })).toEqual({ kind: 'connect', net: '/A', pins: [{ ref: 'R2', pin: '1' }] });
  });
  test('the same net twice changes nothing in the schematic', () => {
    const { doc, design } = fixture();
    expect(jumperOutcome(doc, design, { col: 5, row: 'b' }, { col: 5, row: 'j' })).toMatchObject({ kind: 'same', net: '/A' });
  });
  test('two empty strips: nothing to connect', () => {
    const { doc, design } = fixture();
    expect(jumperOutcome(doc, design, { col: 40, row: 'b' }, { col: 45, row: 'b' })).toEqual({ kind: 'refuse', reason: 'nothing to connect yet. Place a part first' });
  });
});
```

(`b5`–`e5` and `f5`–`j5` are different strips; pick holes so the "same net" case really has `/A` on both strips in the fixture, e.g. a second `/A` leg across the channel.)

Run: `bun test test/placement.test.ts` — Expected: FAIL (not exported).

- [ ] **Step 2: Implement** (append to `src/edit/placement.ts`; import `displayName` from `../netlist.ts` and `stripOf` is already imported)

```ts
const unconnected = (net: string) => !net || net.startsWith('unconnected-');

/** Pin -> net for each leg of a new part whose strip already carries exactly one net. */
export function legsToConnections(doc: LayoutDoc, design: Design, holes: Record<string, Hole>): Record<string, string> {
  const nets = stripNets(doc, design, null);
  const out: Record<string, string> = {};
  for (const [pin, h] of Object.entries(holes)) {
    const s = [...(nets.get(stripOf(h)) ?? [])].filter((n) => !unconnected(n));
    if (s.length === 1) out[pin] = s[0];
  }
  return out;
}

export type JumperOutcome = { kind: 'connect'; net: string; pins: { ref: string; pin: string }[] } | { kind: 'same'; net: string } | { kind: 'refuse'; reason: string };

/** What a jumper from `a` to `b` would do to the schematic (spec 6.3). */
export function jumperOutcome(doc: LayoutDoc, design: Design, a: Hole, b: Hole): JumperOutcome {
  const sa = stripOf(a);
  const sb = stripOf(b);
  if (sa === sb) return { kind: 'refuse', reason: 'both ends are in the same strip' };
  const all = stripNets(doc, design, null);
  const netsOf = (s: string) => [...(all.get(s) ?? [])].filter((n) => !unconnected(n));
  const loose = (s: string) => {
    const out: { ref: string; pin: string }[] = [];
    for (const [ref, pins] of Object.entries(doc.pinHoles)) for (const [pin, h] of Object.entries(pins)) if (stripOf(h) === s && unconnected(design.components.get(ref)?.pins.get(pin)?.net ?? '')) out.push({ ref, pin });
    return out;
  };
  const [na, nb] = [netsOf(sa), netsOf(sb)];
  if (na.length > 1 || nb.length > 1) return { kind: 'refuse', reason: 'that strip already joins two nets' };
  if (na.length && nb.length) return na[0] === nb[0] ? { kind: 'same', net: na[0] } : { kind: 'refuse', reason: `would join ${displayName(na[0])} and ${displayName(nb[0])}. Merge nets in the schematic` };
  const [net, pins] = na.length ? [na[0], loose(sb)] : nb.length ? [nb[0], loose(sa)] : [null, []];
  if (!net) return { kind: 'refuse', reason: 'nothing to connect yet. Place a part first' };
  if (!pins.length) return { kind: 'refuse', reason: 'nothing to connect yet. Place a part first' };
  return { kind: 'connect', net, pins };
}
```

- [ ] **Step 3: Run and commit**

Run: `bun test test/placement.test.ts && bun run typecheck` — Expected: PASS.

```bash
git add src/edit/placement.ts test/placement.test.ts
git commit -m "feat(3d): which nets a dropped part joins and what a jumper does"
```

---

### Task 5: Client API and the Board3D ghost

**Files:**
- Modify: `client/api.ts`, `client/board3d.ts` (interface :158-221 and the implementation returned by `mount3d`)
- Test: `test/board3d.test.ts` (only if it already mounts `mount3d` headlessly; otherwise covered by e2e in Task 6)

**Interfaces:**
- Produces (client/api.ts, inside `api`):
  - `parts: () => get<PartAlias[]>('/api/parts')`
  - `footprint: (part: string) => get<PartFootprint>(\`/api/parts/footprint?part=${encodeURIComponent(part)}\`)` with `export interface PartFootprint { alias: string; libId: string; value: string; pins: string[]; footprint: Footprint }`
  - `editAdd: (id: string, body: { part: string; value?: string; connections?: Record<string, string> }) => post<{ ok: true; ref: string; backup: string; notes: string[] }>(\`/api/projects/${id}/edit/add\`, body)`
  - `editConnect: (id: string, ref: string, pin: string, net: string) => post<unknown>(\`/api/projects/${id}/edit/connect\`, { ref, pin, net })`
  (Use the file's existing `get`/`post` helpers; if there is no `get`, follow how `layout(id)` fetches.)
- Produces (Board3D): `setGhost(g: { holes: Hole[]; footprint: 'lead2' | 'dip' | 'other'; ok: boolean } | null): void` — a translucent stand-in at those holes: for `lead2` a capsule between the two holes; for `dip` a box over the leg rectangle; for `other` a small sphere per hole. Green-tinted when `ok`, red when not. One shared material pair, geometry rebuilt per call, removed on `null` and on `rebuild`/`dispose`.

- [ ] **Step 1: Add the API functions** exactly as above. Import `PartAlias` from `../src/parts/aliases.ts` and `Footprint` from `../src/parts/catalog.ts`.

- [ ] **Step 2: Add `setGhost` to the `Board3D` interface** (doc comment: "A translucent stand-in for a part not on the board yet: the tray's drop preview.") and implement it in `mount3d`:

```ts
  const ghostMat = { ok: new THREE.MeshStandardMaterial({ color: '#4ade80', transparent: true, opacity: 0.45, depthWrite: false }), bad: new THREE.MeshStandardMaterial({ color: '#f87171', transparent: true, opacity: 0.45, depthWrite: false }) };
  let ghost: THREE.Group | null = null;
  const clearGhost = () => {
    if (!ghost) return;
    scene.remove(ghost);
    ghost.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    ghost = null;
  };
  function setGhost(g: { holes: Hole[]; footprint: 'lead2' | 'dip' | 'other'; ok: boolean } | null) {
    clearGhost();
    if (!g || !g.holes.length) return;
    ghost = new THREE.Group();
    const mat = g.ok ? ghostMat.ok : ghostMat.bad;
    const pts = g.holes.map((h) => at(h, TOP + 6));
    if (g.footprint === 'lead2' && pts.length === 2) {
      const len = pts[0].distanceTo(pts[1]);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(6, Math.max(1, len - 12), 4, 12), mat);
      body.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
      body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pts[1].clone().sub(pts[0]).normalize());
      ghost.add(body);
    } else if (g.footprint === 'dip') {
      const box = new THREE.Box3().setFromPoints(pts);
      const size = box.getSize(new THREE.Vector3());
      const body = new THREE.Mesh(new THREE.BoxGeometry(size.x + 12, 10, size.z + 6), mat);
      body.position.copy(box.getCenter(new THREE.Vector3())).setY(TOP + 8);
      ghost.add(body);
    } else for (const p of pts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), mat);
      s.position.copy(p);
      ghost.add(s);
    }
    scene.add(ghost);
    requestRender(); // use whatever the file calls to schedule a frame (see how setStripTint does it)
  }
```

Call `clearGhost()` at the start of `rebuild` and in `dispose` (and dispose both `ghostMat` materials in `dispose`). Return `setGhost` on the object `mount3d` returns. `at` is `holeX/holeZ` based and already tier-aware after the merge (`setHoleBoard`).

- [ ] **Step 3: Typecheck and commit**

Run: `bun run typecheck && bun test` — Expected: clean.

```bash
git add client/api.ts client/board3d.ts
git commit -m "feat(3d): client calls for adding parts and a drop ghost on the board"
```

---

### Task 6: The parts tray and dropping a part

**Files:**
- Create: `client/editor3d/tray.ts`
- Modify: `client/editor3d/workspace.ts` (tray markup :54, attach after `attachCard` :173), `client/styles.css` (`.ws-tray` block)
- Test: `scripts/e2e-3d.ts` (scenarios)

**Interfaces:**
- Consumes: `api.parts`, `api.footprint`, `api.editAdd`, `api.move` (Task 5); `holeNear`, `defaultHoles` (Task 3); `legsToConnections`, `validatePlacement` (Task 4, placement.ts:76 with the `netOf` override); `partIcon` (`client/part-icons.ts`); `ws.board.boardPoint`, `setStripTint`, `setGhost`; `addKeyHandler`; `loadProject` (`client/main.ts:38`); `store`, `toast`.
- Produces: `export function attachTray(ws: Workspace): () => void`.

Behaviour (spec §6.1-6.2):
- The tray replaces the "coming in phase 3" span: a search box (focused with **/**), group chips **Basic · Passives · Indicators · Inputs · Logic · All**, and a row of tiles. Basic = resistor, LED, capacitor, push button, 7-position DIP switch, 74LS00, 74LS04, 74LS08, 74LS32, 74LS86, 74LS283, 74LS47 (whichever of these exist in `PART_ALIASES`). Group by `libId`: `Device:R|C|L|…` Passives; `Device:LED*` and `Display_Character:*` Indicators; `Switch:*` Inputs; `74xx:*` Logic; power symbols never shown.
- Each tile shows `partIcon(iconFor(alias), resistorKind, () => 'red')` and the alias name. `iconFor` maps a `PartAlias` to the `PartIcon` union from `src/guide.ts` (`74xx:*` → chip with pins from the footprint once fetched, defaulting to 14; `Switch:SW_DIP_x0N` → dipswitch N; `Device:R*` → resistor with the default value; `Device:LED*` → led; display → sevenseg; else `{ kind: 'part', style: alias.alias.slice(0, 3) }`).
- **Drag:** `pointerdown` on a tile → `setPointerCapture`, fetch (and cache) `api.footprint(alias)`, show a DOM ghost (the tile's icon) following the pointer. While over the canvas (`board.boardPoint(e)` non-null), hide the DOM ghost and compute `at = holeNear(doc.board, pt)`, `holes = defaultHoles(fp.footprint, fp.pins, at, doc.board)`; if `holes` is null → `setGhost({ holes: at ? [at] : [], footprint: 'other', ok: false })` and hint `can't go here: <reason>`; else run `validatePlacement(doc, design, 'NEW?', holes, () => '')` and show `setGhost({ holes: Object.values(holes), footprint: fp.footprint.kind === 'lead2' ? 'lead2' : fp.footprint.kind === 'dip' || fp.footprint.kind === 'dipswitch' ? 'dip' : 'other', ok: verdict.ok })` and `setStripTint(verdict.tints)`. Only recompute when `at` changes.
- **Tap to arm:** a click (pointer up within 4 px of down, on the tile) arms the part: tile gets `.is-armed`, hint `click a hole to place <alias> · Esc cancels`; pointer moves over the canvas show the same ghost; a click on the canvas drops. Esc, the same tile again, or another tool disarms. While armed, the tray's canvas listeners are added with `capture: true` and `stopImmediatePropagation()` so selection does not fire.
- **Drop flow** (on release over a valid spot, or the armed click):
  1. `setGhost(null)`, `setStripTint([])`.
  2. `const connections = legsToConnections(doc, design, holes)`.
  3. `const added = await api.editAdd(p.id, { part: alias, connections })` — on error toast `Not added: <message>` and stop.
  4. `try { await api.move(p.id, added.ref, holes) } catch (e) { toast(\`${added.ref} added, but not at that spot: ${message}. The board placed it.\`) }`
  5. `await loadProject(p.id)`, then `store.setProject({ selectedRef: added.ref })`; the card opens via the existing selection path. Focus its value input (`.ws-card input`) for parts that have a value.
  6. Parts whose `defaultHoles` is null by kind (display, module) are added without step 4, with hint "placed automatically".
- Esc while dragging or armed: cancel, `setGhost(null)`, `setStripTint([])`, restore the hint.

- [ ] **Step 1: Write the e2e scenarios first** (in `scripts/e2e-3d.ts`, inside `SCENARIOS`, following the existing scenarios' style and the `window.__e3d` hooks; add hooks to `workspace.ts:316-353` if needed: `armPart(alias)`, `ghostCount()` returning the number of meshes in the ghost group, `selectedRef()`):

  - `'dropping a resistor from the tray adds it to the schematic on those holes'` — open 3D on the PL1_1 fixture, arm `resistor` (the alias used in Task 2), dispatch a click at the screen point of an empty hole (use `board.project` on `placeAt(...)` via a hook), wait for the doc to change, assert a new `R?` ref exists in `doc.pinHoles` with legs at the expected holes and that it is selected.
  - `'Esc disarms and clears the ghost'` — arm, move over the board (ghost count > 0), press Esc, assert ghost count 0 and no `.is-armed` tile.
  - `'a refused move after add still leaves the part placed'` — arm a DIP chip and drop with the pointer on row `b` (no default holes) → assert nothing was added (refused before add); then arm a chip and drop on `f` where a leg would land on an existing leg → assert the verdict refused and nothing was added. (The server-refuses-after-add path is exercised by stubbing `api.move` to throw through a hook: `__e3d.failNextMove()`; assert the part exists and a toast mentions "not at that spot".)

Run: `bun run build && bun scripts/e2e-3d.ts "dropping a resistor"` — Expected: FAIL (no tray).

- [ ] **Step 2: Implement `client/editor3d/tray.ts`** per the behaviour above. Keep the pure decisions in `src/edit/*` (already tested); the tray only wires events to them. Structure:

```ts
export function attachTray(ws: Workspace): () => void {
  const tray = ws.root.querySelector<HTMLElement>('.ws-tray')!;
  let parts: PartAlias[] = [];
  let group = 'Basic';
  let query = '';
  const cache = new Map<string, Promise<PartFootprint>>();
  const fpOf = (alias: string) => cache.get(alias) ?? (cache.set(alias, api.footprint(alias)), cache.get(alias)!);
  let armed: { alias: string; fp: PartFootprint } | null = null;
  let current: { at: Hole; holes: Record<string, Hole> | null; ok: boolean } | null = null;
  // render(), preview(e), drop(), disarm(), the pointer listeners on tiles and on ws.board.dom,
  // and an addKeyHandler for '/' (focus search) and 'Escape' (disarm) — returning true when handled.
  …
  return () => { /* remove listeners, key handler, setGhost(null) */ };
}
```

Write the full bodies; every branch of the behaviour list above maps to one function. Mount it in `workspace.ts` after `attachCard(ws)` and include its disposer in the workspace's close path (follow how `attachCard`'s disposer is kept).

- [ ] **Step 3: Styles.** In `client/styles.css`, after the `.ws-tray` rule: `.ws-tray input[type=search]` (dark field matching `.ws-card input`), `.ws-chip` (pill like `.ws-legend span[data-legend]`, `.is-on` highlighted), `.ws-tile` (column: icon above a 11px label, 72px wide, rounded, hover lift, `.is-armed` outline `#4da3ff`), and `.ws-drag-ghost` (fixed, pointer-events none, 0.85 opacity). Remove `.ws-tray-soon`.

- [ ] **Step 4: Run** `bun run typecheck && bun test && bun run build && bun scripts/e2e-3d.ts` — Expected: all scenarios PASS, including the three new ones and every existing one.

- [ ] **Step 5: Commit**

```bash
git add client/editor3d/tray.ts client/editor3d/workspace.ts client/styles.css scripts/e2e-3d.ts
git commit -m "feat(3d): parts tray with search and groups; drag or tap a part onto the board"
```

---

### Task 7: The wire tool

**Files:**
- Create: `client/editor3d/wiretool.ts`
- Modify: `client/editor3d/workspace.ts` (toolbar button `data-ws="wire"`, attach), `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `holeNear` (Task 3), `jumperOutcome` (Task 4), `api.editConnect` (Task 5), `board.boardPoint`, `setStripTint`, `setWirePreview` is **not** used (it previews existing wires only); the preview is a two-hole `setGhost({ holes: [a, b], footprint: 'lead2', ok })`.
- Produces: `export function attachWireTool(ws: Workspace): () => void`.

Behaviour (spec §6.3, **proposed simplification, needs the user's OK before Task 7:** no clicked bends while drawing — the router lays the jumper and hand-shaping stays in the wire card):
- **W** or the toolbar **Wire** button toggles the tool (button `.is-on`, hint `click a hole to start a jumper · Esc cancels`).
- First click on a hole sets `a`; moving shows `setGhost({ holes: [a, holeNear(...)], footprint: 'lead2', ok })` with `ok = jumperOutcome(...).kind !== 'refuse'` and the hint showing the outcome (`joins N`, `already on N`, or the refusal reason). Press-drag-release works the same (down = `a`, up = `b`).
- Second click / release:
  - `connect` → `for (const { ref, pin } of outcome.pins) await api.editConnect(p.id, ref, pin, outcome.net)`, then `loadProject(p.id)`; toast `joined N`.
  - `same` → toast `already connected: the router lays that jumper` (no schematic change; the engine owns jumpers).
  - `refuse` → toast the reason; nothing changes.
- Esc or right-click cancels; the tool stays on until W/Esc pressed with no jumper in progress.

- [ ] **Step 1: e2e scenarios first:** `'the wire tool joins an unconnected leg to a net'` (drop a resistor with one leg in an empty strip via the tray hook, then wire from that strip to a strip carrying a net; assert the resistor pin's net changed in `design`), `'the wire tool refuses to join two nets'` (assert a toast containing "Merge nets in the schematic" and no doc change). Run — FAIL.
- [ ] **Step 2: Implement** `wiretool.ts` with the listeners on `ws.board.dom` in the capture phase (only while the tool is on; call `board.setOrbit(false)` during a press-drag and `true` after), an `addKeyHandler` for `w`/`W` and `Escape`, and mount it in `workspace.ts` next to the tray. Add `wire` to the toolbar `[data-ws]` switch (:235).
- [ ] **Step 3: Run** `bun run typecheck && bun test && bun run build && bun scripts/e2e-3d.ts` — PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(3d): wire tool: join an unconnected leg to a net, refuse merging nets"`

---

### Task 8: Duplicate (and Delete from the keyboard, confirmed)

**Files:**
- Create: `client/editor3d/duplicate.ts`
- Modify: `client/editor3d/card.ts` (footer button `data-card="duplicate"`), `client/editor3d/workspace.ts` (attach), `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `api.editAdd`, `api.move`, `defaultHoles`-free logic: shift the original's holes right with `shiftHoles(orig, k * P, 0, board, true)` (`client/drag.ts:22`) for `k = 1…20`, taking the first `k` where `validatePlacement(doc, design, 'NEW?', shifted, () => '')` is ok.
- Produces: `export async function duplicatePart(ref: string): Promise<string | null>` (returns the new ref) and `export function attachDuplicate(ws: Workspace): () => void` (the **D** key).

Steps:
- [ ] **Step 1: e2e first:** `'D duplicates the selected resistor to the right'` — select R1 in the fixture, press D, assert a new ref with the same lib/value whose legs are R1's shifted right by the smallest free offset, and that the new part is selected. Run — FAIL.
- [ ] **Step 2: Implement** `duplicatePart`: find the alias for the part (`PART_ALIASES` by `libId === \`${comp.lib}:${comp.part}\``; if none, toast `can't duplicate ${ref}: no tray part for ${lib}:${part}` and return null), `editAdd({ part: alias.alias, value: comp.value, connections: {} })`, then `move` to the first free shifted spot (if none, leave it to the engine and toast "placed automatically"), `loadProject`, select it. Wire **D** via `addKeyHandler` (only when a part is selected and no input is focused) and the card's new Duplicate button.
- [ ] **Step 3:** Delete already confirms via the card (workspace.ts:174-183). Add e2e `'Delete then confirm removes the part'` if not already covered (check the existing scenario list first; spec §6.4).
- [ ] **Step 4: Run** all checks and e2e — PASS. **Commit** `git commit -m "feat(3d): duplicate a part with D or from its card"`

---

### Task 9: Documentation

**Files:** `docs/editor3d.md`, `circut-ai-tool/README.md` (3D editor paragraph), spec §10 deliverables.

- [ ] **Step 1:** In `docs/editor3d.md` add sections **Adding parts** (tray, search with `/`, groups, drag or tap-to-arm, what a drop does to the schematic and the backup, which parts are placed automatically), **Drawing a jumper** (W, the outcome table in plain words, why two nets are refused), **Duplicate and delete**; update **Shortcuts** (`/`, W, D, Esc), **What changes what** (tray drop and wire tool edit the schematic; they are not on Ctrl+Z — the backup is), **Coming next** (phase 4: high-fidelity models, 3D thumbnails), and note stacked boards now get clean wires.
- [ ] **Step 2:** One-paragraph update in README's "3D editor" section.
- [ ] **Step 3:** Commit `git commit -m "docs(3d): tray, wire tool, duplicate"`

---

## Self-review notes

- Spec §6.1 tray: Task 6 (thumbnails deviation recorded in Global Constraints). §6.2 adding: Tasks 2, 3, 4, 5, 6. §6.3 wire tool: Tasks 4, 7 (bends while drawing dropped; hand-shaping stays in the wire card — recorded in Task 7). §6.4 duplicate/delete: Task 8. §7 errors: toasts in Tasks 6-8, refusals before any server call. §9 testing: unit tests in Tasks 1-4, e2e in 6-8. §10 docs: Task 9.
- Names used across tasks: `holeNear`, `defaultHoles`, `componentFromSymbol`, `legsToConnections`, `jumperOutcome`, `JumperOutcome`, `PartFootprint`, `setGhost`, `attachTray`, `attachWireTool`, `attachDuplicate`, `duplicatePart` — each defined once, in the task that produces it.
