# 3D Editor Phase 1 (Workspace and Part Manipulation): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 3D button into a full-screen workspace where you can select a part, which is outlined in 3D. You can then drag it to new holes with snapping and a live validity tint, rotate or flip it, edit its value or delete it from a floating card, fly the camera to it, and undo layout changes.

**Architecture:**
- **Pure rules.** Placement validity, rotate/flip hole maps, framing maths and the undo stack live in DOM-free modules (`src/edit/placement.ts`, `client/editor3d/focus-math.ts`, `client/editor3d/history.ts`) with bun unit tests.
- **Scene.** `client/board3d.ts` is refactored so its doc-dependent content can be rebuilt in place (`rebuild(doc)`). It also gains picking, outline, nudge, strip-tint and focus methods.
- **Workspace.** A new full-screen shell (`client/editor3d/workspace.ts`) owns the pointer and keyboard and drives those methods.
- **Server and 3D stay in step.** Layout changes go through the existing `api.move`, and schematic changes through the existing `/edit/*` endpoints followed by `loadProject`.

**Tech Stack:** TypeScript (strict), Bun test runner, three.js 0.185 (`three/examples/jsm/*`), Vite client build, Hono server, headless Chrome over CDP for end-to-end checks.

**Spec:** `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md` (§3, §4, §7, §9, §10). Phases 2 (clean wires) and 3 (tray and building) get their own plans after this one lands.

**Working directory for every command:** `C:\Users\rober\Desktop\university-tools\.worktrees\editor3d\circut-ai-tool` (branch `editor3d`).

## Global Constraints

- Every change must keep `bun test` and `bun run typecheck` green. The baseline is 303 passing tests.
- Pure modules (`src/edit/*`, `client/editor3d/history.ts`, `client/editor3d/focus-math.ts`) must not import `three`, touch `document` or touch `window`.
- Layout-only changes go through `api.move` (`POST /api/projects/:id/layout/move`). Schematic changes go through `/api/projects/:id/edit/*`, and the client then calls `loadProject(id)`.
- Never use `window.confirm`, `alert` or `prompt`. Confirmation happens inside the card.
- Commit messages have **no** `Co-Authored-By`, `Claude-Session` or "Generated with" footer (a standing user rule).
- Code style follows the surrounding files: two-space indentation, single quotes, explanatory `//` comments that say *why*, and no semicolon-free style changes.
- Editor shortcuts are ignored while fly mode is on or while an `input`, `textarea`, `select` or contentEditable element has focus.

## Spec clarifications made while planning

1. **The amber "join" tint is for new parts only (phase 3).**
   - Spec §4.3 said an *existing* part's leg that lands in a strip carrying another net would show amber, "joins /A".
   - But an existing part's pins already have nets in the schematic. Landing in a strip that carries a *different* net shorts two nets, so for moves that case is **bad** (red) and is refused.
   - `join` is produced only for pins with no net yet, which happens when dropping from the tray in phase 3. `validatePlacement` already supports this.
2. **F keeps doing its old job when nothing is selected.**
   - `board3d.ts` currently uses **F** to toggle fly mode.
   - New rule: **F** focuses the selected part when one is selected. With nothing selected it toggles fly as before, and in fly mode it returns to orbit.
   - This is implemented in the workspace key router (Task 4), and `board3d.ts`'s own F handler is removed (Task 3).
3. **Flipping a chip needs engine and renderer support.**
   - The engine's `Package` records only `col0`, and both renderers always draw pin 1 at the left.
   - Task 2 adds `Package.flipped` (set when pin 1 sits in row `e`) and teaches both renderers to draw the notch and the pin 1 dimple at the right end.

## Review Focus

These are the failure modes most likely to bite a user that no single task's happy-path test covers. Each line names the task whose tests pin it.

1. **Moving a part so one leg shares a strip with a different net** must be refused with the net names, not silently shorted (Task 1 test "refuses a leg that would short two nets").
2. **Rotating a two-lead part into its own strip** (a vertical resistor within one half) must be refused as a self-short, not saved (Task 1 test "a vertical part inside one half shorts itself").
3. **Reopening 3D after the doc changed while closed**, or an edit landing while a drag is in progress, must never leave a detached renderer or a ghost part. A store update mid-drag is ignored until release (Task 6 e2e "store update mid-drag").
4. **Undo after a server refusal.** A failed `api.move` must not push a history entry, so Ctrl+Z never "undoes" a move that never happened (Task 7 test "a failed run is not recorded").
5. **The card for a part that was deleted or re-numbered by a reload** must close rather than point at a missing object (Task 8 e2e "card closes when its part disappears").

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/edit/placement.ts` | create | Pure: strip nets, taken holes, `validatePlacement`, `rotateLead2`, `flipDip` |
| `test/placement.test.ts` | create | Unit tests for the above |
| `src/layout/types.ts` | modify | `Package.flipped?: boolean` |
| `src/layout/engine.ts` | modify | Set `flipped` for a DIP pinned with pin 1 in row `e` |
| `src/render/index.ts` | modify | 2D DIP notch and dimple at the right end when flipped |
| `client/board3d-parts.ts` | modify | 3D chip marking rotated 180° when flipped |
| `test/flip.test.ts` | create | Engine and render tests for flipped DIPs |
| `client/board3d.ts` | modify | Rebuildable content, `userData.ref`, pick layers, new Board3D methods, remove the F key |
| `client/editor3d/focus-math.ts` | create | Pure: `frameBox`, `easeOutCubic` |
| `test/focus-math.test.ts` | create | Unit tests |
| `client/editor3d/history.ts` | create | Pure: undo/redo command stack |
| `test/history.test.ts` | create | Unit tests |
| `client/editor3d/workspace.ts` | create | Full-screen shell: toolbar, legend, key routing, store sync, e2e hook |
| `client/editor3d/manipulate.ts` | create | Select, hover, drag-to-move, rotate/flip commands |
| `client/editor3d/card.ts` | create | Floating part card: value, pins, actions, delete confirm |
| `client/view3d.ts` | modify | Becomes a thin open/close wrapper around the workspace |
| `client/panels.ts` | modify | The 3D button opens the workspace (no card argument) |
| `client/api.ts` | modify | `editValue`, `editRemove` |
| `client/state.ts` | modify | `ProjectState.selectedRef: string \| null` |
| `client/main.ts` | modify | `selectedRef: null` in `loadProject` |
| `client/board.ts` | modify | Flat board highlights `selectedRef` when nothing else is highlighted |
| `client/styles.css` | modify | `.ws*` workspace styles; toast above the workspace |
| `scripts/e2e-3d.ts` | create | Headless Chrome (CDP) end-to-end scenarios |
| `docs/editor3d.md` | create | Human guide |
| `AGENTS.md`, `CLAUDE.md` | create | LLM guide and pointer |
| `README.md` | modify | "3D editor" section |

---

### Task 1: Placement rules (pure)

**Files:**
- Create: `src/edit/placement.ts`
- Test: `test/placement.test.ts`

**Interfaces:**
- Consumes: `stripOf`, `isRail` from `src/layout/board.ts`; `LayoutDoc` from `src/pipeline.ts`; `Design` from `src/netlist.ts`.
- Produces:
  ```ts
  export type Tone = 'ok' | 'join' | 'bad';
  export interface Tint { hole: Hole; tone: Tone; label?: string }
  export interface Verdict { ok: boolean; reason: string | null; tints: Tint[] }
  export const ROW_ORDER: Row[];
  export function inBoard(h: Hole, board: BoardSpec): boolean;
  export function stripNets(doc: LayoutDoc, design: Design, except: string | null): Map<string, Set<string>>;
  export function takenHoles(doc: LayoutDoc, except: string | null): Map<string, string>;
  export function validatePlacement(doc: LayoutDoc, design: Design, ref: string, holes: Record<string, Hole>, netOf?: (pin: string) => string): Verdict;
  export function rotateLead2(holes: Record<string, Hole>, pins: [string, string]): Record<string, Hole> | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/placement.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { stripOf } from '../src/layout/board.ts';
import type { Hole, Row } from '../src/layout/types.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { inBoard, rotateLead2, stripNets, takenHoles, validatePlacement } from '../src/edit/placement.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const doc = buildLayoutDoc(design, emptySidecar());
const part = doc.parts.find((p) => p.kind === 'lead2')!;
const here = doc.pinHoles[part.id];

/** A column whose top-half strip is empty of every leg and every net. */
function emptyTopColumn(): number {
  const nets = stripNets(doc, design, null);
  for (let c = doc.board.cols - 1; c > 1; c--) if (!nets.has(`T${c}`)) return c;
  throw new Error('fixture board has no empty column');
}

describe('inBoard', () => {
  test('knows the edges and the gaps in the rails', () => {
    expect(inBoard({ col: 1, row: 'a' }, doc.board)).toBe(true);
    expect(inBoard({ col: 0, row: 'a' }, doc.board)).toBe(false);
    expect(inBoard({ col: doc.board.cols + 1, row: 'j' }, doc.board)).toBe(false);
    expect(inBoard({ col: doc.board.railGapEvery, row: 'T+' }, doc.board)).toBe(false);
  });
});

describe('stripNets and takenHoles', () => {
  test('a part moved out of the way no longer counts against itself', () => {
    const [pin, h] = Object.entries(here)[0];
    expect(takenHoles(doc, null).get(`${h.row}${h.col}`)).toBe(part.id);
    expect(takenHoles(doc, part.id).has(`${h.row}${h.col}`)).toBe(false);
    const net = design.components.get(part.id)!.pins.get(pin)!.net;
    const without = stripNets(doc, design, part.id).get(stripOf(h));
    // The strip may still carry the net through another part, but never only through this one.
    const others = Object.entries(doc.pinHoles).filter(([r]) => r !== part.id).some(([, pins]) => Object.values(pins).some((o) => stripOf(o) === stripOf(h)));
    if (!others) expect(without?.has(net) ?? false).toBe(false);
  });
});

