# Circuit AI Tool Implementation Plan, part 1a: project scaffold and KiCad parsing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the Bun + TypeScript project and the pure modules that read a `.kicad_sch` file and a kicad-cli netlist into typed models, with pin positions that match KiCad.

**Architecture:** Everything in `src/` is pure TypeScript with no I/O, so it runs in the browser and on the server. This part delivers `src/sexpr.ts` (S-expression reader with source spans), `src/kicad/schematic.ts` (schematic model), `src/kicad/transform.ts` (symbol rotation and mirror math) and `src/netlist.ts` (kicad-cli netlist to `Design`). Parts 1b and 1c build the catalog, layout engine, checks, simulator, guide and renderer on top of these.

**Tech Stack:** Bun 1.3 (runtime and `bun test`), TypeScript 5.9, no runtime dependencies in this part.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md`

## Global Constraints

- Project root is `C:\Users\rober\Desktop\university-tools\circut-ai-tool` (keep the folder name as it is).
- Bun 1.3 runs TypeScript directly; there is no server build step. Tests run with `bun test`.
- `src/` must not import from `node:fs`, `node:child_process` or any I/O module. Only `server/`, `scripts/` and `test/` may.
- Coordinates from KiCad are millimetres; keep four decimals (`round4`).
- Commit after every task. Commit messages: `feat:`, `test:`, `chore:` prefixes; end the message body with the attribution trailer the session uses (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the `Claude-Session:` line).
- The Bash tool in this environment mangles backslashes inside heredocs. Write files with the Write tool, not `cat <<EOF`.
- Never `rm -rf` a path that could be an original project folder (see `INCIDENT-2026-09-03-folder-deletion.md` at the repo root).

---

### Task 1: Project scaffold and fixtures

**Files:**
- Create: `circut-ai-tool/package.json`
- Create: `circut-ai-tool/tsconfig.json`
- Create: `circut-ai-tool/README.md`
- Create: `circut-ai-tool/test/fixtures/PL1_1.kicad_sch` (copied)
- Create: `circut-ai-tool/test/fixtures/PL1_1.net` (exported)
- Create: `circut-ai-tool/test/smoke.test.ts`

**Interfaces:**
- Produces: `bun test` runs; fixtures `test/fixtures/PL1_1.kicad_sch` and `test/fixtures/PL1_1.net` exist for every later test.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "circuit-ai-tool",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Turn a KiCad schematic into a breadboard wiring diagram, with a build guide, checks, logic simulation, REST API and MCP server.",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "breadboard": "bun scripts/breadboard.ts"
  },
  "engines": { "bun": ">=1.3" },
  "devDependencies": {
    "@types/bun": "^1.3.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  },
  "include": ["src", "server", "client", "scripts", "test"]
}
```

- [ ] **Step 3: Write README.md**

```markdown
# Circuit AI Tool

Turns a KiCad schematic into a breadboard wiring diagram with a step-by-step
build guide, wiring checks and a logic simulator, and exposes everything as a
REST API and an MCP server for Claude Desktop, Claude Code and ChatGPT.

Design: `docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md`.

## Develop

    bun install
    bun test
    bun run breadboard path/to/project.kicad_sch    # writes layout JSON and SVG next to it
```

- [ ] **Step 4: Copy the fixtures**

Run from the repo root (PowerShell):

```powershell
New-Item -ItemType Directory -Force circut-ai-tool/test/fixtures | Out-Null
Copy-Item "$env:USERPROFILE/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch" circut-ai-tool/test/fixtures/PL1_1.kicad_sch
& "$env:LOCALAPPDATA/Programs/KiCad/9.0/bin/kicad-cli.exe" sch export netlist --format kicadsexpr -o circut-ai-tool/test/fixtures/PL1_1.net circut-ai-tool/test/fixtures/PL1_1.kicad_sch
Get-ChildItem circut-ai-tool/test/fixtures
```

Expected: both files listed, the `.kicad_sch` about 117 KB, the `.net` about 19 KB.

- [ ] **Step 5: Write the smoke test**

`test/smoke.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const FIXTURES = path.join(import.meta.dir, 'fixtures');
export const readFixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

describe('fixtures', () => {
  test('PL1_1 schematic and netlist are present', () => {
    expect(readFixture('PL1_1.kicad_sch').startsWith('(kicad_sch')).toBe(true);
    expect(readFixture('PL1_1.net').startsWith('(export')).toBe(true);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `cd circut-ai-tool && bun install && bun test`
Expected: `1 pass, 0 fail`.

- [ ] **Step 7: Commit**

```bash
git add circut-ai-tool/package.json circut-ai-tool/tsconfig.json circut-ai-tool/README.md circut-ai-tool/test circut-ai-tool/bun.lock
git commit -m "chore(circuit): scaffold Bun project with PL1_1 fixtures"
```

---

### Task 2: S-expression reader and writer

**Files:**
- Create: `circut-ai-tool/src/sexpr.ts`
- Test: `circut-ai-tool/test/sexpr.test.ts`

**Interfaces:**
- Produces:
  - `type Atom = { type: 'atom'; value: string; quoted: boolean; start: number; end: number }`
  - `type List = { type: 'list'; items: Node[]; start: number; end: number }`, `type Node = Atom | List`
  - `parse(text: string): List` (root list whose `items` are the top-level nodes; every node carries byte offsets into `text`)
  - `head(l: List): string | undefined`, `child(l: List, key: string): List | undefined`, `children(l: List, key: string): List[]`, `atom(l: List, i: number): string | undefined`, `num(l: List, i: number): number`, `isList(n: Node): n is List`
  - Builder for new text: `type B = string | number | { q: string } | B[]`, `q(s: string): { q: string }`, `serialize(b: B, indent?: number): string`

- [ ] **Step 1: Write the failing tests**

`test/sexpr.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { atom, child, children, head, isList, num, parse, q, serialize } from '../src/sexpr.ts';
import { readFixture } from './smoke.test.ts';