describe('validatePlacement', () => {
  test('where it already is, is fine', () => {
    const v = validatePlacement(doc, design, part.id, here);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.tints.every((t) => t.tone === 'ok')).toBe(true);
  });

  test('off the board is refused with the pin named', () => {
    const [pin] = Object.keys(here);
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: { col: 0, row: 'a' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('off the board');
    expect(v.tints.find((t) => t.hole.col === 0)?.tone).toBe('bad');
  });

  test('a hole another part uses is refused, naming that part', () => {
    const other = doc.parts.find((p) => p.id !== part.id)!;
    const theirs = doc.pinHoles[other.id][other.pins[0]];
    const [pin] = Object.keys(here);
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: theirs });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(other.id);
  });

  test('refuses a leg that would short two nets', () => {
    // Put pin 1 into a free hole of a strip that carries some other net.
    const pin = part.pins[0];
    const net = design.components.get(part.id)!.pins.get(pin)!.net;
    const nets = stripNets(doc, design, part.id);
    const taken = takenHoles(doc, part.id);
    let target: Hole | null = null;
    for (const [ref, pins] of Object.entries(doc.pinHoles)) {
      if (ref === part.id || target) continue;
      for (const h of Object.values(pins)) {
        const carried = nets.get(stripOf(h));
        if (!carried || carried.has(net) || h.row.length === 2) continue;
        const rows: Row[] = 'abcde'.includes(h.row) ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
        const free = rows.map((row) => ({ col: h.col, row })).find((o) => !taken.has(`${o.row}${o.col}`));
        if (free) target = free;
        if (target) break;
      }
    }
    expect(target).not.toBeNull();
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: target! });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short');
  });

  test('a vertical part inside one half shorts itself', () => {
    const c = emptyTopColumn();
    const [p1, p2] = part.pins;
    const n1 = design.components.get(part.id)!.pins.get(p1)!.net;
    const n2 = design.components.get(part.id)!.pins.get(p2)!.net;
    expect(n1).not.toBe(n2);
    const v = validatePlacement(doc, design, part.id, { [p1]: { col: c, row: 'a' }, [p2]: { col: c, row: 'd' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short each other');
  });

  test('a new part (no nets yet) joining a strip gets the amber tone, not a refusal', () => {
    const other = doc.parts.find((p) => p.id !== part.id)!;
    const theirs = doc.pinHoles[other.id][other.pins[0]];
    const rows: Row[] = 'abcde'.includes(theirs.row) ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
    const taken = takenHoles(doc, null);
    const free = rows.map((row) => ({ col: theirs.col, row })).find((o) => !taken.has(`${o.row}${o.col}`))!;
    const c = emptyTopColumn();
    const v = validatePlacement(doc, design, 'R_NEW', { '1': free, '2': { col: c, row: 'a' } }, () => '');
    expect(v.ok).toBe(true);
    expect(v.tints[0].tone).toBe('join');
    expect(v.tints[0].label).toBeTruthy();
  });

  test('a chip must straddle the channel', () => {
    const chip = doc.packages.find((p) => p.kind === 'dip')!;
    const holes = Object.fromEntries(Object.entries(doc.pinHoles[chip.id]).map(([pin, h]) => [pin, { col: h.col, row: (h.row === 'e' ? 'd' : h.row) as Row }]));
    const v = validatePlacement(doc, design, chip.id, holes);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('straddle');
  });
});

describe('rotateLead2', () => {
  test('a quarter turn clockwise about pin 1 carries a row-e part across the channel', () => {
    const r = rotateLead2({ '1': { col: 10, row: 'e' }, '2': { col: 13, row: 'e' } }, ['1', '2'])!;
    expect(r['1']).toEqual({ col: 10, row: 'e' });
    expect(r['2']).toEqual({ col: 10, row: 'h' });
  });

  test('four quarter turns come home', () => {
    let h: Record<string, Hole> | null = { '1': { col: 20, row: 'f' }, '2': { col: 20, row: 'c' } };
    for (let i = 0; i < 4; i++) h = rotateLead2(h!, ['1', '2']);
    expect(h).toEqual({ '1': { col: 20, row: 'f' }, '2': { col: 20, row: 'c' } });
  });

  test('a turn that leaves the rows gives null', () => {
    expect(rotateLead2({ '1': { col: 10, row: 'j' }, '2': { col: 14, row: 'j' } }, ['1', '2'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `bun test test/placement.test.ts`
Expected: FAIL with `Cannot find module '../src/edit/placement.ts'`.

- [ ] **Step 3: Implement `src/edit/placement.ts`**

```ts
// Pure rules for putting a part's legs into breadboard holes: which holes are
// taken, what a leg would short or join, and where a quarter turn puts a
// two-lead part. No DOM and no three, so every rule is a unit test away and
// the 3D editor, the tray and any future MCP tool all judge a placement the
// same way.

import { isRail, stripOf } from '../layout/board.ts';
import type { BoardSpec, Hole, Row } from '../layout/types.ts';
import type { Design } from '../netlist.ts';
import type { LayoutDoc } from '../pipeline.ts';

export type Tone = 'ok' | 'join' | 'bad';
export interface Tint {
  hole: Hole;
  tone: Tone;
  /** The net a 'join' leg would join, or the net a 'bad' leg would short to. */
  label?: string;
}
export interface Verdict {
  ok: boolean;
  /** The first reason the placement is refused, in words a user can act on. */
  reason: string | null;
  tints: Tint[];
}

/** Every row top to bottom, so a turn can be done in whole row steps. */
export const ROW_ORDER: Row[] = ['T+', 'T-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'B-', 'B+'];

const short = (net: string) => net.split('/').filter(Boolean).pop() ?? net;
const name = (h: Hole) => `${h.row}${h.col}`;

export function inBoard(h: Hole, board: BoardSpec): boolean {
  if (h.col < 1 || h.col > board.cols) return false;
  return !(isRail(h.row) && h.col % board.railGapEvery === 0);
}

/**
 * The nets each strip already carries: from every leg on the board except
 * those of `except`, and from the supply leads on the rails. Wires are left
 * out on purpose: the engine re-routes them after any move, so a jumper
 * landing in a strip today says nothing about where it will land tomorrow.
 */
export function stripNets(doc: LayoutDoc, design: Design, except: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (h: Hole, net: string) => {
    if (!net) return;
    const k = stripOf(h);
    let s = out.get(k);
    if (!s) out.set(k, (s = new Set()));
    s.add(net);
  };
  for (const [ref, pins] of Object.entries(doc.pinHoles)) {
    if (ref === except) continue;
    const comp = design.components.get(ref);
    for (const [pin, h] of Object.entries(pins)) add(h, comp?.pins.get(pin)?.net ?? '');
  }
  for (const lead of doc.supply?.leads ?? []) add(lead.hole, lead.net);
  return out;
}

/** Hole name -> the part whose leg is in it, for every part but `except`. */
export function takenHoles(doc: LayoutDoc, except: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, pins] of Object.entries(doc.pinHoles)) {
    if (ref === except) continue;
    for (const h of Object.values(pins)) out.set(name(h), ref);
  }
  return out;
}

/**
 * Whether `ref`'s legs may go in `holes`, with a tint for every leg. A leg
 * whose pin has no net yet (a part fresh from the tray) joins whatever its
 * strip carries; a leg with a net may only share a strip with that net.
 */
export function validatePlacement(doc: LayoutDoc, design: Design, ref: string, holes: Record<string, Hole>, netOf?: (pin: string) => string): Verdict {
  const comp = design.components.get(ref);
  const net = netOf ?? ((pin: string) => comp?.pins.get(pin)?.net ?? '');
  const nets = stripNets(doc, design, ref);
  const taken = takenHoles(doc, ref);
  const tints: Tint[] = [];
  let reason: string | null = null;
  const fail = (why: string) => {
    reason ??= why;
  };
  /** Strip -> the net of the first of this part's own legs placed in it. */
  const mine = new Map<string, string>();
  for (const [pin, h] of Object.entries(holes)) {
    let tone: Tone = 'ok';
    let label: string | undefined;
    const n = net(pin);
    if (!inBoard(h, doc.board)) {
      tone = 'bad';
      fail(`pin ${pin} would be off the board at ${name(h)}`);
    } else if (taken.has(name(h))) {
      tone = 'bad';
      fail(`hole ${name(h)} is taken by ${taken.get(name(h))}`);
    } else {
      const k = stripOf(h);
      const there = [...(nets.get(k) ?? [])].filter((x) => x !== n);
      if (there.length && n) {
        tone = 'bad';
        label = there[0];
        fail(`pin ${pin} would short ${short(n)} to ${short(there[0])} at ${name(h)}`);
      } else if (there.length) {
        tone = 'join';
        label = there[0];
      }
      const prev = mine.get(k);
      if (prev !== undefined && prev !== n) {
        tone = 'bad';
        fail(`${ref}'s pins would short each other in one strip (${short(prev) || 'unconnected'} and ${short(n) || 'unconnected'})`);
      }
      mine.set(k, n);
    }
    tints.push({ hole: h, tone, label });
  }
  const pkg = doc.packages.find((p) => p.id === ref);
  if (pkg?.kind === 'dip' && Object.values(holes).some((h) => h.row !== 'e' && h.row !== 'f')) fail(`${ref} has to straddle the centre channel (rows e and f)`);
  return { ok: reason === null, reason, tints };
}

/**
 * A quarter turn clockwise, as seen from above, about pin 1, in whole column
 * and row steps. Null when the turned leg would leave the rows altogether.
 * Whether the result is sensible (a part stood inside one half shorts itself)
 * is validatePlacement's call, not this one's.
 */
export function rotateLead2(holes: Record<string, Hole>, pins: [string, string]): Record<string, Hole> | null {
  const [p1, p2] = pins;
  const a = holes[p1];
  const b = holes[p2];
  const ra = ROW_ORDER.indexOf(a.row);
  const dc = b.col - a.col;
  const dr = ROW_ORDER.indexOf(b.row) - ra;
  // Screen axes: x to the right, rows downward. Clockwise takes (dx, dy) to (-dy, dx).
  const row = ROW_ORDER[ra + dc];
  if (!row) return null;
  return { [p1]: { ...a }, [p2]: { col: a.col - dr, row } };
}
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `bun test test/placement.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test; bun run typecheck`
Expected: 303 + the new tests pass, and typecheck prints no errors.

- [ ] **Step 6: Commit**

```bash
git add src/edit/placement.ts test/placement.test.ts
git commit -m "feat(edit): pure placement rules for the 3D editor (validity, shorts, quarter turns)"
```

---

### Task 2: Flipped chips (engine, 2D, 3D)

**Files:**
- Modify: `src/layout/types.ts:101-113` (`Package`)
- Modify: `src/layout/engine.ts:252-255` (`registerPlaced`, case `'dip'`)
- Modify: `src/render/index.ts:196-202` (DIP body)
- Modify: `client/board3d-parts.ts:642-653` (`chipMarking`)
- Modify: `src/edit/placement.ts` (add `flipDip`)
- Test: `test/flip.test.ts`

**Interfaces:**
- Consumes: `validatePlacement` (Task 1).
- Produces: `Package.flipped?: true`, and `export function flipDip(holes: Record<string, Hole>): Record<string, Hole>`.

- [ ] **Step 1: Write the failing tests**

Create `test/flip.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { flipDip, validatePlacement } from '../src/edit/placement.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const doc = buildLayoutDoc(design, emptySidecar());
const chip = doc.packages.find((p) => p.kind === 'dip')!;
const holes = doc.pinHoles[chip.id];

describe('flipDip', () => {
  test('pin 1 moves from the bottom-left corner to the top-right one', () => {
    const f = flipDip(holes);
    const cols = Object.values(holes).map((h) => h.col);
    expect(holes['1'].row).toBe('f');
    expect(f['1']).toEqual({ col: Math.max(...cols), row: 'e' });
  });

  test('flipping twice is the identity', () => {
    expect(flipDip(flipDip(holes))).toEqual(holes);
  });

  test('a flipped chip in place is a valid placement', () => {
    expect(validatePlacement(doc, design, chip.id, flipDip(holes)).ok).toBe(true);
  });
});

describe('a DIP pinned upside down', () => {
  const sidecar = { ...emptySidecar(), pinned: { [chip.id]: flipDip(holes) } };
  const flipped = buildLayoutDoc(design, sidecar);

  test('is kept, and marked flipped', () => {
    expect(flipped.warnings.filter((w) => w.includes(chip.id))).toEqual([]);
    expect(flipped.packages.find((p) => p.id === chip.id)!.flipped).toBe(true);
    expect(flipped.pinHoles[chip.id]['1'].row).toBe('e');
  });

  test('an unflipped chip carries no flag at all, so existing snapshots do not change', () => {
    expect('flipped' in doc.packages.find((p) => p.id === chip.id)!).toBe(false);
  });

  test('the flat board draws its notch at the right-hand end', () => {
    const svg = renderSvg(flipped, {});
    const g = svg.slice(svg.indexOf(`data-ref="${chip.id}"`));
    const rect = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(g)!;
    const notch = /<circle cx="([\d.]+)"/.exec(g)!;
    expect(Number(notch[1])).toBeCloseTo(Number(rect[1]) + Number(rect[2]), 1);
  });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `bun test test/flip.test.ts`
Expected: FAIL (`flipDip` is not exported).

- [ ] **Step 3: Add `flipDip` to `src/edit/placement.ts`** (append to the end of the file)

```ts
/**
 * Half a turn about the chip's centre: the notch goes to the other end and
 * pin 1 to the opposite corner, each leg landing in the hole its opposite
 * number used. Only ever used on a DIP across the channel, so rows e and f
 * simply trade places.
 */
export function flipDip(holes: Record<string, Hole>): Record<string, Hole> {
  const cols = Object.values(holes).map((h) => h.col);
  const lo = Math.min(...cols);
  const hi = Math.max(...cols);
  const other = (row: Row): Row => (row === 'e' ? 'f' : row === 'f' ? 'e' : row);
  return Object.fromEntries(Object.entries(holes).map(([pin, h]) => [pin, { col: lo + hi - h.col, row: other(h.row) }]));
}
```

- [ ] **Step 4: Add the flag to `Package` in `src/layout/types.ts`** (inside `export interface Package`, after `row?: Row;`)

```ts
  /** dip: turned end for end, notch and pin 1 at the right. Absent, never false, so unflipped docs are unchanged. */
  flipped?: true;
```

- [ ] **Step 5: Set it in `src/layout/engine.ts`**, replacing the `case 'dip':` block in `registerPlaced`

```ts
      case 'dip':
        // Pin 1 lives bottom-left (row f) when the placer puts a chip down;
        // pinned by hand with pin 1 in row e, it has been turned end for end.
        this.packages.push({ id: ref, kind: 'dip', name: value, col0, pins: fp.pins, ...(holes['1']?.row === 'e' ? { flipped: true as const } : {}) });
        addCols(fp.pins / 2);
        break;
```

- [ ] **Step 6: Draw it in 2D, in `src/render/index.ts`**, replacing the three lines after `} else {` in the DIP branch (the rect, notch and dimple)

```ts
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: t.chip, stroke: '#000' }));
    // The notch and the pin 1 dimple mark the pin 1 end, which is the right
    // end once the chip has been turned round.
    const flip = !!pkg.flipped;
    parts.push(el('circle', { cx: flip ? x2 : x1, cy: ym, r: 5, fill: t.notch }));
    parts.push(el('circle', { cx: flip ? x2 - 8 : x1 + 8, cy: flip ? y1 + 8 : y2 - 8, r: 1.8, fill: t.chipText }));
```

- [ ] **Step 7: Draw it in 3D, in `client/board3d-parts.ts` `chipMarking`**: after the `marking(...)` call returns its texture, rotate it half a turn when flipped. Replace `return marking(kit, length, BODY_HALF_Z * 2, (g, w, h) => {` … `});` with a `const tex = marking(...)` followed by:

```ts
  // Printed for pin 1 at the left; a chip turned end for end carries the
  // same print rotated with it, notch and dimple included.
  if (pkg.flipped) {
    tex.center.set(0.5, 0.5);
    tex.rotation = Math.PI;
  }
  return tex;
```

- [ ] **Step 8: Run the tests**

Run: `bun test test/flip.test.ts; bun test; bun run typecheck`
Expected: all pass. If `test/render.test.ts` snapshot tests fail, check that the diff is only because the fixtures were regenerated and not because of an unflipped chip: an unflipped doc must produce byte-identical SVG, so any snapshot diff is a bug in Step 6.

- [ ] **Step 9: Commit**

```bash
git add src/edit/placement.ts src/layout/types.ts src/layout/engine.ts src/render/index.ts client/board3d-parts.ts test/flip.test.ts
git commit -m "feat(layout): chips can be pinned turned end for end; both boards draw the notch at pin 1"
```

---

### Task 3: A rebuildable, pickable 3D scene and the e2e harness

**Files:**
- Modify: `client/board3d.ts`
- Create: `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `Tint` (Task 1).
- Produces (the `Board3D` interface, replacing the existing one; keep every existing member):
  ```ts
  export type Pick = { kind: 'part'; ref: string } | { kind: 'wire'; net: string } | { kind: 'switch'; key: string } | null;
  export interface Board3D {
    dispose(): void;
    setState(s: AnalogState | null): void;
    setBoard(switches: Record<string, boolean>, leds: Record<string, boolean>, segments?: Record<string, Record<string, boolean>>): void;
    setHighlight(hl: Highlight | null): void;
    setHover(net: string | null): void;
    resize(): void;
    resetView(): void;
    setFly(on: boolean): void;
    readonly flying: boolean;
    /** Swap every part, package and wire for those of `doc` (and the jumper style, when given); renderer, lights and camera stay. */
    rebuild(doc: LayoutDoc, wireStyle?: 'arc' | 'orthogonal'): void;
    /** What is under a pointer event: a switch, a part or a jacket, in that order. */
    pick(e: { clientX: number; clientY: number }): Pick;
    /** The pointer projected onto the board's top surface, in plan (SVG) units [x, y]. */
    boardPoint(e: { clientX: number; clientY: number }): [number, number] | null;
    /** Outline one part (selected) and optionally another more faintly (hovered). */
    setSelected(ref: string | null): void;
    setHovered(ref: string | null): void;
    /** Slide a part's mesh by a plan offset while it is being dragged; (0, 0) puts it back. */
    nudge(ref: string, dx: number, dy: number): void;
    /** Tint the strips under the given legs; an empty list clears them. */
    setStripTint(tints: Tint[]): void;
    /** Screen position (CSS px, relative to the canvas) of a part's top centre. */
    anchor(ref: string): { x: number; y: number; visible: boolean } | null;
    /** Glide the camera to frame one part. */
    focus(ref: string): void;
    /** Called once per rendered frame. Returns an unsubscribe. */
    onFrame(fn: () => void): () => void;
    /** The canvas, so the workspace can listen on it before OrbitControls does. */
    readonly dom: HTMLCanvasElement;
    /** Orbit on or off; off while the editor owns a drag. */
    setOrbit(on: boolean): void;
  }
  ```
  `Board3DOptions` loses nothing. Its `onSelectNet`, `onNet` and `onToggle` stay as they are, so the legend and switch flicking keep working.

This task is a refactor of a 741-line file that has no unit tests (three.js needs WebGL). Its safety net is typecheck, the existing tests (which cover `board3d-parts.ts`), and the new e2e harness, which runs the real page in headless Chrome.

- [ ] **Step 1: Create the e2e harness `scripts/e2e-3d.ts` with a first scenario that must fail today**

```ts
// End-to-end checks for the 3D editor: a real server, a real build and a real
// headless Chrome, driven over the DevTools protocol. Headless Chrome counts
// as a visible page, so timers and requestAnimationFrame run at full rate
// (the Chrome MCP tab does not: it is a background tab, clamped to 1 s).
//
// Run: bun run build && bun scripts/e2e-3d.ts [scenario ...]
// Needs kicad-cli (KiCad 9) to open the fixture schematic.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8799;
const DEBUG = 9333;
const root = mkdtempSync(path.join(tmpdir(), 'e2e3d-'));
const base = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CDP {
  private id = 0;
  private waiting = new Map<number, (v: unknown) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) this.waiting.get(msg.id)?.(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result);
    });
  }
  static async open(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    return new CDP(ws);
  }
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.waiting.set(id, r as (v: unknown) => void));
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression: string, what: string, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`!!(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
  }
  async key(key: string, code: string, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  }
}

async function main() {
  const server = Bun.spawn(['bun', 'server/index.ts'], { env: { ...process.env, CIRCUIT_PORT: String(PORT), DATA_DIR: path.join(root, 'data'), PROJECTS_DIR: root }, stdout: 'ignore', stderr: 'inherit' });
  const chrome = Bun.spawn([CHROME, '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(root, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
  let failed = 0;
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/api/projects`).then((r) => r.ok, () => false)) break;
      if (i > 100) throw new Error('server did not start');
      await sleep(100);
    }
    const sch = path.join(root, 'PL1_1.kicad_sch');
    copyFileSync('test/fixtures/PL1_1.kicad_sch', sch);
    const opened = (await (await fetch(`${base}/api/projects/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: sch }) })).json()) as { id: string };
    let target: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 100 && !target; i++) {
      target = await fetch(`http://localhost:${DEBUG}/json/new?${base}/?e2e#/p/${opened.id}`, { method: 'PUT' }).then((r) => r.json(), () => null);
      if (!target) await sleep(100);
    }
    const page = await CDP.open(target!.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    const want = new Set(process.argv.slice(2));
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (want.size && !want.has(name)) continue;
      try {
        await page.eval(`location.reload()`);
        await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
        await run(page, opened.id);
        console.log(`ok   ${name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${(e as Error).message}`);
      }
    }
  } finally {
    chrome.kill();
    server.kill();
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/** Open the workspace and wait until its scene has drawn a frame. */
async function open3d(page: CDP) {
  await page.eval(`document.querySelector('[data-action=view3d]').click()`);
  await page.until(`window.__e3d?.ready`, 'the 3D workspace');
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
  async 'workspace opens full screen'(page) {
    await open3d(page);
    const r = await page.eval<{ w: number; h: number }>(`(() => { const b = document.querySelector('.ws').getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    if (r.w < 1300 || r.h < 800) throw new Error(`workspace is ${r.w}x${r.h}, not full screen`);
  },
};

void main();
```

- [ ] **Step 2: Run it to see the scenario fail**

Run: `bun run build; bun scripts/e2e-3d.ts`
Expected: `FAIL workspace opens full screen: timed out waiting for the 3D workspace` (there is no `window.__e3d` yet). If the server or Chrome fails to start instead, fix that first; the harness must be sound before it can judge anything.

- [ ] **Step 3: Make scene content rebuildable in `client/board3d.ts`**

Restructure `mount3d` into three parts, without changing what gets drawn:

1. **Once per mount (unchanged, stays at the top of `mount3d`):** the renderer, scene, PMREM room, camera, `OrbitControls`, `fly`, and the lights.
   - Board size can change after an edit adds parts, so compute the shadow frustum `reach` from the widest board (`X0 + 62 * P + X0`, a full 63-column board) rather than the mounted doc's width.
2. **Per doc (move into a new inner function):**
   - Everything from `const kit = new Kit();` through the end of the "supply leads" block becomes `function build(doc: LayoutDoc): Content`.
   - It returns:
     ```ts
     interface Content {
       kit: Kit;
       root: THREE.Group;
       ways: Way[];
       displays: Map<string, SevenSegLamp>;
       leds: Map<string, LedLamp>;
       pickable: THREE.Object3D[];
       wirePick: THREE.Object3D[];
       wireObjs: { net: string; objs: THREE.Object3D[] }[];
       netMat: Map<string, THREE.MeshStandardMaterial>;
       netColour: Map<string, THREE.Color>;
       tinMat: Map<string, THREE.MeshStandardMaterial>;
       /** ref -> the group holding that part or package, for picking, outlines, nudges and focus. */
       partObj: Map<string, THREE.Object3D>;
       doc: LayoutDoc;
     }
     ```
   - Inside `build`, tag and layer every part and package group:
     ```ts
     const PART_LAYER = 1;
     const tag = (obj: THREE.Object3D, ref: string) => {
       obj.userData.ref = ref;
       obj.traverse((n) => n.layers.enable(PART_LAYER));
       partObj.set(ref, obj);
     };
     // in the packages loop, after root.add(built.object):
     tag(built.object, pkg.id);
     // in the parts loop, after root.add(built.object):
     tag(built.object, part.id);
     ```
   - Jackets go on layer 2 (`mesh.layers.enable(2)` wherever a jacket is pushed to `wirePick`). Switch ways go on layer 3 (in `collectPickable`, `n.traverse((m) => m.layers.enable(3))`).
3. **The rest of `mount3d`:** it keeps `let c = build(doc);` and reads `c.netMat`, `c.wireObjs`, `c.leds`, `c.ways`, `c.displays`, `c.pickable`, `c.wirePick` and `c.doc` everywhere it used the old locals.
   - `netsOfRef` iterates `c.doc.parts` and `c.doc.pinouts`.
   - `rebuild(next)` is:
     ```ts
     // `build` reads the jumper style from this, not from opts, so a style
     // change is a rebuild rather than a remount.
     let wireStyle = opts.wireStyle ?? 'arc';
     const rebuild = (next: LayoutDoc, style?: 'arc' | 'orthogonal') => {
       if (style) wireStyle = style;
       scene.remove(c.root);
       c.kit.dispose();
       c = build(next);
       scene.add(c.root);
       // Selection outlines hang off the old meshes; rebuild them on the new ones.
       const sel = selectedRef;
       const hov = hoveredRef;
       selectedRef = hoveredRef = null;
       clearOutline('sel');
       clearOutline('hov');
       if (sel && c.partObj.has(sel)) setSelected(sel);
       if (hov && c.partObj.has(hov)) setHovered(hov);
       paintNets();
       paintLeds();
     };
     ```
     `build` must not call `scene.add(root)` itself; the caller adds it, as shown above and once at mount. Inside `build`, replace `const square = opts.wireStyle === 'orthogonal';` with `const square = wireStyle === 'orthogonal';` (declare `wireStyle` above `build`).

   - **Soft highlight for a selected part.** In `setHighlight`, change `const soft = !!hl?.soft && hl.net !== undefined;` to `const soft = !!hl?.soft;`. This lets a selected part (highlight `{ ref, soft: true }`) leave the other jumpers as glass rather than hiding them. Existing callers only ever set `soft` together with `net`, so their behaviour is unchanged.

- [ ] **Step 4: Add picking and the new methods to `client/board3d.ts`**

Replace the existing `probe` with a layered `pick`, and add the methods. Put this code just after the existing `const ray = new THREE.Raycaster();` and `const ndc = new THREE.Vector2();` lines:

```ts
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const rect = dom.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  /** First hit on one layer, walked up to the object that carries `key`. */
  const hitOn = (layer: number, key: 'switchKey' | 'ref' | 'net', within: THREE.Object3D[]): string | null => {
    ray.layers.set(layer);
    for (const hit of ray.intersectObjects(within, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (typeof o.userData[key] === 'string') return o.userData[key] as string;
    }
    return null;
  };
  const pick = (e: { clientX: number; clientY: number }): Pick => {
    toNdc(e);
    const key = hitOn(3, 'switchKey', c.pickable);
    if (key) return { kind: 'switch', key };
    const ref = hitOn(1, 'ref', [...c.partObj.values()]);
    if (ref) return { kind: 'part', ref };
    const net = hitOn(2, 'net', c.wirePick);
    return net ? { kind: 'wire', net } : null;
  };
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP);
  const planeHit = new THREE.Vector3();
  const boardPoint = (e: { clientX: number; clientY: number }): [number, number] | null => {
    toNdc(e);
    return ray.ray.intersectPlane(boardPlane, planeHit) ? [planeHit.x, planeHit.z] : null;
  };
```

Rewrite the existing `onUp` / `onMove` handlers to use `pick`, keeping their behaviour:

```ts
  const onUp = (e: PointerEvent) => {
    const start = press;
    press = null;
    if (!start || e.button !== 0 || !orbitOn) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 600) return;
    const hit = pick(e);
    if (hit?.kind === 'switch') opts.onToggle?.(hit.key);
    // Parts are the workspace's business; only a jacket or empty board follows or releases a net here.
    else if (hit?.kind !== 'part') opts.onSelectNet?.(hit?.kind === 'wire' ? hit.net : null);
  };
  const onMove = (e: PointerEvent) => {
    if (press || fly.active || !orbitOn) return;
    const hit = pick(e);
    dom.style.cursor = hit?.kind === 'switch' || hit?.kind === 'part' ? 'pointer' : '';
    setHoveredNet(hit?.kind === 'wire' ? hit.net : null);
  };
```

(Rename the existing net hover function `setHovered` to `setHoveredNet`. The name `setHovered` now belongs to part hover, and the returned object maps `setHover: setHoveredNet`.)

Outlines, nudge, strip tints, anchor, focus and frames:

```ts
  // ---------- selection outline ----------
  // An edge overlay rather than a post-processing outline pass: a pass would
  // mean an EffectComposer, which loses the canvas's MSAA and has to be taught
  // the tone mapping, for the sake of one part. Lines drawn on top of the
  // part's own meshes cost nothing when nothing is selected.
  const ACCENT = new THREE.Color('#4da3ff');
  const outlines = { sel: [] as THREE.LineSegments[], hov: [] as THREE.LineSegments[] };
  const lineMat = {
    sel: new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.95 }),
    hov: new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.35 }),
  };
  const clearOutline = (which: 'sel' | 'hov') => {
    for (const l of outlines[which]) {
      l.parent?.remove(l);
      l.geometry.dispose();
    }
    outlines[which] = [];
  };
  const outline = (which: 'sel' | 'hov', ref: string | null) => {
    clearOutline(which);
    const obj = ref ? c.partObj.get(ref) : undefined;
    if (!obj) return;
    obj.traverse((n) => {
      // Instanced legs would outline a single leg at the origin; the body says enough.
      if (!(n instanceof THREE.Mesh) || n instanceof THREE.InstancedMesh || !n.visible) return;
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(n.geometry, 30), lineMat[which]);
      l.renderOrder = 10;
      l.raycast = () => {};
      n.add(l);
      outlines[which].push(l);
    });
  };
  let selectedRef: string | null = null;
  let hoveredRef: string | null = null;
  const setSelected = (ref: string | null) => {
    selectedRef = ref;
    outline('sel', ref);
    if (hoveredRef === ref) clearOutline('hov');
  };
  const setHovered = (ref: string | null) => {
    if (ref === hoveredRef) return;
    hoveredRef = ref;
    outline('hov', ref && ref !== selectedRef ? ref : null);
  };

  // ---------- drag feedback ----------
  const nudge = (ref: string, dx: number, dy: number) => {
    const obj = c.partObj.get(ref);
    if (obj) obj.position.set(dx, 0, dy);
  };
  const tintGeo = new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2);
  const tintMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
  // Its own matrix: the sockets' m4 now lives inside build().
  const tintM4 = new THREE.Matrix4();
  const TINT_MAX = 128;
  const tintMesh = new THREE.InstancedMesh(tintGeo, tintMat, TINT_MAX);
  tintMesh.count = 0;
  tintMesh.renderOrder = 5;
  tintMesh.raycast = () => {};
  scene.add(tintMesh);
  const TONE = { ok: new THREE.Color('#3ecf6e'), join: new THREE.Color('#f5a524'), bad: new THREE.Color('#ef4444') };
  const setStripTint = (tints: Tint[]) => {
    let i = 0;
    for (const t of tints) {
      // A strip leg lights all five holes it joins; a rail leg lights its own.
      const rows = isRail(t.hole.row) ? [t.hole.row] : 'abcde'.includes(t.hole.row) ? (['a', 'b', 'c', 'd', 'e'] as const) : (['f', 'g', 'h', 'i', 'j'] as const);
      for (const row of rows) {
        if (i >= TINT_MAX || t.hole.col < 1 || t.hole.col > c.doc.board.cols) break;
        const h = { col: t.hole.col, row } as Hole;
        tintM4.makeTranslation(holeX(h), TOP + 0.3, holeZ(h));
        tintMesh.setMatrixAt(i, tintM4);
        tintMesh.setColorAt(i, TONE[t.tone]);
        i++;
      }
    }
    tintMesh.count = i;
    tintMesh.instanceMatrix.needsUpdate = true;
    if (tintMesh.instanceColor) tintMesh.instanceColor.needsUpdate = true;
  };

  // ---------- where a part is on screen ----------
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  const anchor = (ref: string) => {
    const obj = c.partObj.get(ref);
    if (!obj) return null;
    box.setFromObject(obj);
    tmp.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(camera);
    const rect = dom.getBoundingClientRect();
    return { x: ((tmp.x + 1) / 2) * rect.width, y: ((1 - tmp.y) / 2) * rect.height, visible: tmp.z < 1 };
  };

  // ---------- focus ----------
  let glide: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t0: number } | null = null;
  const focus = (ref: string) => {
    const obj = c.partObj.get(ref);
    if (!obj || fly.active) return;
    box.setFromObject(obj);
    const f = frameBox({ min: box.min.toArray(), max: box.max.toArray() }, camera.fov, camera.aspect, 1.6);
    const toT = new THREE.Vector3(...f.target);
    // Keep the current viewing direction, only closer.
    const dir = camera.position.clone().sub(controls.target).normalize();
    glide = { from: camera.position.clone(), to: toT.clone().addScaledVector(dir, f.distance), fromT: controls.target.clone(), toT, t0: performance.now() };
  };
  // Any orbit input takes the camera back from a glide in progress.
  controls.addEventListener('start', () => (glide = null));

  const frameFns = new Set<() => void>();
```

In the render loop, before `renderer.render`, add:

```ts
    if (glide && !fly.active) {
      const k = easeOutCubic(Math.min(1, (now - glide.t0) / 400));
      camera.position.lerpVectors(glide.from, glide.to, k);
      controls.target.lerpVectors(glide.fromT, glide.toT, k);
      if (k >= 1) glide = null;
    }
```

and after `renderer.render(scene, camera);` add `for (const fn of frameFns) fn();`.

Orbit hand-off:

```ts
  let orbitOn = true;
  const setOrbit = (on: boolean) => {
    orbitOn = on;
    if (!fly.active) controls.enabled = on;
  };
```

**Remove the F key handler** (`onKeyDown` and its `addEventListener`/`removeEventListener` lines); the workspace routes keys now.

Add the imports:

```ts
import type { Tint } from '../src/edit/placement.ts';
import { isRail } from '../src/layout/board.ts';
import { easeOutCubic, frameBox } from './editor3d/focus-math.ts';
```

`focus-math.ts` is created in Step 5, which also comes before the first typecheck. Extend the returned object with every new member of the `Board3D` interface: `rebuild`, `pick`, `boardPoint`, `setSelected`, `setHovered`, `nudge`, `setStripTint`, `anchor`, `focus`, `onFrame: (fn) => (frameFns.add(fn), () => frameFns.delete(fn))`, `dom`, `setOrbit`, `get flying() { return fly.active; }`. In `dispose()`, also dispose `tintGeo`, `tintMat`, `lineMat.sel`, `lineMat.hov`, the outlines, and `c.kit`.

- [ ] **Step 5: Create `client/editor3d/focus-math.ts` with its test (TDD)**

Test first, `test/focus-math.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { easeOutCubic, frameBox } from '../client/editor3d/focus-math.ts';

describe('easeOutCubic', () => {
  test('starts at 0, ends at 1, and is past halfway by the middle', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('frameBox', () => {
  test('aims at the centre of the box', () => {
    expect(frameBox({ min: [0, 0, 0], max: [20, 10, 40] }, 38, 1.5, 1).target).toEqual([10, 5, 20]);
  });

  test('a bigger part needs the camera further back', () => {
    const small = frameBox({ min: [0, 0, 0], max: [10, 10, 10] }, 38, 1.5, 1.6).distance;
    const big = frameBox({ min: [0, 0, 0], max: [100, 10, 10] }, 38, 1.5, 1.6).distance;
    expect(big).toBeGreaterThan(small);
  });

  test('never closer than the orbit minimum', () => {
    expect(frameBox({ min: [0, 0, 0], max: [1, 1, 1] }, 38, 1.5, 1).distance).toBeGreaterThanOrEqual(60);
  });
});
```

Run `bun test test/focus-math.test.ts`. It should fail because the module is missing. Then create `client/editor3d/focus-math.ts`:

```ts
// The arithmetic behind "fly the camera to this part", kept free of three so
// it can be tested: where to look, and how far back to stand so the part
// fills the view with some air round it.

/** OrbitControls.minDistance in board3d.ts; a focus never lands inside it. */
const MIN_DISTANCE = 60;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function frameBox(box: { min: number[]; max: number[] }, fovDeg: number, aspect: number, padding: number): { target: [number, number, number]; distance: number } {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const target: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
  // The narrower of the two fields of view decides, so the part fits both ways.
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const distance = (radius * padding) / Math.sin(Math.min(vfov, hfov) / 2);
  return { target, distance: Math.max(MIN_DISTANCE, distance) };
}
```

Run: `bun test test/focus-math.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and run the suite**

Run: `bun run typecheck; bun test`
Expected: no type errors; all tests pass. The e2e scenario still fails because nothing exposes `__e3d` until Task 4.

- [ ] **Step 7: Commit**

```bash
git add client/board3d.ts client/editor3d/focus-math.ts test/focus-math.test.ts scripts/e2e-3d.ts
git commit -m "refactor(3d): rebuildable scene with part picking, outlines, strip tints and camera focus; e2e harness"
```

---

### Task 4: The full-screen workspace

**Files:**
- Create: `client/editor3d/workspace.ts`
- Modify: `client/view3d.ts` (reduced to a wrapper)
- Modify: `client/panels.ts:331-343`
- Modify: `client/state.ts` (`selectedRef`), `client/main.ts:41` (initial `selectedRef: null`)
- Modify: `client/board.ts:56` (flat board shows the selected part)
- Modify: `client/styles.css` (append `.ws*` rules; raise `.toast`)

**Interfaces:**
- Consumes: `Board3D` (Task 3), `store`, `analog`, `simState`, `currentHighlight`, `flowOrder`, `esc`.
- Produces:
  ```ts
  // client/editor3d/workspace.ts
  export interface Workspace {
    board: Board3D;
    root: HTMLElement;          // the .ws element
    canvasHost: HTMLElement;    // .ws-canvas
    hint(text: string): void;   // writes the hint line
    close(): void;
  }
  export function openWorkspace(onClosed: () => void): Promise<Workspace | null>;
  /** Registered by later tasks: return true when the key was handled. */
  export type KeyHandler = (e: KeyboardEvent, ws: Workspace) => boolean;
  export function addKeyHandler(fn: KeyHandler): () => void;
  ```
  - `client/view3d.ts` keeps `open3d(): Promise<void>`, `close3d(viaHistory?: boolean)` and `is3dOpen()`. `open3d` no longer takes a card or doc.
  - `ProjectState.selectedRef: string | null`.

- [ ] **Step 1: Extend the e2e scenario for the shell**

Add to `SCENARIOS` in `scripts/e2e-3d.ts`:

```ts
  async 'Esc and Back both close it'(page) {
    await open3d(page);
    await page.key('Escape', 'Escape');
    await page.until(`!document.querySelector('.ws')`, 'Esc to close');
    await open3d(page);
    await page.eval(`history.back()`);
    await page.until(`!document.querySelector('.ws')`, 'Back to close');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D again');
  },
```

Run: `bun run build; bun scripts/e2e-3d.ts`. Expected: both scenarios FAIL, because `__e3d` isn't defined yet.

- [ ] **Step 2: Add `selectedRef` to the store**

In `client/state.ts`, inside `ProjectState` after `activeStep`:

```ts
  /** The part picked in the 3D editor; the flat board outlines the same one. */
  selectedRef: string | null;
```

In `client/main.ts` `loadProject`, add `selectedRef: null` to the project literal. In `client/board.ts` `render`, change the `highlight` line to:

```ts
    const highlight: Highlight | null = p.highlight ?? (p.activeStep !== null ? stepHighlight(p, p.activeStep) : p.selectedRef ? { ref: p.selectedRef } : null);
```

- [ ] **Step 3: Write `client/editor3d/workspace.ts`**

```ts
// The 3D editor's shell: a full-screen layer over the page with the tray
// strip, a toolbar, the canvas, the net legend and the hint line. It owns the
// keyboard while it is open, mirrors the store into the scene, and is what
// Esc and the browser's Back button close.
//
// It is mounted on document.body, not inside the board card, so the page
// re-rendering underneath (every store change re-renders the panels) can
// never take the canvas with it.

import { analog } from '../analog.ts';
import type { Board3D } from '../board3d.ts';
import { currentHighlight } from '../board.ts';
import { flowOrder } from '../floworder.ts';
import { esc } from '../main.ts';
import { simState } from '../simstate.ts';
import { store } from '../state.ts';

export interface Workspace {
  board: Board3D;
  root: HTMLElement;
  canvasHost: HTMLElement;
  hint(text: string): void;
  close(): void;
}
export type KeyHandler = (e: KeyboardEvent, ws: Workspace) => boolean;

const keyHandlers = new Set<KeyHandler>();
export const addKeyHandler = (fn: KeyHandler) => (keyHandlers.add(fn), () => keyHandlers.delete(fn));

const ORBIT_HINT = 'drag to orbit · right-drag to pan · scroll to zoom · click a part to select it · F focus · R rotate · Shift+R flip chip · Del delete · Ctrl+Z undo · Esc close';
const FLY_HINT = 'WASD to move · mouse to look · space and C for up and down · shift to sprint · F or Esc to orbit again';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
};

export async function openWorkspace(onClosed: () => void): Promise<Workspace | null> {
  const p = store.get().project;
  if (!p) return null;
  const root = document.createElement('div');
  root.className = 'ws';
  root.innerHTML =
    '<div class="ws-tray" aria-label="Parts tray"><span class="ws-tray-soon">Parts tray: coming in phase 3</span></div>' +
    '<div class="ws-bar">' +
    '<button type="button" class="ws-btn" data-ws="exit" title="Close the 3D editor (Esc)">← Exit</button>' +
    '<button type="button" class="ws-btn" data-ws="fly" title="Fly through (F with nothing selected)">Fly through</button>' +
    '<button type="button" class="ws-btn" data-ws="prev" title="previous build step">◀</button><span class="ws-step"></span><button type="button" class="ws-btn" data-ws="next" title="next build step">▶</button>' +
    '<button type="button" class="ws-btn" data-ws="undo" title="Undo (Ctrl+Z)" disabled>Undo</button><button type="button" class="ws-btn" data-ws="redo" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button>' +
    '<span class="ws-hint"></span></div>' +
    '<div class="ws-canvas"></div>' +
    `<div class="ws-legend">${flowOrder(p.doc).map((net) => `<span data-legend="${esc(net)}" title="click to follow this net"><i style="background:${esc(p.doc.nets[net].color)}"></i><span>${esc(p.doc.nets[net].name)}</span></span>`).join('')}</div>`;
  document.body.appendChild(root);
  document.body.classList.add('ws-open');
  const canvasHost = root.querySelector<HTMLElement>('.ws-canvas')!;
  const hintEl = root.querySelector<HTMLElement>('.ws-hint')!;
  const stepEl = root.querySelector<HTMLElement>('.ws-step')!;

  const { mount3d } = await import('../board3d.ts');
  // Closed again while three was still downloading.
  if (!root.isConnected) return null;
  let mountedStyle = p.sidecar.options.wireStyle;
  let mountedDoc = p.doc;
  const board = mount3d(canvasHost, p.doc, {
    wireStyle: mountedStyle,
    onToggle(key) {
      const q = store.get().project;
      if (!q) return;
      const switches = { ...q.switches, [key]: !q.switches[key] };
      store.setProject({ switches });
      analog.refresh({ ...q, switches });
    },
    onSelectNet(net) {
      const q = store.get().project;
      if (!q) return;
      if (net) store.setProject({ highlight: { net }, activeStep: null, selectedRef: null });
      else if (q.highlight || q.selectedRef) store.setProject({ highlight: null, selectedRef: null });
    },
    onMode(mode) {
      hintEl.textContent = mode === 'fly' ? FLY_HINT : ORBIT_HINT;
    },
  });
  hintEl.textContent = ORBIT_HINT;

  let closed = false;
  const ws: Workspace = {
    board,
    root,
    canvasHost,
    hint: (t) => (hintEl.textContent = t || ORBIT_HINT),
    close() {
      if (closed) return;
      closed = true;
      unsubStore();
      unsubSim();
      document.removeEventListener('keydown', onKey, true);
      board.dispose();
      root.remove();
      document.body.classList.remove('ws-open');
      delete (window as { __e3d?: unknown }).__e3d;
      onClosed();
    },
  };

  const push = () => {
    const q = store.get().project;
    if (!q || closed) return;
    // A new doc is new parts, and a wire-style change is different jumper
    // geometry; both are a rebuild in place, the camera staying where it is.
    if (q.doc !== mountedDoc || q.sidecar.options.wireStyle !== mountedStyle) {
      mountedDoc = q.doc;
      mountedStyle = q.sidecar.options.wireStyle;
      board.rebuild(q.doc, mountedStyle);
    }
    const s = simState(q.doc.sim.model, q.switches);
    board.setBoard(q.switches, s.leds, s.segments);
    board.setHighlight(currentHighlight(q) ?? (q.selectedRef ? { ref: q.selectedRef, soft: true } : null));
    board.setSelected(q.selectedRef);
    for (const chip of root.querySelectorAll<HTMLElement>('[data-legend]')) chip.classList.toggle('is-on', q.highlight?.net === chip.dataset.legend);
    const n = q.doc.steps.length;
    const step = q.activeStep !== null ? q.doc.steps.find((x) => x.n === q.activeStep) : undefined;
    stepEl.textContent = step ? `Step ${step.n}/${n}: ${step.label}` : `Walk-through: ▶ for step 1 of ${n}`;
  };
  const unsubStore = store.subscribe(push);
  board.setState(analog.refresh(p));
  const unsubSim = analog.subscribe((s) => board.setState(s));

  const stepBy = (dir: -1 | 1) => {
    const q = store.get().project;
    if (!q) return;
    const next = Math.min(q.doc.steps.length, Math.max(0, (q.activeStep ?? 0) + dir));
    store.setProject({ activeStep: next === 0 ? null : next, highlight: null });
  };
  root.querySelector('.ws-bar')!.addEventListener('click', (e) => {
    const what = (e.target as HTMLElement).closest<HTMLElement>('[data-ws]')?.dataset.ws;
    if (what === 'exit') history.back();
    if (what === 'fly') board.setFly(!board.flying);
    if (what === 'prev') stepBy(-1);
    if (what === 'next') stepBy(1);
  });
  const legend = root.querySelector<HTMLElement>('.ws-legend')!;
  legend.addEventListener('click', (e) => {
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    const q = store.get().project;
    if (!net || !q) return;
    store.setProject({ highlight: q.highlight?.net === net ? null : { net, soft: true }, activeStep: null });
  });
  legend.addEventListener('mouseover', (e) => board.setHover((e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend ?? null));
  legend.addEventListener('mouseleave', () => board.setHover(null));

  // Keys: later tasks register handlers; these are the shell's own, tried last.
  const onKey = (e: KeyboardEvent) => {
    if (typing(e.target)) return;
    if (board.flying) {
      if (e.key === 'f' || e.key === 'F' || e.key === 'Escape') {
        e.preventDefault();
        board.setFly(false);
      }
      return;
    }
    for (const fn of keyHandlers) if (fn(e, ws)) return void e.preventDefault();
    const q = store.get().project;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (q?.selectedRef) board.focus(q.selectedRef);
      else board.setFly(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q?.selectedRef) store.setProject({ selectedRef: null });
      else history.back();
    }
  };
  // Capture phase, so the shell hears a key before anything on the page does.
  document.addEventListener('keydown', onKey, true);

  push();
  // Test hook for scripts/e2e-3d.ts; only present when the URL asks for it.
  if (location.search.includes('e2e')) {
    let frames = 0;
    board.onFrame(() => frames++);
    (window as { __e3d?: unknown }).__e3d = {
      get ready() {
        return frames > 2;
      },
      selected: () => store.get().project?.selectedRef ?? null,
      holes: (ref: string) => store.get().project?.doc.pinHoles[ref] ?? null,
      screenOf(ref: string) {
        const a = board.anchor(ref);
        const r = canvasHost.getBoundingClientRect();
        return a ? { x: r.left + a.x, y: r.top + a.y + 6 } : null;
      },
      parts: () => store.get().project?.doc.parts.map((x) => x.id) ?? [],
      chips: () => store.get().project?.doc.packages.filter((x) => x.kind === 'dip').map((x) => x.id) ?? [],
    };
  }
  return ws;
}
```

- [ ] **Step 4: Reduce `client/view3d.ts` to a wrapper**

Replace the whole file with:

```ts
// Opening and closing the 3D editor. The editor itself lives in
// client/editor3d/; this module only keeps the one instance and the history
// entry that lets the browser's Back button close it.
//
// three is still loaded on demand (workspace.ts imports board3d.ts
// dynamically), so a user who never opens 3D never downloads it.

import { openWorkspace, type Workspace } from './editor3d/workspace.ts';
import { store } from './state.ts';

let ws: Workspace | null = null;
let opening = false;
let onPop: (() => void) | null = null;

export const is3dOpen = () => !!ws;

export async function open3d() {
  if (ws || opening) return;
  opening = true;
  // One history entry on the same URL: Back closes the editor rather than
  // leaving the project. The router only listens for hash changes, so this
  // entry is invisible to it.
  history.pushState({ ...(history.state ?? {}), view3d: true }, '');
  onPop = () => close3d(false);
  addEventListener('popstate', onPop);
  try {
    ws = await openWorkspace(() => {
      ws = null;
      // Repaint the page toolbar so its button reads 3D again.
      store.setProject({});
    });
  } finally {
    opening = false;
  }
}

/** Close the editor; `viaHistory` also drops the history entry opening it pushed. */
export function close3d(viaHistory = true) {
  if (onPop) {
    removeEventListener('popstate', onPop);
    onPop = null;
  }
  if (viaHistory && (history.state as { view3d?: boolean } | null)?.view3d) history.back();
  ws?.close();
  ws = null;
}
```

The workspace's own Exit button and Esc call `history.back()`, which fires `popstate` and runs `close3d(false)`, so there is exactly one way the editor closes.

- [ ] **Step 5: Point the toolbar button at it**

In `client/panels.ts`, replace the `if (action === 'view3d') { … }` block with:

```ts
    if (action === 'view3d') {
      const repaint = () => renderPanels(panels, toolbar, legend, store.get());
      if (is3dOpen()) {
        close3d();
        repaint();
      } else {
        void open3d().then(repaint);
      }
    }
```

In `client/main.ts:129`, `close3d()` stays as it is: switching projects still closes the editor.

- [ ] **Step 6: Styles**

Append to `client/styles.css`:

```css
/* ---------- 3D editor workspace ---------- */
body.ws-open { overflow: hidden; }
.ws {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  grid-template-rows: auto auto 1fr;
  /* Matches the renderer's clear colour, so a resize never flashes. */
  background: #070910;
  color: #e8ecf4;
}
.ws-tray {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 12px;
  overflow-x: auto;
  border-bottom: 1px solid rgba(255, 255, 255, .08);
  background: rgba(16, 19, 26, .92);
}
.ws-tray-soon { opacity: .5; font-size: 12px; }
.ws-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(16, 19, 26, .78);
  border-bottom: 1px solid rgba(255, 255, 255, .06);
  font-size: 13px;
}
.ws-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .16);
  background: rgba(40, 44, 52, .7);
  color: inherit;
  cursor: pointer;
}
.ws-btn:hover:not(:disabled) { background: rgba(60, 66, 78, .9); }
.ws-btn:disabled { opacity: .4; cursor: default; }
.ws-step { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
.ws-hint { margin-left: auto; opacity: .6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ws-canvas { position: relative; min-height: 0; }
.ws-legend {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 51;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: min(60vw, 720px);
  font-size: 12px;
}
.ws-legend span[data-legend] { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 10px; background: rgba(16, 19, 26, .72); cursor: pointer; }
.ws-legend span[data-legend]:hover { background: rgba(255, 255, 255, .12); }
.ws-legend span[data-legend].is-on { background: rgba(255, 255, 255, .22); outline: 1px solid rgba(255, 255, 255, .5); }
.ws-legend i { width: 14px; height: 5px; border-radius: 3px; display: inline-block; }
/* The page's toast has to show over the workspace too. */
.toast { z-index: 60; }
@media (max-width: 640px) {
  .ws-hint { display: none; }
  .ws-step { max-width: 16ch; }
}
```

- [ ] **Step 7: Build and run the e2e scenarios**

Run: `bun run typecheck; bun test; bun run build; bun scripts/e2e-3d.ts`
Expected: typecheck clean, all unit tests pass, and both e2e scenarios print `ok`.

- [ ] **Step 8: Commit**

```bash
git add client/editor3d/workspace.ts client/view3d.ts client/panels.ts client/state.ts client/main.ts client/board.ts client/styles.css scripts/e2e-3d.ts
git commit -m "feat(3d): full-screen editor workspace with toolbar, legend, key routing and Back/Esc to close"
```

---

### Task 5: Selecting parts

**Files:**
- Create: `client/editor3d/manipulate.ts` (selection part only in this task)
- Modify: `client/editor3d/workspace.ts` (call `attachManipulation(ws)`)
- Modify: `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `Workspace`, `Board3D.pick`, `Board3D.setHovered`, `Board3D.focus`, `store`.
- Produces: `export function attachManipulation(ws: Workspace): () => void`. This task implements click-to-select, hover and double-click to focus. Task 6 extends the same function with dragging.

- [ ] **Step 1: e2e scenario first**

```ts
  async 'clicking a part selects it, empty board clears it'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.parts()`))[0];
    const at = await page.eval<{ x: number; y: number }>(`__e3d.screenOf(${JSON.stringify(ref)})`);
    await page.mouse('mousePressed', at.x, at.y);
    await page.mouse('mouseReleased', at.x, at.y);
    await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, `${ref} to be selected`);
    await page.mouse('mousePressed', 30, 880);
    await page.mouse('mouseReleased', 30, 880);
    await page.until(`__e3d.selected() === null`, 'the selection to clear');
  },