describe('sexpr parse', () => {
  test('parses atoms, quoted strings with escapes and nested lists with spans', () => {
    const text = '(a 1 "two \\"2\\"" (b -3.5 c))';
    const root = parse(text);
    expect(root.items).toHaveLength(1);
    const a = root.items[0];
    if (!isList(a)) throw new Error('expected list');
    expect(head(a)).toBe('a');
    expect(num(a, 1)).toBe(1);
    expect(atom(a, 2)).toBe('two "2"');
    const b = child(a, 'b');
    expect(b && num(b, 1)).toBe(-3.5);
    expect(a.start).toBe(0);
    expect(a.end).toBe(text.length);
    expect(text.slice(b!.start, b!.end)).toBe('(b -3.5 c)');
  });

  test('children returns every list with the given head', () => {
    const root = parse('(x (pin 1) (pin 2) (name n))');
    const x = root.items[0] as ReturnType<typeof parse>;
    expect(children(x, 'pin')).toHaveLength(2);
  });

  test('rejects unbalanced input', () => {
    expect(() => parse('(a (b)')).toThrow();
    expect(() => parse('a)')).toThrow();
  });

  test('parses the PL1_1 schematic', () => {
    const root = parse(readFixture('PL1_1.kicad_sch'));
    const sch = root.items[0];
    if (!isList(sch)) throw new Error('expected list');
    expect(head(sch)).toBe('kicad_sch');
    expect(children(sch, 'symbol')).toHaveLength(35);
    expect(children(sch, 'wire')).toHaveLength(53);
  });
});