```

Run it and expect FAIL, because nothing selects on click yet.

- [ ] **Step 2: Write `client/editor3d/manipulate.ts`**

```ts
// Pointer work in the 3D editor: hover and click to select a part,
// double-click to fly to it, and (Task 6) drag a selected part to new holes.
//
// The rule that keeps the camera usable: a press on the part that is already
// selected belongs to the editor, and any other press belongs to orbit. It is
// decided on pointerdown, before OrbitControls sees the event, because
// turning orbit off half-way through a gesture leaves it stuck.

import { store } from '../state.ts';
import type { Workspace } from './workspace.ts';

/** Movement under this, in CSS px, is a click rather than a drag (twice that for touch). */
const CLICK_PX = 4;

export function attachManipulation(ws: Workspace): () => void {
  const { board } = ws;
  const dom = board.dom;
  let press: { x: number; y: number; touch: boolean; ref: string | null } | null = null;
  let hoverQueued: PointerEvent | null = null;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || board.flying) return;
    const hit = board.pick(e);
    press = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', ref: hit?.kind === 'part' ? hit.ref : null };
  };

  const onUp = (e: PointerEvent) => {
    const start = press;
    press = null;
    if (!start || e.button !== 0) return;
    const slop = start.touch ? CLICK_PX * 2 : CLICK_PX;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) return;
    const p = store.get().project;
    if (!p) return;
    if (start.ref) store.setProject({ selectedRef: start.ref, highlight: null, activeStep: null });
    // A click on a jacket or empty board is board3d's own business (follow or
    // release a net); it also drops the selection so the two never fight.
    else if (p.selectedRef) store.setProject({ selectedRef: null });
  };

  const onMove = (e: PointerEvent) => {
    if (press || board.flying) return;
    // One raycast per frame at most, however fast the pointer reports.
    if (!hoverQueued) requestAnimationFrame(() => {
      const ev = hoverQueued;
      hoverQueued = null;
      if (!ev) return;
      const hit = board.pick(ev);
      board.setHovered(hit?.kind === 'part' ? hit.ref : null);
    });
    hoverQueued = e;
  };

  const onDbl = (e: MouseEvent) => {
    const hit = board.pick(e);
    if (hit?.kind !== 'part') return;
    store.setProject({ selectedRef: hit.ref, highlight: null, activeStep: null });
    board.focus(hit.ref);
  };

  const onLeave = () => board.setHovered(null);

  // Capture phase on the canvas: these run before OrbitControls' own listeners.
  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('dblclick', onDbl);
  dom.addEventListener('pointerleave', onLeave);
  return () => {
    dom.removeEventListener('pointerdown', onDown, true);
    dom.removeEventListener('pointerup', onUp, true);
    dom.removeEventListener('pointermove', onMove, true);
    dom.removeEventListener('dblclick', onDbl);
    dom.removeEventListener('pointerleave', onLeave);
  };
}
```

- [ ] **Step 3: Wire it into the workspace**

In `workspace.ts`, import `attachManipulation` and call `const detachManip = attachManipulation(ws);` right after the `ws` object is created. Call `detachManip()` in `close()` before `board.dispose()`.

- [ ] **Step 4: Run**

Run: `bun run typecheck; bun run build; bun scripts/e2e-3d.ts`
Expected: all three scenarios `ok`.

- [ ] **Step 5: Commit**

```bash
git add client/editor3d/manipulate.ts client/editor3d/workspace.ts scripts/e2e-3d.ts
git commit -m "feat(3d): click to select a part (outlined, nets lit), hover outline, double-click to fly to it"
```

---

### Task 6: Dragging a selected part to new holes

**Files:**
- Modify: `client/editor3d/manipulate.ts`
- Modify: `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `shiftHoles` (`client/drag.ts`), `validatePlacement` (Task 1), `buildLayoutDoc`, `api.move`, `toast`, `Board3D.boardPoint/nudge/setStripTint/setOrbit`.
- Produces: `export async function commitMove(ref: string, holes: Record<string, Hole>): Promise<boolean>`, exported from `manipulate.ts` for Task 7's history commands. It returns `true` when the server accepted the move.

- [ ] **Step 1: e2e scenarios first**

```ts
  async 'dragging a selected part moves it to new holes'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.parts()`))[0];
    const before = await page.eval<Record<string, { col: number }>>(`__e3d.holes(${JSON.stringify(ref)})`);
    const at = await page.eval<{ x: number; y: number }>(`__e3d.screenOf(${JSON.stringify(ref)})`);
    await page.mouse('mousePressed', at.x, at.y);
    await page.mouse('mouseReleased', at.x, at.y);
    await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, 'selection');
    // Try a few distances right: some columns may be taken; one of them must be free.
    let moved = false;
    for (const dx of [60, 120, 180, 240]) {
      await page.mouse('mousePressed', at.x, at.y);
      for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', at.x + (dx * k) / 6, at.y);
      await page.mouse('mouseReleased', at.x + dx, at.y);
      await sleep(600);
      const after = await page.eval<Record<string, { col: number }>>(`__e3d.holes(${JSON.stringify(ref)})`);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        moved = true;
        if (Object.values(after)[0].col <= Object.values(before)[0].col) throw new Error('moved, but not to the right');
        break;
      }
    }
    if (!moved) throw new Error('no drag distance moved the part');
  },
  async 'a drag that starts on an unselected part orbits instead'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.parts()`))[0];
    const before = await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
    const at = await page.eval<{ x: number; y: number }>(`__e3d.screenOf(${JSON.stringify(ref)})`);
    await page.mouse('mousePressed', at.x, at.y);
    for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', at.x + k * 20, at.y);
    await page.mouse('mouseReleased', at.x + 120, at.y);
    await sleep(400);
    if ((await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`)) !== before) throw new Error('an unselected part moved');
  },
  async 'store update mid-drag does not strand a ghost'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.parts()`))[0];
    const at = await page.eval<{ x: number; y: number }>(`__e3d.screenOf(${JSON.stringify(ref)})`);
    await page.mouse('mousePressed', at.x, at.y);
    await page.mouse('mouseReleased', at.x, at.y);
    await page.mouse('mousePressed', at.x, at.y);
    await page.mouse('mouseMoved', at.x + 40, at.y);
    // A switch flick or a reload lands while the pointer is down.
    await page.eval(`document.querySelector('[data-ws=next]').click()`);
    await page.key('Escape', 'Escape');
    await page.mouse('mouseReleased', at.x + 40, at.y);
    await sleep(300);
    const tinted = await page.eval<number>(`__e3d.tintCount()`);
    if (tinted !== 0) throw new Error(`${tinted} strip tints left behind`);
  },
```