describe('sexpr serialize', () => {
  test('writes quoted strings, numbers and nested lists KiCad style', () => {
    const out = serialize(['symbol', ['lib_id', q('Device:R')], ['at', 10, 20.5, 0], ['property', q('Value'), q('10k "ohm"')]]);
    expect(out).toBe(
      '(symbol\n\t(lib_id "Device:R")\n\t(at 10 20.5 0)\n\t(property "Value" "10k \\"ohm\\"")\n)',
    );
  });

  test('round-trips through parse', () => {
    const text = serialize(['a', q('b c'), ['d', 1]]);
    const root = parse(text);
    expect(atom(root.items[0] as ReturnType<typeof parse>, 1)).toBe('b c');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/sexpr.test.ts`
Expected: FAIL, "Cannot find module '../src/sexpr.ts'".

- [ ] **Step 3: Write src/sexpr.ts**

```ts
// KiCad S-expression reader and writer.
//
// parse() keeps the byte span of every node so the schematic writer can
// replace or delete exact ranges of the original text without reformatting
// anything it did not touch. serialize() produces KiCad-style text for new
// nodes (one child list per line, tab indented); KiCad accepts any whitespace.

export interface Atom {
  type: 'atom';
  value: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface List {
  type: 'list';
  items: Node[];
  start: number;
  end: number;
}

export type Node = Atom | List;

export class SexprError extends Error {}

export function isList(n: Node | undefined): n is List {
  return !!n && n.type === 'list';
}

export function parse(text: string): List {
  const root: List = { type: 'list', items: [], start: 0, end: text.length };
  const stack: List[] = [root];
  const n = text.length;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      stack.push({ type: 'list', items: [], start: i, end: -1 });
      i++;
      continue;
    }
    if (c === ')') {
      if (stack.length < 2) throw new SexprError(`unexpected ')' at offset ${i}`);
      const done = stack.pop()!;
      done.end = i + 1;
      top().items.push(done);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < n) {
          const e = text[j + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          v += text[j];
          j++;
        }
      }
      if (j >= n) throw new SexprError(`unterminated string at offset ${i}`);
      top().items.push({ type: 'atom', value: v, quoted: true, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !isDelimiter(text[j])) j++;
    top().items.push({ type: 'atom', value: text.slice(i, j), quoted: false, start: i, end: j });
    i = j;
  }
  if (stack.length !== 1) throw new SexprError('unbalanced input: missing ")"');
  return root;
}

function isDelimiter(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '(' || c === ')' || c === '"';
}

export function head(l: List): string | undefined {
  const first = l.items[0];
  return first && first.type === 'atom' ? first.value : undefined;
}

export function child(l: List, key: string): List | undefined {
  for (const it of l.items) if (isList(it) && head(it) === key) return it;
  return undefined;
}

export function children(l: List, key: string): List[] {
  return l.items.filter((it): it is List => isList(it) && head(it) === key);
}

export function atom(l: List, i: number): string | undefined {
  const it = l.items[i];
  return it && it.type === 'atom' ? it.value : undefined;
}

export function num(l: List, i: number): number {
  const v = Number(atom(l, i));
  if (Number.isNaN(v)) throw new SexprError(`expected a number at item ${i} of (${head(l)} ...)`);
  return v;
}

// ---------- writer ----------

export type B = string | number | { q: string } | B[];

export const q = (s: string): { q: string } => ({ q: s });

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** KiCad-style text: atoms of a list on the head line, child lists on their own lines. */
export function serialize(b: B, indent = 0): string {
  if (typeof b === 'number') return formatNumber(b);
  if (typeof b === 'string') return b;
  if (!Array.isArray(b)) return quote(b.q);
  const pad = '\t'.repeat(indent);
  const inner = '\t'.repeat(indent + 1);
  const atoms: string[] = [];
  const lists: B[] = [];
  for (const it of b) (Array.isArray(it) ? lists : atoms).push(Array.isArray(it) ? it : serialize(it));
  if (!lists.length) return `(${atoms.join(' ')})`;
  return `(${atoms.join(' ')}\n${lists.map((l) => inner + serialize(l, indent + 1)).join('\n')}\n${pad})`;
}

export function formatNumber(v: number): string {
  const r = Math.round(v * 10000) / 10000;
  return Number.isInteger(r) ? String(r) : String(r);
}

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/sexpr.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/src/sexpr.ts circut-ai-tool/test/sexpr.test.ts
git commit -m "feat(circuit): S-expression reader with spans and KiCad-style writer"
```

---

### Task 3: Schematic model and symbol transform

**Files:**
- Create: `circut-ai-tool/src/kicad/schematic.ts`
- Create: `circut-ai-tool/src/kicad/transform.ts`
- Test: `circut-ai-tool/test/schematic.test.ts`

**Interfaces:**
- Produces (schematic.ts):
  - `interface Point { x: number; y: number }`
  - `interface LibPin { number: string; name: string; type: string; at: Point; angle: 0 | 90 | 180 | 270; length: number }`
  - `interface LibSymbol { id: string; name: string; extends: string | null; power: boolean; units: Map<number, LibPin[]>; unitCount: number; node: List }`
  - `interface SymbolInstance { uuid: string; libId: string; at: Point; rot: 0 | 90 | 180 | 270; mirror: 'x' | 'y' | null; unit: number; ref: string; value: string; properties: Record<string, string>; pinUuids: Map<string, string>; node: List }`
  - `interface Label { kind: 'label' | 'global_label' | 'hierarchical_label'; text: string; at: Point; rot: number; uuid: string; node: List }`
  - `interface SchWire { uuid: string; pts: Point[]; node: List }`
  - `interface Schematic { text: string; root: List; uuid: string; project: string; paper: string; libSymbols: Map<string, LibSymbol>; libSymbolsNode: List | null; symbols: SymbolInstance[]; labels: Label[]; wires: SchWire[]; junctions: Point[]; noConnects: Point[]; sheets: number; buses: number }`
  - `parseSchematic(text: string, fallbackProject?: string): Schematic`
  - `pinsOfUnit(lib: LibSymbol, unit: number): LibPin[]` (unit 0 pins plus the unit's own pins, deduplicated by pin number)
  - `powerUnit(lib: LibSymbol): number | null` (the unit whose pins are all `power_in`, for multi-unit chips)
- Produces (transform.ts):
  - `interface Matrix { x1: number; y1: number; x2: number; y2: number }`
  - `symbolMatrix(rot: number, mirror: 'x' | 'y' | null): Matrix`
  - `apply(m: Matrix, p: Point): Point`
  - `pinPosition(sym: { at: Point; rot: number; mirror: 'x' | 'y' | null }, pin: { at: Point }): Point` (schematic coordinates of the pin's connection end)
  - `pinBodyDirection(sym, pin: { angle: number }): Point` (unit vector from the pin end toward the symbol body, schematic coordinates)

- [ ] **Step 1: Write the failing tests**

`test/schematic.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit, powerUnit } from '../src/kicad/schematic.ts';
import { apply, pinBodyDirection, pinPosition, symbolMatrix } from '../src/kicad/transform.ts';
import { readFixture } from './smoke.test.ts';

const sch = parseSchematic(readFixture('PL1_1.kicad_sch'), 'PL1_1');

describe('parseSchematic', () => {
  test('reads the header, symbols, labels, wires and junctions', () => {
    expect(sch.project).toBe('PL1_1');
    expect(sch.uuid).toHaveLength(36);
    expect(sch.symbols).toHaveLength(35);
    expect(sch.labels).toHaveLength(4);
    expect(sch.wires).toHaveLength(53);
    expect(sch.junctions).toHaveLength(9);
    expect(sch.libSymbols.size).toBe(10);
    expect(sch.sheets).toBe(0);
    expect(sch.buses).toBe(0);
  });

  test('symbol instances carry reference, value, unit, rotation and pin uuids', () => {
    const u2 = sch.symbols.filter((s) => s.ref === 'U2');
    expect(u2.map((s) => s.unit).sort()).toEqual([1, 2, 3]);
    expect(u2[0].value).toBe('74LS04');
    const sw = sch.symbols.find((s) => s.ref === 'SW1')!;
    expect(sw.rot).toBe(90);
    expect(sw.mirror).toBeNull();
    expect([...sw.pinUuids.keys()].sort()).toEqual(['1', '2']);
  });

  test('library symbols expose pins per unit and the power unit', () => {
    const lib = sch.libSymbols.get('74xx:74LS04')!;
    expect(lib.power).toBe(false);
    expect(lib.unitCount).toBe(7);
    expect(pinsOfUnit(lib, 1).map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(pinsOfUnit(lib, 7).map((p) => p.number).sort()).toEqual(['14', '7']);
    expect(powerUnit(lib)).toBe(7);
    const gnd = sch.libSymbols.get('power:GND')!;
    expect(gnd.power).toBe(true);
    expect(pinsOfUnit(gnd, 1)).toHaveLength(1);
  });
});

describe('transform', () => {
  test('orientation matrices follow KiCad (y flipped, 90 = counter-clockwise)', () => {
    expect(apply(symbolMatrix(0, null), { x: 1, y: 2 })).toEqual({ x: 1, y: -2 });
    expect(apply(symbolMatrix(90, null), { x: 1, y: 2 })).toEqual({ x: -2, y: -1 });
    expect(apply(symbolMatrix(180, null), { x: 1, y: 2 })).toEqual({ x: -1, y: 2 });
    expect(apply(symbolMatrix(270, null), { x: 1, y: 2 })).toEqual({ x: 2, y: 1 });
    expect(apply(symbolMatrix(0, 'x'), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(apply(symbolMatrix(0, 'y'), { x: 1, y: 2 })).toEqual({ x: -1, y: -2 });
  });

  test('a resistor at rotation 0 has pin 1 above its origin with the body below', () => {
    const sym = { at: { x: 100, y: 50 }, rot: 0, mirror: null };
    const pin1 = { at: { x: 0, y: 3.81 }, angle: 270 };
    expect(pinPosition(sym, pin1)).toEqual({ x: 100, y: 46.19 });
    expect(pinBodyDirection(sym, pin1)).toEqual({ x: 0, y: 1 });
  });

  test('every connected pin in PL1_1 touches a wire, junction, label or another pin', () => {
    const points = new Set<string>();
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const w of sch.wires) for (const p of w.pts) points.add(key(p));
    for (const j of sch.junctions) points.add(key(j));
    for (const l of sch.labels) points.add(key(l.at));
    const onWire = (p: { x: number; y: number }) =>
      sch.wires.some((w) =>
        w.pts.slice(1).some((b, i) => {
          const a = w.pts[i];
          const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
          return Math.abs(cross) < 1e-6 && p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
        }),
      );
    const pinEnds = new Map<string, number>();
    const ends: { ref: string; pin: string; p: { x: number; y: number } }[] = [];
    for (const s of sch.symbols) {
      const lib = sch.libSymbols.get(s.libId)!;
      for (const pin of pinsOfUnit(lib, s.unit)) {
        const p = pinPosition(s, pin);
        ends.push({ ref: s.ref, pin: pin.number, p });
        pinEnds.set(key(p), (pinEnds.get(key(p)) ?? 0) + 1);
      }
    }
    // The netlist lists every connected pin; power symbols connect by name and are skipped.
    const connected = new Set(
      [...readFixture('PL1_1.net').matchAll(/\(node \(ref "([^"]+)"\) \(pin "([^"]+)"\)/g)].map((m) => `${m[1]}/${m[2]}`),
    );
    const bad = ends.filter((e) => connected.has(`${e.ref}/${e.pin}`) && !points.has(key(e.p)) && !onWire(e.p) && pinEnds.get(key(e.p))! < 2);
    expect(connected.size).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/schematic.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/kicad/transform.ts**

```ts
// Symbol placement math, taken from KiCad's SCH_SYMBOL::SetOrientation.
//
// Library symbols use y-up coordinates; the schematic uses y-down. The
// default orientation matrix (1, 0, 0, -1) flips y. Rotations and mirrors
// are composed onto it exactly the way KiCad does, so pin positions computed
// here match the positions KiCad uses for connectivity.

import type { Point } from './schematic.ts';
import { round4 } from '../sexpr.ts';

export interface Matrix {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const ORIENT_0: Matrix = { x1: 1, y1: 0, x2: 0, y2: -1 };
const ROTATE_CCW: Matrix = { x1: 0, y1: 1, x2: -1, y2: 0 };
const ROTATE_CW: Matrix = { x1: 0, y1: -1, x2: 1, y2: 0 };
const MIRROR_X: Matrix = { x1: 1, y1: 0, x2: 0, y2: -1 };
const MIRROR_Y: Matrix = { x1: -1, y1: 0, x2: 0, y2: 1 };

function compose(m: Matrix, t: Matrix): Matrix {
  return {
    x1: m.x1 * t.x1 + m.x2 * t.y1,
    y1: m.y1 * t.x1 + m.y2 * t.y1,
    x2: m.x1 * t.x2 + m.x2 * t.y2,
    y2: m.y1 * t.x2 + m.y2 * t.y2,
  };
}

export function symbolMatrix(rot: number, mirror: 'x' | 'y' | null): Matrix {
  let m = ORIENT_0;
  if (rot === 90) m = compose(m, ROTATE_CCW);
  else if (rot === 180) m = compose(compose(m, ROTATE_CCW), ROTATE_CCW);
  else if (rot === 270) m = compose(m, ROTATE_CW);
  if (mirror === 'x') m = compose(m, MIRROR_X);
  if (mirror === 'y') m = compose(m, MIRROR_Y);
  return m;
}

export function apply(m: Matrix, p: Point): Point {
  return { x: round4(m.x1 * p.x + m.y1 * p.y), y: round4(m.x2 * p.x + m.y2 * p.y) };
}

export interface Placed {
  at: Point;
  rot: number;
  mirror: 'x' | 'y' | null;
}

/** Schematic coordinates of a pin's connection end. */
export function pinPosition(sym: Placed, pin: { at: Point }): Point {
  const d = apply(symbolMatrix(sym.rot, sym.mirror), pin.at);
  return { x: round4(sym.at.x + d.x), y: round4(sym.at.y + d.y) };
}

/** Unit vector from the pin end toward the symbol body, schematic coordinates. */
export function pinBodyDirection(sym: Placed, pin: { angle: number }): Point {
  const rad = (pin.angle * Math.PI) / 180;
  const v = apply(symbolMatrix(sym.rot, sym.mirror), { x: Math.round(Math.cos(rad)), y: Math.round(Math.sin(rad)) });
  return { x: v.x === 0 ? 0 : v.x, y: v.y === 0 ? 0 : v.y };
}
```

- [ ] **Step 4: Write src/kicad/schematic.ts**

```ts
// Typed view of a .kicad_sch file. Every model object keeps its List node so
// the writer (part 4) can find the exact text span to edit.

import { atom, child, children, isList, num, parse, type List } from '../sexpr.ts';

export interface Point {
  x: number;
  y: number;
}

export interface LibPin {
  number: string;
  name: string;
  type: string;
  at: Point;
  angle: 0 | 90 | 180 | 270;
  length: number;
}

export interface LibSymbol {
  /** Full id as written in lib_symbols, e.g. "74xx:74LS04". */
  id: string;
  /** Name without the library nickname, e.g. "74LS04". */
  name: string;
  extends: string | null;
  power: boolean;
  /** Unit number -> pins. Unit 0 holds pins common to every unit. */
  units: Map<number, LibPin[]>;
  unitCount: number;
  node: List;
}

export interface SymbolInstance {
  uuid: string;
  libId: string;
  at: Point;
  rot: 0 | 90 | 180 | 270;
  mirror: 'x' | 'y' | null;
  unit: number;
  ref: string;
  value: string;
  properties: Record<string, string>;
  pinUuids: Map<string, string>;
  node: List;
}

export interface Label {
  kind: 'label' | 'global_label' | 'hierarchical_label';
  text: string;
  at: Point;
  rot: number;
  uuid: string;
  node: List;
}

export interface SchWire {
  uuid: string;
  pts: Point[];
  node: List;
}

export interface Schematic {
  text: string;
  root: List;
  uuid: string;
  project: string;
  paper: string;
  libSymbols: Map<string, LibSymbol>;
  libSymbolsNode: List | null;
  symbols: SymbolInstance[];
  labels: Label[];
  wires: SchWire[];
  junctions: Point[];
  noConnects: Point[];
  sheets: number;
  buses: number;
}

export class SchematicError extends Error {}

function pointOf(l: List | undefined, fallback: Point = { x: 0, y: 0 }): Point {
  return l ? { x: num(l, 1), y: num(l, 2) } : fallback;
}

function rotOf(l: List | undefined): 0 | 90 | 180 | 270 {
  const r = l && l.items.length > 3 ? num(l, 3) : 0;
  const n = ((Math.round(r) % 360) + 360) % 360;
  if (n === 0 || n === 90 || n === 180 || n === 270) return n;
  throw new SchematicError(`unsupported rotation ${r}`);
}

function parseLibPin(p: List): LibPin {
  const at = child(p, 'at');
  return {
    number: atom(child(p, 'number')!, 1) ?? '',
    name: atom(child(p, 'name')!, 1) ?? '~',
    type: atom(p, 1) ?? 'unspecified',
    at: pointOf(at),
    angle: rotOf(at),
    length: child(p, 'length') ? num(child(p, 'length')!, 1) : 0,
  };
}

export function parseLibSymbol(node: List): LibSymbol {
  const id = atom(node, 1) ?? '';
  const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const ext = child(node, 'extends');
  const units = new Map<number, LibPin[]>();
  let unitCount = 0;
  for (const sub of children(node, 'symbol')) {
    const subName = atom(sub, 1) ?? '';
    const m = /_(\d+)_(\d+)$/.exec(subName);
    if (!m) continue;
    const unit = Number(m[1]);
    const style = Number(m[2]);
    if (style > 1) continue; // alternate body styles repeat the same pins
    unitCount = Math.max(unitCount, unit);
    const list = units.get(unit) ?? [];
    for (const p of children(sub, 'pin')) {
      const pin = parseLibPin(p);
      if (!list.some((x) => x.number === pin.number)) list.push(pin);
    }
    units.set(unit, list);
  }
  return { id, name, extends: ext ? (atom(ext, 1) ?? null) : null, power: !!child(node, 'power'), units, unitCount, node };
}

export function pinsOfUnit(lib: LibSymbol, unit: number): LibPin[] {
  const common = lib.units.get(0) ?? [];
  const own = unit === 0 ? [] : lib.units.get(unit) ?? [];
  const seen = new Set<string>();
  const out: LibPin[] = [];
  for (const p of [...own, ...common]) {
    if (seen.has(p.number)) continue;
    seen.add(p.number);
    out.push(p);
  }
  return out;
}

/** For multi-unit chips: the unit whose pins are all power pins (74LS00 unit 5, LM358 unit 3). */
export function powerUnit(lib: LibSymbol): number | null {
  if (lib.unitCount < 2) return null;
  for (const [u, pins] of lib.units) {
    if (u === 0 || !pins.length) continue;
    if (pins.every((p) => p.type === 'power_in' || p.type === 'power_out')) return u;
  }
  return null;
}

function parseSymbolInstance(node: List, project: string): SymbolInstance {
  const at = child(node, 'at');
  const mirror = child(node, 'mirror');
  const properties: Record<string, string> = {};
  for (const p of children(node, 'property')) properties[atom(p, 1) ?? ''] = atom(p, 2) ?? '';
  let ref = properties.Reference ?? '';
  let unit = child(node, 'unit') ? num(child(node, 'unit')!, 1) : 1;
  const inst = child(node, 'instances');
  if (inst) {
    const proj = children(inst, 'project').find((p) => atom(p, 1) === project) ?? children(inst, 'project')[0];
    const path = proj ? child(proj, 'path') : undefined;
    if (path) {
      ref = atom(child(path, 'reference') ?? path, 1) ?? ref;
      if (child(path, 'unit')) unit = num(child(path, 'unit')!, 1);
    }
  }
  const pinUuids = new Map<string, string>();
  for (const p of children(node, 'pin')) {
    const u = child(p, 'uuid');
    pinUuids.set(atom(p, 1) ?? '', u ? (atom(u, 1) ?? '') : '');
  }
  return {
    uuid: atom(child(node, 'uuid')!, 1) ?? '',
    libId: atom(child(node, 'lib_id')!, 1) ?? '',
    at: pointOf(at),
    rot: rotOf(at),
    mirror: mirror ? ((atom(mirror, 1) as 'x' | 'y') ?? null) : null,
    unit,
    ref,
    value: properties.Value ?? '',
    properties,
    pinUuids,
    node,
  };
}

export function parseSchematic(text: string, fallbackProject = 'project'): Schematic {
  const root = parse(text);
  const top = root.items[0];
  if (!isList(top) || atom(top, 0) !== 'kicad_sch') throw new SchematicError('not a KiCad schematic (expected (kicad_sch ...))');
  const uuidNode = child(top, 'uuid');
  const paperNode = child(top, 'paper');
  const libSymbolsNode = child(top, 'lib_symbols') ?? null;
  const libSymbols = new Map<string, LibSymbol>();
  if (libSymbolsNode) for (const s of children(libSymbolsNode, 'symbol')) {
    const lib = parseLibSymbol(s);
    libSymbols.set(lib.id, lib);
  }
  let project = fallbackProject;
  for (const s of children(top, 'symbol')) {
    const inst = child(s, 'instances');
    const proj = inst ? children(inst, 'project')[0] : undefined;
    if (proj && atom(proj, 1)) {
      project = atom(proj, 1)!;
      break;
    }
  }
  const symbols = children(top, 'symbol').map((s) => parseSymbolInstance(s, project));
  const labels: Label[] = [];
  for (const kind of ['label', 'global_label', 'hierarchical_label'] as const) {
    for (const l of children(top, kind)) {
      const at = child(l, 'at');
      labels.push({ kind, text: atom(l, 1) ?? '', at: pointOf(at), rot: at && at.items.length > 3 ? num(at, 3) : 0, uuid: atom(child(l, 'uuid') ?? l, 1) ?? '', node: l });
    }
  }
  const wires = children(top, 'wire').map((w) => ({
    uuid: atom(child(w, 'uuid') ?? w, 1) ?? '',
    pts: children(child(w, 'pts') ?? w, 'xy').map((xy) => pointOf(xy)),
    node: w,
  }));
  return {
    text,
    root,
    uuid: uuidNode ? (atom(uuidNode, 1) ?? '') : '',
    project,
    paper: paperNode ? (atom(paperNode, 1) ?? 'A4') : 'A4',
    libSymbols,
    libSymbolsNode,
    symbols,
    labels,
    wires,
    junctions: children(top, 'junction').map((j) => pointOf(child(j, 'at'))),
    noConnects: children(top, 'no_connect').map((j) => pointOf(child(j, 'at'))),
    sheets: children(top, 'sheet').length,
    buses: children(top, 'bus').length + children(top, 'bus_entry').length,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/schematic.test.ts`
Expected: all pass. If the "touches" test lists pins, the matrix composition is wrong; do not loosen the test.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/kicad circut-ai-tool/test/schematic.test.ts
git commit -m "feat(circuit): schematic model and KiCad-exact pin transform"
```

---

### Task 4: Netlist to Design

**Files:**
- Create: `circut-ai-tool/src/netlist.ts`
- Test: `circut-ai-tool/test/netlist.test.ts`

**Interfaces:**
- Produces:
  - `interface DesignPin { num: string; name: string; type: string; net: string }`
  - `interface Component { ref: string; value: string; lib: string; part: string; pins: Map<string, DesignPin> }`
  - `interface Design { components: Map<string, Component>; nets: Map<string, { ref: string; pin: string }[]> }`
  - `parseNetlist(text: string): Design`
  - `displayName(net: string): string` (strips a leading `/`), `isUnconnected(net: string): boolean` (`unconnected-` prefix), `isAutoNamed(net: string): boolean` (`Net-(` prefix)
  - `makeDesign(spec: DesignSpec): Design` helper for tests, where `type DesignSpec = Record<string, { lib: string; part: string; value: string; pins: Record<string, [name: string, type: string, net: string]> }>`

- [ ] **Step 1: Write the failing tests**

`test/netlist.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { displayName, isAutoNamed, isUnconnected, makeDesign, parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

describe('parseNetlist', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));

  test('merges multi-unit symbols into one component with every pin', () => {
    expect([...d.components.keys()].sort()).toEqual(['D1', 'D2', 'J1', 'R1', 'R2', 'R3', 'R4', 'SW1', 'SW2', 'U1', 'U2', 'U3']);
    const u3 = d.components.get('U3')!;
    expect(u3.value).toBe('74LS00');
    expect(u3.lib).toBe('74xx');
    expect(u3.part).toBe('74LS00');
    expect(u3.pins.size).toBe(14);
    expect(u3.pins.get('14')!.net).toBe('+5V');
    expect(u3.pins.get('14')!.name).toBe('VCC');
    expect(u3.pins.get('1')!.net).toBe('/A');
    expect(u3.pins.get('1')!.type).toBe('input');
  });

  test('pins that KiCad leaves out of the nets section get an unconnected net from libparts', () => {
    const u2 = d.components.get('U2')!;
    expect(u2.pins.size).toBe(14);
    const unconnected = [...u2.pins.values()].filter((p) => isUnconnected(p.net));
    expect(unconnected.length).toBeGreaterThan(0);
    expect(unconnected[0].net).toMatch(/^unconnected-\(U2-Pad\d+\)$/);
    expect(d.nets.get(unconnected[0].net)).toEqual([{ ref: 'U2', pin: unconnected[0].num }]);
  });

  test('nets list every member', () => {
    expect(d.nets.get('/A')!.map((n) => `${n.ref}.${n.pin}`).sort()).toEqual(['R1.2', 'SW1.2', 'U1.1', 'U3.1', 'U3.4']);
    expect(d.nets.get('+5V')!).toHaveLength(8);
  });

  test('rejects text that is not a netlist', () => {
    expect(() => parseNetlist('(kicad_sch)')).toThrow(/netlist/);
  });
});

describe('net name helpers', () => {
  test('displayName strips the sheet prefix', () => {
    expect(displayName('/A')).toBe('A');
    expect(displayName('+5V')).toBe('+5V');
  });
  test('classifies unconnected and auto-named nets', () => {
    expect(isUnconnected('unconnected-(U1-Pad3)')).toBe(true);
    expect(isAutoNamed('Net-(D1-A)')).toBe(true);
    expect(isAutoNamed('/A')).toBe(false);
  });
});

describe('makeDesign', () => {
  test('builds components and nets from a compact spec', () => {
    const d = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/A'] } },
      U1: { lib: '74xx', part: '74LS04', value: '74LS04', pins: { '1': ['~', 'input', '/A'], '2': ['~', 'output', 'unconnected-(U1-Pad2)'], '7': ['GND', 'power_in', 'GND'], '14': ['VCC', 'power_in', '+5V'] } },
    });
    expect(d.nets.get('/A')).toEqual([{ ref: 'R1', pin: '2' }, { ref: 'U1', pin: '1' }]);
    expect(d.components.get('U1')!.pins.get('14')!.type).toBe('power_in');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/netlist.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/netlist.ts**

```ts
// kicad-cli "kicadsexpr" netlist -> Design. The netlist is the source of
// truth for connectivity: KiCad has already merged multi-unit symbols,
// resolved labels and power symbols, and named every net.

import { atom, child, children, isList, parse, type List } from './sexpr.ts';

export interface DesignPin {
  num: string;
  name: string;
  type: string;
  net: string;
}

export interface Component {
  ref: string;
  value: string;
  lib: string;
  part: string;
  pins: Map<string, DesignPin>;
}

export interface Design {
  components: Map<string, Component>;
  nets: Map<string, { ref: string; pin: string }[]>;
}

export class NetlistError extends Error {}

const val = (l: List | undefined, key: string, fallback = ''): string => {
  const c = l ? child(l, key) : undefined;
  return c ? (atom(c, 1) ?? fallback) : fallback;
};

export function parseNetlist(text: string): Design {
  const root = parse(text).items[0];
  if (!isList(root) || atom(root, 0) !== 'export') throw new NetlistError('not a KiCad netlist (expected (export ...))');
  const components = new Map<string, Component>();
  for (const c of children(child(root, 'components') ?? root, 'comp')) {
    const ref = val(c, 'ref');
    const ls = child(c, 'libsource');
    components.set(ref, { ref, value: val(c, 'value'), lib: val(ls, 'lib'), part: val(ls, 'part'), pins: new Map() });
  }
  const nets = new Map<string, { ref: string; pin: string }[]>();
  for (const n of children(child(root, 'nets') ?? root, 'net')) {
    const name = val(n, 'name');
    const members: { ref: string; pin: string }[] = [];
    for (const node of children(n, 'node')) {
      const ref = val(node, 'ref');
      const pin = val(node, 'pin');
      members.push({ ref, pin });
      const comp = components.get(ref);
      if (comp) comp.pins.set(pin, { num: pin, name: val(node, 'pinfunction', '~'), type: val(node, 'pintype', 'unspecified'), net: name });
    }
    nets.set(name, members);
  }
  // Pins of unused units never appear in the nets section: take them from libparts.
  const libpins = new Map<string, { num: string; name: string; type: string }[]>();
  for (const lp of children(child(root, 'libparts') ?? root, 'libpart')) {
    const pins = children(child(lp, 'pins') ?? lp, 'pin').map((p) => ({ num: val(p, 'num'), name: val(p, 'name', '~'), type: val(p, 'type', 'unspecified') }));
    libpins.set(`${val(lp, 'lib')}:${val(lp, 'part')}`, pins);
  }
  for (const comp of components.values()) {
    for (const p of libpins.get(`${comp.lib}:${comp.part}`) ?? []) {
      if (comp.pins.has(p.num)) continue;
      const net = `unconnected-(${comp.ref}-Pad${p.num})`;
      comp.pins.set(p.num, { num: p.num, name: p.name, type: p.type, net });
      nets.set(net, [{ ref: comp.ref, pin: p.num }]);
    }
  }
  return { components, nets };
}

export function displayName(net: string): string {
  return net.startsWith('/') ? net.slice(1) : net;
}

export function isUnconnected(net: string): boolean {
  return net.startsWith('unconnected-');
}

export function isAutoNamed(net: string): boolean {
  return net.startsWith('Net-(');
}

export type DesignSpec = Record<string, { lib: string; part: string; value: string; pins: Record<string, [name: string, type: string, net: string]> }>;

/** Test helper: a Design from a compact literal. */
export function makeDesign(spec: DesignSpec): Design {
  const components = new Map<string, Component>();
  const nets = new Map<string, { ref: string; pin: string }[]>();
  for (const [ref, c] of Object.entries(spec)) {
    const pins = new Map<string, DesignPin>();
    for (const [num, [name, type, net]] of Object.entries(c.pins)) {
      pins.set(num, { num, name, type, net });
      const list = nets.get(net) ?? [];
      list.push({ ref, pin: num });
      nets.set(net, list);
    }
    components.set(ref, { ref, value: c.value, lib: c.lib, part: c.part, pins });
  }
  return { components, nets };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/netlist.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `cd circut-ai-tool && bun test && bun run typecheck`
Expected: all tests pass, `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/netlist.ts circut-ai-tool/test/netlist.test.ts
git commit -m "feat(circuit): parse kicad-cli netlists into a Design"
```

---

## Self-review (part 1a)

- Spec coverage: `sexpr.ts` (spans, serializer), `schematic.ts` (symbols with units, lib_symbols pins, labels, wires, junctions, sheets and buses counted for the "not supported" error), `transform.ts` (validated against PL1_1), `netlist.ts` (components, nets, libparts fallback). Sheet and bus errors are raised by the service in part 2 using `sheets` and `buses`.
- Names used later: `parseSchematic`, `pinsOfUnit`, `powerUnit`, `pinPosition`, `pinBodyDirection`, `parseNetlist`, `makeDesign`, `displayName`, `isUnconnected`, `isAutoNamed`, `Design`, `Component`, `DesignPin`, `round4`, `serialize`, `q`.