Add `tintCount` to the `__e3d` hook in `workspace.ts`: expose `board` through a getter so `tintCount: () => (board as unknown as { _tintCount(): number })._tintCount()`. In `board3d.ts`, return `_tintCount: () => tintMesh.count` alongside the other members; it's marked internal by the underscore and isn't in the `Board3D` interface. Run the scenarios and expect all three new ones to FAIL.

- [ ] **Step 2: Implement the drag in `manipulate.ts`**

Add these imports:

```ts
import type { Hole } from '../../src/layout/types.ts';
import { validatePlacement, type Verdict } from '../../src/edit/placement.ts';
import { buildLayoutDoc } from '../../src/pipeline.ts';
import { api } from '../api.ts';
import { shiftHoles } from '../drag.ts';
import { toast } from '../main.ts';
```

Add the exported commit (outside `attachManipulation`):

```ts
/**
 * Ask the server to put `ref`'s legs in `holes`, the same call the flat
 * board's drag makes, and take its answer as the new doc. False, with a
 * toast, when it refuses; the store is then left exactly as it was.
 */
export async function commitMove(ref: string, holes: Record<string, Hole>): Promise<boolean> {
  const p = store.get().project;
  if (!p) return false;
  try {
    const doc = await api.move(p.id, ref, holes);
    store.setProject({ doc, sidecar: { ...p.sidecar, pinned: { ...p.sidecar.pinned, [ref]: holes } } });
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  }
}
```

Inside `attachManipulation`, add drag state and extend the handlers:

```ts
  let drag: {
    ref: string;
    pointerId: number;
    origin: Record<string, Hole>;
    grab: [number, number];
    columnsOnly: boolean;
    holes: Record<string, Hole> | null;
    verdict: Verdict | null;
    lastKey: string;
  } | null = null;

  const endDrag = () => {
    if (!drag) return;
    board.nudge(drag.ref, 0, 0);
    board.setStripTint([]);
    board.setOrbit(true);
    if (dom.hasPointerCapture(drag.pointerId)) dom.releasePointerCapture(drag.pointerId);
    drag = null;
    ws.hint('');
  };
```

In `onDown`, after computing `hit`, start a drag when the press is on the selected part:

```ts
    const p = store.get().project;
    const at = board.boardPoint(e);
    if (p && at && hit?.kind === 'part' && hit.ref === p.selectedRef && p.doc.pinHoles[hit.ref]) {
      // Decided here, synchronously, so OrbitControls never starts a rotate.
      board.setOrbit(false);
      // OrbitControls listens on this same canvas; stopImmediatePropagation
      // is what keeps it (and board3d's own click handling) out of this press.
      e.stopImmediatePropagation();
      dom.setPointerCapture(e.pointerId);
      const pkg = p.doc.packages.find((x) => x.id === hit.ref);
      drag = { ref: hit.ref, pointerId: e.pointerId, origin: p.doc.pinHoles[hit.ref], grab: at, columnsOnly: !!pkg, holes: null, verdict: null, lastKey: '' };
    }
```

At the top of `onMove`, before the hover code:

```ts
    if (drag) {
      const p = store.get().project;
      const at = board.boardPoint(e);
      if (!p || !at) return;
      const dx = at[0] - drag.grab[0];
      const dy = at[1] - drag.grab[1];
      // The mesh follows the pointer smoothly; the holes it would drop into snap.
      board.nudge(drag.ref, dx, dy);
      const holes = shiftHoles(drag.origin, dx, dy, p.doc.board, drag.columnsOnly);
      const key = JSON.stringify(holes);
      if (key === drag.lastKey) return;
      drag.lastKey = key;
      drag.holes = holes;
      if (!holes) {
        drag.verdict = { ok: false, reason: 'off the board', tints: [] };
      } else {
        drag.verdict = validatePlacement(p.doc, p.design, drag.ref, holes);
        // The engine has the last word on anything the pure rules cannot see.
        if (drag.verdict.ok) {
          const doc = buildLayoutDoc(p.design, { ...p.sidecar, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } });
          const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
          if (dropped) drag.verdict = { ok: false, reason: dropped.replace(`pinned placement for ${drag.ref} dropped: `, ''), tints: drag.verdict.tints.map((t) => ({ ...t, tone: 'bad' as const })) };
        }
      }
      board.setStripTint(drag.verdict.tints);
      ws.hint(drag.verdict.ok ? `release to move ${drag.ref}` : `can't go here: ${drag.verdict.reason}`);
      return;
    }
```

At the top of `onUp`:

```ts
    if (drag) {
      const d = drag;
      endDrag();
      press = null;
      if (d.holes && d.verdict?.ok && JSON.stringify(d.holes) !== JSON.stringify(d.origin)) void commitMove(d.ref, d.holes);
      else if (d.verdict && !d.verdict.ok) toast(`Not moved: ${d.verdict.reason}`);
      return;
    }
```

A store change or Escape during a drag cancels it. Add a key handler, and a store subscription that ends the drag when the doc changes underneath it:

```ts
  const offKey = addKeyHandler((e) => {
    if (e.key !== 'Escape' || !drag) return false;
    endDrag();
    return true;
  });
  let docSeen = store.get().project?.doc;
  const offStore = store.subscribe((s) => {
    if (s.project?.doc !== docSeen) {
      docSeen = s.project?.doc;
      endDrag();
    }
  });
  const onCancel = () => endDrag();
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('lostpointercapture', onCancel);
```

Import `addKeyHandler` from `./workspace.ts`. In the returned cleanup, call `offKey()`, `offStore()` and `endDrag()`, and remove the two new listeners.

(The mid-drag scenario clicks ▶, which changes `activeStep` but not `doc`, and then presses Esc. The Esc handler ends the drag, and `lostpointercapture` makes sure the tints are cleared either way.)

- [ ] **Step 3: Run**

Run: `bun run typecheck; bun test; bun run build; bun scripts/e2e-3d.ts`
Expected: all scenarios `ok`.

- [ ] **Step 4: Commit**

```bash
git add client/editor3d/manipulate.ts client/editor3d/workspace.ts client/board3d.ts scripts/e2e-3d.ts
git commit -m "feat(3d): drag a selected part to new holes with snapping, strip tints and refusal reasons"
```

---

### Task 7: Undo/redo, rotate and flip

**Files:**
- Create: `client/editor3d/history.ts`
- Test: `test/history.test.ts`
- Modify: `client/editor3d/manipulate.ts` (moves go through history; R and Shift+R)
- Modify: `client/editor3d/workspace.ts` (Undo/Redo buttons, Ctrl+Z/Y)
- Modify: `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `commitMove` (Task 6), `rotateLead2`, `flipDip`, `validatePlacement` (Tasks 1–2).
- Produces:
  ```ts
  export interface Command { label: string; run(): Promise<boolean>; undo(): Promise<boolean> }
  export class History {
    execute(cmd: Command): Promise<boolean>;
    undo(): Promise<boolean>;
    redo(): Promise<boolean>;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    onChange(fn: () => void): () => void;
    clear(): void;
  }
  export const history: History; // the one the workspace uses
  ```

- [ ] **Step 1: Write the failing tests**

`test/history.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { History, type Command } from '../client/editor3d/history.ts';

function counter() {
  const log: string[] = [];
  let value = 0;
  const cmd = (by: number, ok = true): Command => ({
    label: `add ${by}`,
    async run() {
      if (!ok) return false;
      value += by;
      log.push(`+${by}`);
      return true;
    },
    async undo() {
      value -= by;
      log.push(`-${by}`);
      return true;
    },
  });
  return { cmd, log, get value() { return value; } };
}

describe('History', () => {
  test('undo and redo walk the same steps back and forth', async () => {
    const h = new History();
    const c = counter();
    await h.execute(c.cmd(1));
    await h.execute(c.cmd(2));
    expect(c.value).toBe(3);
    await h.undo();
    expect(c.value).toBe(1);
    await h.redo();
    expect(c.value).toBe(3);
    expect(c.log).toEqual(['+1', '+2', '-2', '+2']);
  });

  test('a new command clears what could have been redone', async () => {
    const h = new History();
    const c = counter();
    await h.execute(c.cmd(1));
    await h.undo();
    expect(h.canRedo).toBe(true);
    await h.execute(c.cmd(5));
    expect(h.canRedo).toBe(false);
  });

  test('a failed run is not recorded', async () => {
    const h = new History();
    const c = counter();
    expect(await h.execute(c.cmd(1, false))).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  test('undo with nothing to undo is a no-op that says so', async () => {
    expect(await new History().undo()).toBe(false);
  });

  test('listeners hear every change', async () => {
    const h = new History();
    let n = 0;
    h.onChange(() => n++);
    await h.execute(counter().cmd(1));
    await h.undo();
    expect(n).toBe(2);
  });
});
```

Run: `bun test test/history.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 2: Implement `client/editor3d/history.ts`**

```ts
// Undo and redo for the 3D editor, after three.js editor's History.js: one
// command per finished gesture, each able to run and to undo itself. Commands
// carry model data (a ref and its holes before and after), never scene
// objects, so they survive the scene being rebuilt under them.
//
// Only layout changes go on this stack. Schematic edits keep the server's
// backups instead; replaying them from here would race the file watcher.

export interface Command {
  label: string;
  /** Do it; false when the server refused, and then nothing is recorded. */
  run(): Promise<boolean>;
  undo(): Promise<boolean>;
}

export class History {
  private undos: Command[] = [];
  private redos: Command[] = [];
  private fns = new Set<() => void>();

  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }

  onChange(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  private changed() {
    for (const fn of this.fns) fn();
  }

  async execute(cmd: Command): Promise<boolean> {
    if (!(await cmd.run())) return false;
    this.undos.push(cmd);
    this.redos = [];
    this.changed();
    return true;
  }

  async undo(): Promise<boolean> {
    const cmd = this.undos.pop();
    if (!cmd) return false;
    if (!(await cmd.undo())) {
      this.undos.push(cmd);
      return false;
    }
    this.redos.push(cmd);
    this.changed();
    return true;
  }

  async redo(): Promise<boolean> {
    const cmd = this.redos.pop();
    if (!cmd) return false;
    if (!(await cmd.run())) {
      this.redos.push(cmd);
      return false;
    }
    this.undos.push(cmd);
    this.changed();
    return true;
  }

  clear() {
    this.undos = [];
    this.redos = [];
    this.changed();
  }
}

export const history = new History();
```

Run: `bun test test/history.test.ts`. Expected: PASS.

- [ ] **Step 3: Route moves through history, and add R and Shift+R**

In `manipulate.ts`, import `history` and `rotateLead2`, `flipDip`. Add:

```ts
/** A move as an undoable command: the holes before and after, nothing else. */
export function moveCommand(ref: string, before: Record<string, Hole>, after: Record<string, Hole>, label = `move ${ref}`) {
  return { label, run: () => commitMove(ref, after), undo: () => commitMove(ref, before) };
}
```

In `onUp`'s drag branch, replace `void commitMove(d.ref, d.holes);` with `void history.execute(moveCommand(d.ref, d.origin, d.holes));`.

Add the rotate and flip key handler inside `attachManipulation`, next to `offKey`:

```ts
  const offTurn = addKeyHandler((e) => {
    if (e.key !== 'r' && e.key !== 'R') return false;
    const p = store.get().project;
    const ref = p?.selectedRef;
    if (!p || !ref || e.ctrlKey || e.metaKey) return false;
    const holes = p.doc.pinHoles[ref];
    const part = p.doc.parts.find((x) => x.id === ref);
    const pkg = p.doc.packages.find((x) => x.id === ref);
    let next: Record<string, Hole> | null = null;
    if (e.shiftKey) {
      if (pkg?.kind !== 'dip') return toast('Only chips flip; R turns a two-lead part'), true;
      next = flipDip(holes);
    } else {
      if (part?.kind !== 'lead2') return toast(pkg ? 'Chips only flip: Shift+R' : 'This part does not turn'), true;
      next = rotateLead2(holes, [part.pins[0], part.pins[1]]);
    }
    const verdict = next ? validatePlacement(p.doc, p.design, ref, next) : { ok: false, reason: 'the turned leg would leave the board' };
    if (!next || !verdict.ok) return toast(`Can't ${e.shiftKey ? 'flip' : 'turn'} ${ref}: ${verdict.reason}`), true;
    void history.execute(moveCommand(ref, holes, next, `${e.shiftKey ? 'flip' : 'turn'} ${ref}`));
    return true;
  });
```

Call `offTurn()` in the cleanup. **Clear history when the project changes:** in `workspace.ts`'s `push`, when `q.doc !== mountedDoc` *and* `q.id` differs from the id it opened with, call `history.clear()`. Also call `history.clear()` in `close()`.

- [ ] **Step 4: Undo/redo buttons and keys in `workspace.ts`**

```ts
  const undoBtn = root.querySelector<HTMLButtonElement>('[data-ws=undo]')!;
  const redoBtn = root.querySelector<HTMLButtonElement>('[data-ws=redo]')!;
  const paintHistory = () => {
    undoBtn.disabled = !history.canUndo;
    redoBtn.disabled = !history.canRedo;
  };
  const offHistory = history.onChange(paintHistory);
  paintHistory();
```

In the `.ws-bar` click handler, add `if (what === 'undo') void history.undo();` and `if (what === 'redo') void history.redo();`. In `onKey`, before the key-handler loop:

```ts
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      void (e.shiftKey ? history.redo() : history.undo());
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      void history.redo();
      return;
    }
```

Call `offHistory()` in `close()`.

- [ ] **Step 5: e2e scenarios**

```ts
  async 'R turns a resistor and Ctrl+Z puts it back'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`))[0];
    const before = await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    // Several quarter turns may be refused on a crowded board; press until one lands, at most 3.
    let turned = false;
    for (let i = 0; i < 3 && !turned; i++) {
      await page.key('r', 'KeyR');
      await sleep(600);
      turned = (await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`)) !== before;
    }
    if (!turned) return console.log('     (no legal quarter turn for this part on this board; undo path not exercised)');
    await page.key('z', 'KeyZ', 2 /* ctrl */);
    await page.until(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)})) === ${JSON.stringify(before)}`, 'undo to restore the holes');
  },
  async 'Shift+R flips a chip end for end'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.chips()`))[0];
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.key('R', 'KeyR', 8 /* shift */);
    await page.until(`__e3d.holes(${JSON.stringify(ref)})['1'].row === 'e'`, 'pin 1 to move to row e');
  },
```

Add `lead2: () => store.get().project?.doc.parts.filter((x) => x.kind === 'lead2').map((x) => x.id) ?? []` and `select: (ref: string) => store.setProject({ selectedRef: ref })` to the `__e3d` hook.

- [ ] **Step 6: Run everything**

Run: `bun run typecheck; bun test; bun run build; bun scripts/e2e-3d.ts`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add client/editor3d/history.ts test/history.test.ts client/editor3d/manipulate.ts client/editor3d/workspace.ts scripts/e2e-3d.ts
git commit -m "feat(3d): undo/redo for layout changes; R turns a two-lead part, Shift+R flips a chip"
```

---

### Task 8: The part card (value, pins, delete, focus)

**Files:**
- Create: `client/editor3d/card.ts`
- Modify: `client/api.ts` (`editValue`, `editRemove`)
- Modify: `client/editor3d/workspace.ts` (attach the card; Delete key)
- Modify: `client/styles.css` (`.ws-card*`)
- Modify: `scripts/e2e-3d.ts`

**Interfaces:**
- Consumes: `Board3D.anchor/onFrame/focus`, `loadProject` (`client/main.ts`), `moveCommand`/`history`, `rotateLead2`, `flipDip`.
- Produces: `export function attachCard(ws: Workspace): () => void`; `api.editValue(id, ref, value): Promise<unknown>`; `api.editRemove(id, ref): Promise<unknown>`.

- [ ] **Step 1: API wrappers** (in `client/api.ts`, inside `api`)

```ts
  editValue: (id: string, ref: string, value: string) => post<unknown>(`/api/projects/${id}/edit/value`, { ref, value }),
  editRemove: (id: string, ref: string) => post<unknown>(`/api/projects/${id}/edit/remove`, { ref }),
```

- [ ] **Step 2: e2e scenarios first**

```ts
  async 'the card edits a value and survives the reload'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`)).find(() => true)!;
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.until(`document.querySelector('.ws-card')?.dataset.ref === ${JSON.stringify(ref)}`, 'the card');
    await page.eval(`(() => { const i = document.querySelector('.ws-card input[name=value]'); i.value = '4.7k'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await page.until(`document.querySelector('.ws-card input[name=value]')?.value === '4.7k' && !document.querySelector('.ws-card.is-busy')`, 'the new value after reload', 20000);
  },
  async 'card closes when its part disappears'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`)).at(-1)!;
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.until(`document.querySelector('.ws-card')`, 'the card');
    await page.eval(`document.querySelector('.ws-card [data-card=delete]').click()`);
    await page.eval(`document.querySelector('.ws-card [data-card=confirm]').click()`);
    await page.until(`!__e3d.parts().includes(${JSON.stringify(ref)})`, `${ref} to be removed`, 20000);
    await page.until(`!document.querySelector('.ws-card')`, 'the card to close');
  },
```

The second scenario edits the scratch copy of the fixture, which is thrown away with the temp dir.

Run the scenarios and expect FAIL (there's no card yet).

- [ ] **Step 3: Write `client/editor3d/card.ts`**

```ts
// The floating card beside the selected part: what it is, its value (edited
// in place), its pins and their nets, and what can be done to it. It rides
// the part on screen, re-projected each frame only when it has actually
// moved, and flips below the part when there is no room above.
//
// Delete asks inside the card. A browser dialog would block the page's
// event loop, the render loop with it, and every automation driving it.

import { flipDip, rotateLead2, validatePlacement } from '../../src/edit/placement.ts';
import { api } from '../api.ts';
import { esc, loadProject, toast } from '../main.ts';
import { store } from '../state.ts';
import { history } from './history.ts';
import { moveCommand } from './manipulate.ts';
import type { Workspace } from './workspace.ts';

const short = (net: string) => net.split('/').filter(Boolean).pop() ?? net;

export function attachCard(ws: Workspace): () => void {
  const card = document.createElement('div');
  card.className = 'ws-card';
  card.hidden = true;
  ws.canvasHost.appendChild(card);
  let shownFor: string | null = null;
  let docFor: unknown = null;
  let last = '';

  const render = () => {
    const p = store.get().project;
    const ref = p?.selectedRef ?? null;
    // Gone after a reload (deleted, renumbered): close rather than point at nothing.
    if (!p || !ref || !p.doc.pinHoles[ref]) {
      card.hidden = true;
      shownFor = null;
      return;
    }
    if (ref === shownFor && p.doc === docFor) return;
    shownFor = ref;
    docFor = p.doc;
    const comp = p.design.components.get(ref);
    const part = p.doc.parts.find((x) => x.id === ref);
    const pkg = p.doc.packages.find((x) => x.id === ref);
    const pins = Object.entries(p.doc.pinHoles[ref]).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
    card.dataset.ref = ref;
    card.hidden = false;
    card.innerHTML =
      `<header><b>${esc(ref)}</b><span>${esc(pkg?.name ?? part?.style ?? comp?.part ?? '')}</span><button type="button" class="ws-card-x" data-card="close" title="Deselect (Esc)">×</button></header>` +
      `<label>Value <input name="value" value="${esc(comp?.value ?? part?.value ?? '')}" spellcheck="false"></label>` +
      `<ul class="ws-card-pins">${pins.map(([pin, h]) => {
        const net = comp?.pins.get(pin)?.net ?? '';
        return `<li><span>${esc(pin)}</span><span>${esc(h.row + h.col)}</span>${net ? `<button type="button" data-net="${esc(net)}" title="follow this net">${esc(short(net))}</button>` : '<i>unconnected</i>'}</li>`;
      }).join('')}</ul>` +
      '<footer>' +
      (part?.kind === 'lead2' ? '<button type="button" data-card="rotate" title="R">Rotate</button>' : '') +
      (pkg?.kind === 'dip' ? '<button type="button" data-card="flip" title="Shift+R">Flip</button>' : '') +
      '<button type="button" data-card="focus" title="F">Focus</button>' +
      '<button type="button" data-card="delete" class="danger" title="Delete">Delete</button>' +
      '</footer><div class="ws-card-confirm" hidden>Remove ' + esc(ref) + ' from the schematic? A backup is kept. <button type="button" data-card="confirm" class="danger">Remove</button><button type="button" data-card="cancel">Keep</button></div>';
    last = '';
  };

  const place = () => {
    if (card.hidden || !shownFor) return;
    const a = ws.board.anchor(shownFor);
    if (!a) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const host = ws.canvasHost.getBoundingClientRect();
    const pad = 12;
    let x = a.x - w / 2;
    let y = a.y - h - 18;
    if (y < pad) y = a.y + 28;
    x = Math.min(Math.max(pad, x), host.width - w - pad);
    y = Math.min(Math.max(pad, y), host.height - h - pad);
    const key = `${Math.round(x)},${Math.round(y)},${a.visible}`;
    if (key === last) return;
    last = key;
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    card.style.visibility = a.visible ? 'visible' : 'hidden';
  };

  const busy = async (work: () => Promise<unknown>) => {
    const p = store.get().project;
    if (!p) return;
    card.classList.add('is-busy');
    try {
      await work();
      await loadProject(p.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      card.classList.remove('is-busy');
    }
  };

  card.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name !== 'value' || e.key !== 'Enter') return;
    e.preventDefault();
    const p = store.get().project;
    const ref = shownFor;
    if (!p || !ref) return;
    const value = input.value.trim();
    if (!value) return toast('A value cannot be empty');
    // After the reload, keep the same part selected so the card comes back.
    void busy(() => api.editValue(p.id, ref, value)).then(() => store.setProject({ selectedRef: ref }));
  });

  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const net = t.closest<HTMLElement>('[data-net]')?.dataset.net;
    if (net) return store.setProject({ highlight: { net, soft: true }, activeStep: null });
    const what = t.closest<HTMLElement>('[data-card]')?.dataset.card;
    const p = store.get().project;
    const ref = shownFor;
    if (!what || !p || !ref) return;
    const confirm = card.querySelector<HTMLElement>('.ws-card-confirm')!;
    if (what === 'close') store.setProject({ selectedRef: null });
    if (what === 'focus') ws.board.focus(ref);
    if (what === 'delete') confirm.hidden = false;
    if (what === 'cancel') confirm.hidden = true;
    if (what === 'confirm') void busy(() => api.editRemove(p.id, ref)).then(() => store.setProject({ selectedRef: null }));
    if (what === 'rotate' || what === 'flip') {
      const holes = p.doc.pinHoles[ref];
      const part = p.doc.parts.find((x) => x.id === ref);
      const next = what === 'flip' ? flipDip(holes) : part ? rotateLead2(holes, [part.pins[0], part.pins[1]]) : null;
      const verdict = next ? validatePlacement(p.doc, p.design, ref, next) : null;
      if (!next || !verdict?.ok) return toast(`Can't ${what === 'flip' ? 'flip' : 'turn'} ${ref}: ${verdict?.reason ?? 'the turned leg would leave the board'}`);
      void history.execute(moveCommand(ref, holes, next, `${what} ${ref}`));
    }
  });

  const offStore = store.subscribe(render);
  const offFrame = ws.board.onFrame(place);
  render();
  return () => {
    offStore();
    offFrame();
    card.remove();
  };
}
```

- [ ] **Step 4: Attach it, and bind the Delete key**

In `workspace.ts`, import `attachCard`, call `const detachCard = attachCard(ws);` after `attachManipulation`, and call `detachCard()` in `close()`. Also register:

```ts
  const offDel = addKeyHandler((e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    const confirm = root.querySelector<HTMLElement>('.ws-card:not([hidden]) .ws-card-confirm');
    if (!confirm) return false;
    confirm.hidden = false;
    confirm.querySelector<HTMLButtonElement>('[data-card=confirm]')!.focus();
    return true;
  });
```

and call `offDel()` in `close()`.

- [ ] **Step 5: Card styles** (append to `client/styles.css`)

```css
.ws-card {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  width: 250px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(18, 21, 29, .94);
  border: 1px solid rgba(77, 163, 255, .45);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  font-size: 12.5px;
  will-change: transform;
}
.ws-card.is-busy { opacity: .6; pointer-events: none; }
.ws-card header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.ws-card header span { opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-card-x { margin-left: auto; background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; opacity: .7; }
.ws-card label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ws-card input { flex: 1; min-width: 0; padding: 3px 6px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, .2); background: rgba(0, 0, 0, .3); color: inherit; font: inherit; }
.ws-card-pins { list-style: none; margin: 0 0 8px; padding: 0; max-height: 150px; overflow: auto; }
.ws-card-pins li { display: grid; grid-template-columns: 2.5em 3.5em 1fr; gap: 6px; align-items: center; padding: 1px 0; }
.ws-card-pins button { justify-self: start; background: rgba(255, 255, 255, .08); border: 0; border-radius: 8px; padding: 1px 7px; color: inherit; cursor: pointer; font: inherit; }
.ws-card-pins i { opacity: .5; }
.ws-card footer { display: flex; flex-wrap: wrap; gap: 6px; }
.ws-card footer button, .ws-card-confirm button { padding: 3px 9px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(40, 44, 52, .8); color: inherit; cursor: pointer; font: inherit; }
.ws-card .danger { border-color: rgba(239, 68, 68, .6); }
.ws-card-confirm { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .1); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
```

- [ ] **Step 6: Run everything**

Run: `bun run typecheck; bun test; bun run build; bun scripts/e2e-3d.ts`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add client/editor3d/card.ts client/api.ts client/editor3d/workspace.ts client/styles.css scripts/e2e-3d.ts
git commit -m "feat(3d): floating part card: edit value, follow pin nets, rotate, flip, focus, delete with in-card confirm"
```

---

### Task 9: Documentation for people and for LLM agents

**Files:**
- Create: `docs/editor3d.md`, `AGENTS.md`, `CLAUDE.md`
- Modify: `README.md` (new section after "## Run")

**Interfaces:**
- Consumes: everything above. The docs must describe the code as it actually shipped, so read the final `workspace.ts` key handler before writing the shortcut table.
- Produces: the three documents. Phases 2 and 3 extend them.

- [ ] **Step 1: Write `docs/editor3d.md`** with these sections, filled in with real content:
  - **Opening and closing:** the 3D button; Esc, Back and Exit close it.
  - **Moving around:** orbit, pan and zoom; fly mode keys; F behaviour with and without a selection.
  - **Selecting and moving parts:**
    - click to select;
    - drag the selected part;
    - what the green and red strip tints mean;
    - refusal reasons with examples: taken hole, off the board, shorts two nets, shorts itself, chip not across the channel.
  - **Turning and flipping:** R for two-lead parts, Shift+R for chips; why most quarter turns of a resistor inside one half are refused.
  - **The part card:** value editing, pins and nets, Delete (with the backup note).
  - **Undo:** what it covers (moves, turns, flips) and what it doesn't (schematic edits, which have server backups under the project's backup folder).
  - **What changes what:** a table with columns *Action* · *Changes the layout sidecar* · *Changes the .kicad_sch*.
  - **Shortcut table.**
  - **Troubleshooting:** "3D is blank" (WebGL off), "part won't move" (read the hint line), "my change vanished" (a reload after an on-disk schematic change resets the selection and history).
  - **Coming next:** phases 2 and 3, one line each.
  - **References:** the research links from spec §2 (Tinkercad help, Fritzing reference, Wokwi diagram editor, libavoid paper, three.js OutlinePass/TransformControls docs, WCAG 2.5.7).

- [ ] **Step 2: Write `AGENTS.md`** (for LLM agents; terse and factual):

```markdown
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
- Schematic changes go through `/api/projects/:id/edit/*` → `Service.edit` (it backs up first). The client then calls `loadProject(id)`.
- `src/**`, `client/editor3d/history.ts` and `client/editor3d/focus-math.ts` stay free of DOM and three.js.
- `Package.flipped` is `true` or absent, never `false`, so unflipped docs serialize exactly as before.
- In the scene, every part/package group has `userData.ref` and is on raycast layer 1. Jackets are on layer 2, switch ways on layer 3.
- The editor decides drag vs orbit on `pointerdown` (capture phase) and calls `board.setOrbit(false)` synchronously.
- No `window.confirm`/`alert`/`prompt` anywhere in the client.
- Commits: no Co-Authored-By / Claude-Session / Generated-with footers.

## Testing notes
- three.js code has no unit tests (no WebGL in Bun). Cover it with `scripts/e2e-3d.ts`. The `?e2e` URL flag exposes `window.__e3d` (`ready`, `parts`, `lead2`, `chips`, `holes`, `select`, `selected`, `screenOf`, `tintCount`).
- Don't measure UI timing in the Chrome MCP tab: it is a background tab clamped to 1 s timers. Use the headless harness.

## Design docs
- `docs/superpowers/specs/2026-09-29-3d-editor-workspace-design.md`: the 3D editor spec (phases 1 to 3).
- `docs/superpowers/plans/`: implementation plans.
- `docs/editor3d.md`: the user guide.
```

- [ ] **Step 3: Write `CLAUDE.md`**

```markdown
Read AGENTS.md in this directory. It is the guide for AI agents working on this project (commands, module map, invariants, testing).
```

- [ ] **Step 4: README section.** After the `## Run` section of `README.md`, add:

```markdown
## 3D editor

Press **3D** on a project to open the full-screen 3D editor. Click a part to select it, then drag it to new holes, turn it (R), flip a chip (Shift+R), edit its value or delete it from the card beside it, and press F to fly to it. Ctrl+Z undoes layout changes. See [docs/editor3d.md](docs/editor3d.md). Agents working on the code should read [AGENTS.md](AGENTS.md).
```

- [ ] **Step 5: Check the links and the facts**

Run: `bun -e "for (const f of ['docs/editor3d.md','AGENTS.md','CLAUDE.md','README.md']) { const t = await Bun.file(f).text(); for (const m of t.matchAll(/\]\(([^)#]+)\)/g)) if (!m[1].startsWith('http') && !(await Bun.file(m[1]).exists())) console.log(f, 'broken link', m[1]); }"`
Expected: no output.

Also re-read the shortcut table in `docs/editor3d.md` against `workspace.ts` and `manipulate.ts`; every key listed must be one the code handles.

- [ ] **Step 6: Final gate for the phase**

Run: `bun run typecheck; bun test; bun run build; bun scripts/e2e-3d.ts`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add docs/editor3d.md AGENTS.md CLAUDE.md README.md
git commit -m "docs: 3D editor guide, AGENTS.md for coding agents, README section"
```

---

## Self-review (done while writing)

- **Spec coverage (phase 1):**

  | Spec section | Task(s) |
  |---|---|
  | §4.1 shell | 4 |
  | §4.2 selection | 3, 5 |
  | §4.3 move | 6 |
  | §4.4 validation | 1, 6 (plus the engine preview in Task 6) |
  | §4.5 rotate/flip | 1, 2, 7 |
  | §4.6 card | 8 |
  | §4.7 focus | 3, 5, 8 |
  | §4.8 undo | 7 |
  | §7 errors | 6, 8 (toasts, store untouched on refusal) |
  | §9 testing | every task |
  | §10 docs | 9 |

  - Phase 2 (wires) and phase 3 (tray, jumpers, Duplicate) are out of this plan by design.
  - WebGL context loss (§7) is not handled here. It moves to the phase 2 plan, where `board3d.ts` is touched again; noted here so it isn't lost.
- **Types line up across tasks:** `Tint`/`Verdict` are defined in Task 1 and used in 3 and 6. `commitMove`/`moveCommand` are defined in 6–7 and used in 8. `history` is defined in 7 and used in 8. The `__e3d` members are added in the task whose scenario needs them.
- **No placeholders:** every code step shows its code. Task 3 Step 3 describes a mechanical move of existing lines into `build()` and gives the exact returned shape plus the new code; there is no new logic to invent there.
