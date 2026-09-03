# Circuit AI Tool Implementation Plan, part 4: editing the schematic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an assistant (or the REST API) add a component, connect and disconnect pins, remove a component and change a value in the real `.kicad_sch`, with a backup before every write, a stale-file guard, and the result verified through kicad-cli's netlist on the rebuild.

**Architecture:** `src/kicad/libsymbol.ts` pulls one symbol definition (flattening `extends`) out of a `.kicad_sym` library so it can be copied into the schematic's `lib_symbols`. `src/kicad/writer.ts` does span-level text edits on the parsed schematic (insert nodes, delete nodes, replace a property value) and builds new symbol and label nodes with the serializer from part 1a. `src/kicad/ops.ts` composes them into the five operations, including spare-gate reuse for multi-unit chips and label-based connections at pin ends computed by the verified transform. `server/libraries.ts` finds library files; `Service.edit()` wraps every operation with the mtime check, backup, write and rebuild; `server/api.ts` and `server/mcp.ts` expose them.

**Tech Stack:** as parts 1 to 3. Integration tests use the real `kicad-cli` and KiCad libraries when installed and skip otherwise.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md` (section "Schematic edit semantics")

## Global Constraints

- Label kinds: an existing net named `/NAME` (a local label) is joined with a **local** `label`; a power net (`+5V`, `GND`, ...) with a `power:*` symbol; a global label net (plain name in the netlist that is not a power net) with a `global_label`; a brand new net requested by the user gets a **local** label. Local and global labels with the same text are different nets in KiCad, so this rule matters.
- Nets that only have an automatic name (`Net-(R1-Pad1)`) are named first by placing a local label on one existing pin of that net (`N1`, `N2`, ... first free), and that name is then used.
- Every label or power symbol the app places is recorded in the sidecar `placed[ref][pin]` by uuid; `disconnect` and `remove_component` only remove those.
- Backups go to `<project dir>/.circuit-ai-backups/NAME-YYYYMMDD-HHMMSS.kicad_sch`, keep the 20 newest.
- A write is refused with status 409 when the file's mtime or size differs from what the service last read.
- Every edit result ends with: "KiCad does not reload files changed on disk: use File > Revert if the project is open in KiCad."
- Same commit and tooling rules as part 1a. The tests copy the fixture to a temp dir; they never write to `Documents\KiCad`.

---

### Task 22: Library symbol extraction and library lookup

**Files:**
- Create: `circut-ai-tool/src/kicad/libsymbol.ts`
- Create: `circut-ai-tool/server/libraries.ts`
- Test: `circut-ai-tool/test/libsymbol.test.ts`

**Interfaces:**
- Produces (libsymbol.ts): `extractLibSymbol(libText: string, name: string, nickname: string): string` (text of one `(symbol "nickname:name" ...)` ready for `lib_symbols`, `extends` flattened; throws `LibSymbolError` when the name is absent)
- Produces (libraries.ts): `interface LibraryLookup { symbolText(libId: string): Promise<string> }`, `createLibraryLookup(opts: { symbolDir: string; tableFile?: string; projectDir?: string }): LibraryLookup`, `findLibraryFile(nickname, opts): Promise<string | null>`, `parseSymLibTable(text: string, symbolDir: string): Map<string, string>`

- [ ] **Step 1: Write the failing tests**

`test/libsymbol.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KICAD_SYMBOL_DIR } from '../server/config.ts';
import { createLibraryLookup, parseSymLibTable } from '../server/libraries.ts';
import { extractLibSymbol } from '../src/kicad/libsymbol.ts';
import { parseLibSymbol, pinsOfUnit, powerUnit } from '../src/kicad/schematic.ts';
import { parse, isList } from '../src/sexpr.ts';

const have = existsSync(path.join(KICAD_SYMBOL_DIR, 'Device.kicad_sym'));
const lib = (name: string) => readFileSync(path.join(KICAD_SYMBOL_DIR, `${name}.kicad_sym`), 'utf8');
const parseOne = (text: string) => {
  const root = parse(text).items[0];
  if (!isList(root)) throw new Error('expected list');
  return parseLibSymbol(root);
};

describe('extractLibSymbol', () => {
  test.skipIf(!have)('plain symbol keeps its pins and gets the nickname prefix', () => {
    const text = extractLibSymbol(lib('Device'), 'R', 'Device');
    expect(text.startsWith('(symbol "Device:R"')).toBe(true);
    const s = parseOne(text);
    expect(s.id).toBe('Device:R');
    expect(pinsOfUnit(s, 1).map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(text).toContain('(symbol "R_0_1"');
  });

  test.skipIf(!have)('derived symbol is flattened: parent body, child properties, renamed sub-symbols', () => {
    const text = extractLibSymbol(lib('Transistor_BJT'), '2N3904', 'Transistor_BJT');
    expect(text).not.toContain('(extends');
    expect(text).toContain('(symbol "2N3904_1_1"');
    expect(text).not.toContain('"Q_NPN_EBC_');
    const s = parseOne(text);
    expect(s.id).toBe('Transistor_BJT:2N3904');
    expect(pinsOfUnit(s, 1).map((p) => `${p.number}${p.name}`).sort()).toEqual(['1E', '2B', '3C']);
    expect(text).toMatch(/\(property "Value" "2N3904"/);
  });

  test.skipIf(!have)('multi-unit and power symbols', () => {
    const s = parseOne(extractLibSymbol(lib('74xx'), '74LS00', '74xx'));
    expect(s.unitCount).toBe(5);
    expect(powerUnit(s)).toBe(5);
    const p = parseOne(extractLibSymbol(lib('power'), '+5V', 'power'));
    expect(p.power).toBe(true);
  });

  test.skipIf(!have)('missing names throw', () => {
    expect(() => extractLibSymbol(lib('Device'), 'NoSuchPart', 'Device')).toThrow(/NoSuchPart/);
  });
});

describe('library lookup', () => {
  test('parses sym-lib-table uris', () => {
    const table = '(sym_lib_table (version 7) (lib (name "74xx")(type "KiCad")(uri "${KICAD9_SYMBOL_DIR}/74xx.kicad_sym")(options "")(descr "")) (lib (name "mine")(type "KiCad")(uri "C:/libs/mine.kicad_sym")(options "")(descr "")))';
    const m = parseSymLibTable(table, 'C:/kicad/symbols');
    expect(m.get('74xx')).toBe('C:/kicad/symbols/74xx.kicad_sym');
    expect(m.get('mine')).toBe('C:/libs/mine.kicad_sym');
  });
  test.skipIf(!have)('finds a global library and reports unknown ones', async () => {
    const lookup = createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR });
    expect((await lookup.symbolText('Device:LED')).startsWith('(symbol "Device:LED"')).toBe(true);
    await expect(lookup.symbolText('Nope:X')).rejects.toThrow(/library "Nope"/);
    await expect(lookup.symbolText('Device')).rejects.toThrow(/lib_id/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/libsymbol.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/kicad/libsymbol.ts**

```ts
// Pull one symbol out of a .kicad_sym library as text suitable for a
// schematic's lib_symbols section. Derived symbols ((extends "PARENT")) are
// flattened: the parent's body with the child's properties, sub-symbols
// renamed from PARENT_u_s to NAME_u_s.

import { atom, child, children, isList, parse, type List } from '../sexpr.ts';

export class LibSymbolError extends Error {}

function topSymbol(root: List, name: string): List | undefined {
  const lib = root.items[0];
  if (!isList(lib)) return undefined;
  return children(lib, 'symbol').find((s) => atom(s, 1) === name);
}

export function extractLibSymbol(libText: string, name: string, nickname: string): string {
  const root = parse(libText);
  const node = topSymbol(root, name);
  if (!node) throw new LibSymbolError(`symbol "${name}" is not in the ${nickname} library`);
  const ext = child(node, 'extends');
  let text: string;
  let baseName = name;
  if (ext) {
    const parentName = atom(ext, 1) ?? '';
    const parent = topSymbol(root, parentName);
    if (!parent) throw new LibSymbolError(`symbol "${name}" extends "${parentName}", which is missing from the ${nickname} library`);
    baseName = parentName;
    text = libText.slice(parent.start, parent.end);
    // Override or add the child's properties, editing from the end so spans stay valid.
    const parentProps = children(parent, 'property');
    const childProps = children(node, 'property');
    const edits: { start: number; end: number; repl: string }[] = [];
    const firstSub = children(parent, 'symbol')[0];
    for (const cp of childProps) {
      const pname = atom(cp, 1);
      const repl = libText.slice(cp.start, cp.end);
      const pp = parentProps.find((x) => atom(x, 1) === pname);
      if (pp) edits.push({ start: pp.start - parent.start, end: pp.end - parent.start, repl });
      else edits.push({ start: (firstSub ? firstSub.start : parent.end - 1) - parent.start, end: (firstSub ? firstSub.start : parent.end - 1) - parent.start, repl: repl + '\n\t\t' });
    }
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) text = text.slice(0, e.start) + e.repl + text.slice(e.end);
  } else {
    text = libText.slice(node.start, node.end);
  }
  text = text.replace(/^\(symbol\s+"[^"]*"/, `(symbol "${nickname}:${name}"`);
  const sub = new RegExp(`\\(symbol\\s+"${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)_(\\d+)"`, 'g');
  text = text.replace(sub, `(symbol "${name}_$1_$2"`);
  return text;
}
```

- [ ] **Step 4: Write server/libraries.ts**

```ts
// Where KiCad keeps symbol libraries: the global sym-lib-table, the global
// symbol directory, and the project directory for project-local libraries.

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractLibSymbol } from '../src/kicad/libsymbol.ts';
import { atom, child, children, isList, parse } from '../src/sexpr.ts';

export interface LibraryLookup {
  symbolText(libId: string): Promise<string>;
}

export class LibraryError extends Error {}

export function parseSymLibTable(text: string, symbolDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parse(text).items[0];
  if (!isList(root)) return out;
  for (const lib of children(root, 'lib')) {
    const name = child(lib, 'name');
    const uri = child(lib, 'uri');
    if (!name || !uri) continue;
    const resolved = (atom(uri, 1) ?? '').replace(/\$\{KICAD\d*_SYMBOL_DIR\}/g, symbolDir).replace(/\\/g, '/');
    out.set(atom(name, 1) ?? '', resolved);
  }
  return out;
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function findLibraryFile(nickname: string, opts: { symbolDir: string; tableFile?: string; projectDir?: string }): Promise<string | null> {
  const table = opts.tableFile ?? path.join(process.env.APPDATA ?? '', 'kicad', '9.0', 'sym-lib-table');
  try {
    const map = parseSymLibTable(await readFile(table, 'utf8'), opts.symbolDir);
    const hit = map.get(nickname);
    if (hit && (await exists(hit))) return hit;
  } catch {
    /* no table */
  }
  for (const candidate of [path.join(opts.symbolDir, `${nickname}.kicad_sym`), opts.projectDir ? path.join(opts.projectDir, `${nickname}.kicad_sym`) : '']) if (candidate && (await exists(candidate))) return candidate;
  return null;
}

export function createLibraryLookup(opts: { symbolDir: string; tableFile?: string; projectDir?: string }): LibraryLookup {
  const cache = new Map<string, string>();
  return {
    async symbolText(libId: string) {
      const i = libId.indexOf(':');
      if (i <= 0) throw new LibraryError(`"${libId}" is not a lib_id; use the form Library:Symbol, for example Device:R`);
      const nickname = libId.slice(0, i);
      const name = libId.slice(i + 1);
      const file = await findLibraryFile(nickname, opts);
      if (!file) throw new LibraryError(`library "${nickname}" not found (looked in the sym-lib-table, ${opts.symbolDir}${opts.projectDir ? ` and ${opts.projectDir}` : ''})`);
      let text = cache.get(file);
      if (!text) {
        text = await readFile(file, 'utf8');
        cache.set(file, text);
      }
      return extractLibSymbol(text, name, nickname);
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/libsymbol.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/kicad/libsymbol.ts circut-ai-tool/server/libraries.ts circut-ai-tool/test/libsymbol.test.ts
git commit -m "feat(circuit): extract library symbols with flattened extends"
```

---

### Task 23: Schematic writer

**Files:**
- Create: `circut-ai-tool/src/kicad/writer.ts`
- Test: `circut-ai-tool/test/writer.test.ts`

**Interfaces:**
- Produces:
  - `newUuid(): string`
  - `snap(v: number, grid?: number): number` (1.27 mm)
  - `contentBounds(sch: Schematic): { minX: number; minY: number; maxX: number; maxY: number }`
  - `freeSpot(sch: Schematic, index: number): Point` (a grid to the right of the drawing, 25.4 mm pitch, four per column)
  - `nextReference(sch: Schematic, prefix: string): string`
  - `nextLabelName(sch: Schematic, prefix?: string): string` (`N1`, `N2`, ...)
  - `insertLibSymbol(sch: Schematic, symbolText: string): string`
  - `symbolNode(o: { libId: string; at: Point; rot?: number; unit: number; ref: string; value: string; pinNumbers: string[]; project: string; rootUuid: string; hideReference?: boolean; uuid?: string }): string`
  - `labelNode(o: { kind: 'label' | 'global_label'; text: string; at: Point; rot: number; uuid?: string }): string`
  - `appendTopLevel(sch: Schematic, nodeText: string): string`
  - `removeByUuid(sch: Schematic, uuids: string[]): string`
  - `setPropertyValue(sch: Schematic, sym: SymbolInstance, name: string, value: string): string`
  - `labelRotation(away: Point): 0 | 90 | 180 | 270`, `powerRotation(away: Point): 0 | 90 | 180 | 270`

- [ ] **Step 1: Write the failing tests**

`test/writer.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit } from '../src/kicad/schematic.ts';
import { pinBodyDirection, pinPosition } from '../src/kicad/transform.ts';
import { appendTopLevel, contentBounds, freeSpot, insertLibSymbol, labelNode, labelRotation, nextLabelName, nextReference, powerRotation, removeByUuid, setPropertyValue, symbolNode } from '../src/kicad/writer.ts';
import { readFixture } from './smoke.test.ts';

const base = readFixture('PL1_1.kicad_sch');
const sch = parseSchematic(base, 'PL1_1');

describe('writer helpers', () => {
  test('references, label names, bounds and free spots', () => {
    expect(nextReference(sch, 'R')).toBe('R5');
    expect(nextReference(sch, 'U')).toBe('U4');
    expect(nextReference(sch, 'C')).toBe('C1');
    expect(nextLabelName(sch)).toBe('N1');
    const b = contentBounds(sch);
    expect(b.maxX).toBeGreaterThan(b.minX);
    const s0 = freeSpot(sch, 0);
    expect(s0.x).toBeGreaterThan(b.maxX);
    expect(s0.x % 1.27).toBeCloseTo(0, 6);
    expect(freeSpot(sch, 1).y).toBe(s0.y + 25.4);
    expect(freeSpot(sch, 4).x).toBe(s0.x + 25.4);
  });
  test('rotations from the away vector', () => {
    expect(labelRotation({ x: 1, y: 0 })).toBe(0);
    expect(labelRotation({ x: -1, y: 0 })).toBe(180);
    expect(labelRotation({ x: 0, y: -1 })).toBe(90);
    expect(labelRotation({ x: 0, y: 1 })).toBe(270);
    expect(powerRotation({ x: 0, y: -1 })).toBe(0);
    expect(powerRotation({ x: 0, y: 1 })).toBe(180);
    expect(powerRotation({ x: -1, y: 0 })).toBe(90);
    expect(powerRotation({ x: 1, y: 0 })).toBe(270);
  });
});

describe('writer edits', () => {
  test('add a resistor, label its pins, change its value, remove it; untouched text is byte-identical', () => {
    const libText = base.slice(sch.libSymbols.get('Device:R')!.node.start, sch.libSymbols.get('Device:R')!.node.end);
    const t1 = insertLibSymbol(sch, libText);
    expect(t1).toBe(base); // already present
    const at = freeSpot(sch, 0);
    const node = symbolNode({ libId: 'Device:R', at, unit: 1, ref: 'R5', value: '4k7', pinNumbers: ['1', '2'], project: sch.project, rootUuid: sch.uuid });
    const t2 = appendTopLevel(sch, node);
    expect(t2.slice(0, sch.root.items[0].end - 1)).toBe(base.slice(0, sch.root.items[0].end - 1));
    const s2 = parseSchematic(t2, 'PL1_1');
    expect(s2.symbols).toHaveLength(36);
    const r5 = s2.symbols.find((s) => s.ref === 'R5')!;
    expect(r5.value).toBe('4k7');
    expect(r5.at).toEqual(at);
    expect([...r5.pinUuids.keys()]).toEqual(['1', '2']);
    const pin1 = pinsOfUnit(s2.libSymbols.get('Device:R')!, 1).find((p) => p.number === '1')!;
    const end = pinPosition(r5, pin1);
    const away = pinBodyDirection(r5, pin1);
    expect(away).toEqual({ x: 0, y: 1 });
    const label = labelNode({ kind: 'label', text: 'A', at: end, rot: labelRotation({ x: -away.x, y: -away.y }) });
    const t3 = appendTopLevel(s2, label);
    const s3 = parseSchematic(t3, 'PL1_1');
    const l = s3.labels.find((x) => x.text === 'A' && x.at.x === end.x && x.at.y === end.y)!;
    expect(l).toBeDefined();
    expect(l.rot).toBe(90);
    const t4 = setPropertyValue(s3, s3.symbols.find((s) => s.ref === 'R5')!, 'Value', '10k');
    const s4 = parseSchematic(t4, 'PL1_1');
    expect(s4.symbols.find((s) => s.ref === 'R5')!.value).toBe('10k');
    expect(s4.symbols).toHaveLength(36);
    const t5 = removeByUuid(s4, [s4.symbols.find((s) => s.ref === 'R5')!.uuid, l.uuid]);
    const s5 = parseSchematic(t5, 'PL1_1');
    expect(s5.symbols).toHaveLength(35);
    expect(s5.labels).toHaveLength(4);
    expect(t5.replace(/\s+/g, '')).toBe(base.replace(/\s+/g, ''));
  });

  test('insertLibSymbol adds a missing definition inside lib_symbols', () => {
    const fake = '(symbol "Device:C" (pin_numbers (hide yes)) (property "Reference" "C" (at 0 0 0)) (symbol "C_1_1" (pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))';
    const t = insertLibSymbol(sch, fake);
    const s = parseSchematic(t, 'PL1_1');
    expect(s.libSymbols.has('Device:C')).toBe(true);
    expect(s.libSymbols.size).toBe(11);
    expect(s.symbols).toHaveLength(35);
  });

  test('a power symbol node hides its reference', () => {
    const node = symbolNode({ libId: 'power:+5V', at: { x: 10, y: 10 }, rot: 0, unit: 1, ref: '#PWR099', value: '+5V', pinNumbers: ['1'], project: sch.project, rootUuid: sch.uuid, hideReference: true });
    expect(node).toMatch(/\(property "Reference" "#PWR099"[\s\S]*?\(hide yes\)/);
    const s = parseSchematic(appendTopLevel(sch, node), 'PL1_1');
    expect(s.symbols.find((x) => x.ref === '#PWR099')!.value).toBe('+5V');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/writer.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/kicad/writer.ts**

```ts
// Span-level edits to a schematic's text plus builders for new nodes.
// Every function returns the new text; re-parse before the next edit.

import { q, round4, serialize, type B } from '../sexpr.ts';
import type { Point, Schematic, SymbolInstance } from './schematic.ts';

export const GRID = 1.27;

export function newUuid(): string {
  return crypto.randomUUID();
}

export function snap(v: number, grid = GRID): number {
  return round4(Math.round(v / grid) * grid);
}

export function contentBounds(sch: Schematic): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Point[] = [...sch.symbols.map((s) => s.at), ...sch.labels.map((l) => l.at), ...sch.wires.flatMap((w) => w.pts), ...sch.junctions];
  if (!pts.length) return { minX: 25.4, minY: 25.4, maxX: 25.4, maxY: 25.4 };
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
}

/** A grid to the right of the drawing: four rows per column, 25.4 mm pitch. */
export function freeSpot(sch: Schematic, index: number): Point {
  const b = contentBounds(sch);
  const x0 = snap(b.maxX + 25.4 * 2, 25.4);
  const y0 = snap(b.minY, 25.4);
  return { x: round4(x0 + Math.floor(index / 4) * 25.4), y: round4(y0 + (index % 4) * 25.4) };
}

export function nextReference(sch: Schematic, prefix: string): string {
  let max = 0;
  for (const s of sch.symbols) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(s.ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function nextLabelName(sch: Schematic, prefix = 'N'): string {
  const used = new Set(sch.labels.map((l) => l.text));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function labelRotation(away: Point): 0 | 90 | 180 | 270 {
  if (away.x > 0) return 0;
  if (away.x < 0) return 180;
  return away.y < 0 ? 90 : 270;
}

/** power:* symbols draw upward at 0; rotate so the bar points away from the pin's body. */
export function powerRotation(away: Point): 0 | 90 | 180 | 270 {
  if (away.y < 0) return 0;
  if (away.y > 0) return 180;
  return away.x < 0 ? 90 : 270;
}

const indentBlock = (text: string, tabs: number) => text.split('\n').map((l, i) => (i === 0 ? l : '\t'.repeat(tabs) + l)).join('\n');

export function insertLibSymbol(sch: Schematic, symbolText: string): string {
  const id = /^\(symbol\s+"([^"]+)"/.exec(symbolText)?.[1] ?? '';
  if (sch.libSymbols.has(id)) return sch.text;
  const block = '\n\t\t' + indentBlock(symbolText.trim(), 2);
  if (sch.libSymbolsNode) {
    const at = sch.libSymbolsNode.end - 1;
    return sch.text.slice(0, at) + block + '\n\t' + sch.text.slice(at);
  }
  const top = sch.root.items[0];
  const paper = /\(paper\s+"[^"]*"\)/.exec(sch.text);
  const at = paper ? paper.index + paper[0].length : (top as { start: number }).start + '(kicad_sch'.length;
  return sch.text.slice(0, at) + '\n\t(lib_symbols' + block + '\n\t)' + sch.text.slice(at);
}

const font = (): B => ['effects', ['font', ['size', 1.27, 1.27]]];
const hiddenProp = (name: string, value: string, at: Point): B => ['property', q(name), q(value), ['at', at.x, at.y, 0], ['effects', ['font', ['size', 1.27, 1.27]], ['hide', 'yes']]];

export function symbolNode(o: { libId: string; at: Point; rot?: number; unit: number; ref: string; value: string; pinNumbers: string[]; project: string; rootUuid: string; hideReference?: boolean; uuid?: string }): string {
  const { at } = o;
  const refProp: B = o.hideReference ? hiddenProp('Reference', o.ref, { x: at.x, y: round4(at.y - 2.54) }) : ['property', q('Reference'), q(o.ref), ['at', round4(at.x + 2.54), round4(at.y - 1.27), 0], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']]];
  const node: B = [
    'symbol',
    ['lib_id', q(o.libId)],
    ['at', at.x, at.y, o.rot ?? 0],
    ['unit', o.unit],
    ['exclude_from_sim', 'no'],
    ['in_bom', o.hideReference ? 'no' : 'yes'],
    ['on_board', o.hideReference ? 'no' : 'yes'],
    ['dnp', 'no'],
    ['uuid', q(o.uuid ?? newUuid())],
    refProp,
    ['property', q('Value'), q(o.value), ['at', round4(at.x + 2.54), round4(at.y + 1.27), 0], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']]],
    hiddenProp('Footprint', '', at),
    hiddenProp('Datasheet', '', at),
    hiddenProp('Description', '', at),
    ...o.pinNumbers.map((p): B => ['pin', q(p), ['uuid', q(newUuid())]]),
    ['instances', ['project', q(o.project), ['path', q(`/${o.rootUuid}`), ['reference', q(o.ref)], ['unit', o.unit]]]],
  ];
  void font;
  return serialize(node);
}

export function labelNode(o: { kind: 'label' | 'global_label'; text: string; at: Point; rot: number; uuid?: string }): string {
  const justify = o.rot === 180 ? 'right' : 'left';
  const node: B = [o.kind, q(o.text)];
  if (o.kind === 'global_label') node.push(['shape', 'input']);
  node.push(['at', o.at.x, o.at.y, o.rot]);
  if (o.kind === 'global_label') node.push(['fields_autoplaced', 'yes']);
  node.push(['effects', ['font', ['size', 1.27, 1.27]], ['justify', justify, 'bottom']]);
  node.push(['uuid', q(o.uuid ?? newUuid())]);
  if (o.kind === 'global_label') node.push(['property', q('Intersheetrefs'), q('${INTERSHEET_REFS}'), ['at', o.at.x, o.at.y, 0], ['effects', ['font', ['size', 1.27, 1.27]], ['hide', 'yes']]]);
  return serialize(node);
}

export function appendTopLevel(sch: Schematic, nodeText: string): string {
  const top = sch.root.items[0] as { end: number };
  const at = top.end - 1;
  return sch.text.slice(0, at) + '\t' + indentBlock(nodeText.trim(), 1) + '\n' + sch.text.slice(at);
}

export function removeByUuid(sch: Schematic, uuids: string[]): string {
  const want = new Set(uuids);
  const spans: { start: number; end: number }[] = [];
  for (const s of sch.symbols) if (want.has(s.uuid)) spans.push({ start: s.node.start, end: s.node.end });
  for (const l of sch.labels) if (want.has(l.uuid)) spans.push({ start: l.node.start, end: l.node.end });
  for (const w of sch.wires) if (want.has(w.uuid)) spans.push({ start: w.node.start, end: w.node.end });
  spans.sort((a, b) => b.start - a.start);
  let text = sch.text;
  for (const sp of spans) {
    let start = sp.start;
    while (start > 0 && (text[start - 1] === '\t' || text[start - 1] === ' ')) start--;
    if (start > 0 && text[start - 1] === '\n') start--;
    text = text.slice(0, start) + text.slice(sp.end);
  }
  return text;
}

export function setPropertyValue(sch: Schematic, sym: SymbolInstance, name: string, value: string): string {
  const props = sym.node.items.filter((it) => it.type === 'list' && it.items[0]?.type === 'atom' && it.items[0].value === 'property');
  for (const p of props) {
    if (p.type !== 'list') continue;
    const key = p.items[1];
    const val = p.items[2];
    if (key?.type === 'atom' && key.value === name && val?.type === 'atom') {
      const quoted = '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      return sch.text.slice(0, val.start) + quoted + sch.text.slice(val.end);
    }
  }
  const at = sym.node.end - 1;
  return sch.text.slice(0, at) + '\t\t' + serialize(hiddenProp(name, value, sym.at), 2) + '\n\t' + sch.text.slice(at);
}
```

Delete the `void font;` line and the unused `font` helper before running the tests.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/writer.test.ts`
Expected: all pass. The byte-identical assertion compares text with whitespace stripped after add and remove; if it fails, `removeByUuid` left or ate a newline: adjust the leading-whitespace trimming so exactly the inserted `\t...\n` block is removed.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/src/kicad/writer.ts circut-ai-tool/test/writer.test.ts
git commit -m "feat(circuit): schematic writer with span edits and node builders"
```

---

### Task 24: The five operations and Service.edit with backup and stale guard

**Files:**
- Create: `circut-ai-tool/src/kicad/ops.ts`
- Modify: `circut-ai-tool/server/service.ts` (add `edit`, `addComponent`, `connect`, `disconnect`, `removeComponent`, `setValue`)
- Modify: `circut-ai-tool/server/boot.ts` (create the `LibraryLookup`)
- Test: `circut-ai-tool/test/ops.test.ts`
- Test: `circut-ai-tool/test/edit-integration.test.ts`

**Interfaces:**
- Produces (ops.ts):
  - `type LibProvider = (libId: string) => Promise<string>`
  - `interface NetTarget { kind: 'local' | 'global' | 'power'; name: string }` and `netTarget(netName: string, design: Design): NetTarget | 'auto'` (`'/A'` → local `A`; `'+5V'` → power; plain → global; `Net-(...)` → `'auto'`; an unknown new name → local)
  - `interface OpResult { text: string; placed: Record<string, Record<string, string[]>>; notes: string[]; ref?: string; unit?: number }` (`placed` is a delta to merge into the sidecar; uuids listed under `placed[ref][pin]`, or `placed['-'][uuid]` to mark removals)
  - `addComponent(sch: Schematic, design: Design, a: { libId: string; value?: string; ref?: string; connections?: Record<string, string> }, libs: LibProvider): Promise<OpResult>`
  - `connectPin(sch: Schematic, design: Design, ref: string, pin: string, net: string, libs: LibProvider): Promise<OpResult>`
  - `disconnectPin(sch: Schematic, ref: string, pin: string, placed: Record<string, Record<string, string[]>>): OpResult`
  - `removeComponent(sch: Schematic, ref: string, placed: ...): OpResult`
  - `setValue(sch: Schematic, ref: string, value: string): OpResult`
  - `pinEnd(sch: Schematic, ref: string, pin: string): { sym: SymbolInstance; at: Point; away: Point } | null`
- Produces (service.ts): `edit(id: string, run: (p: OpenProject) => Promise<OpResult>): Promise<EditOutcome>` with `interface EditOutcome { project: OpenProject; backup: string; notes: string[]; ref?: string; unit?: number }`, plus the five wrappers `addComponent(id, args)`, `connect(id, ref, pin, net)`, `disconnect(id, ref, pin)`, `removeComponent(id, ref)`, `setValue(id, ref, value)`; `ServiceDeps.libs: LibraryLookup`

- [ ] **Step 1: Write the failing tests**

`test/ops.test.ts` (pure, uses lib symbols already embedded in PL1_1 plus a tiny fake library):

```ts
import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit } from '../src/kicad/schematic.ts';
import { pinPosition } from '../src/kicad/transform.ts';
import { addComponent, connectPin, disconnectPin, netTarget, removeComponent, setValue } from '../src/kicad/ops.ts';
import { parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

const base = readFixture('PL1_1.kicad_sch');
const sch = parseSchematic(base, 'PL1_1');
const design = parseNetlist(readFixture('PL1_1.net'));
const FAKE_C = '(symbol "Device:C" (pin_numbers (hide yes)) (property "Reference" "C" (at 0 0 0)) (property "Value" "C" (at 0 0 0)) (symbol "C_1_1" (pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin passive line (at 0 -3.81 90) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))';
const libs = async (libId: string) => {
  const own = sch.libSymbols.get(libId);
  if (own) return base.slice(own.node.start, own.node.end);
  if (libId === 'Device:C') return FAKE_C;
  throw new Error(`no lib ${libId}`);
};

describe('netTarget', () => {
  test('classifies names', () => {
    expect(netTarget('/A', design)).toEqual({ kind: 'local', name: 'A' });
    expect(netTarget('A', design)).toEqual({ kind: 'local', name: 'A' });
    expect(netTarget('+5V', design)).toEqual({ kind: 'power', name: '+5V' });
    expect(netTarget('GND', design)).toEqual({ kind: 'power', name: 'GND' });
    expect(netTarget('Net-(D1-A)', design)).toBe('auto');
    expect(netTarget('NEWNET', design)).toEqual({ kind: 'local', name: 'NEWNET' });
  });
});

describe('addComponent', () => {
  test('a new two-lead part with connections gets labels and a power symbol', async () => {
    const r = await addComponent(sch, design, { libId: 'Device:C', value: '100n', connections: { '1': '+5V', '2': 'GND' } }, libs);
    expect(r.ref).toBe('C1');
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.libSymbols.has('Device:C')).toBe(true);
    const c1 = s.symbols.find((x) => x.ref === 'C1')!;
    expect(c1.value).toBe('100n');
    const pwr = s.symbols.filter((x) => x.libId === 'power:+5V' || x.libId === 'power:GND');
    expect(pwr.length).toBe(8 + 6 + 2);
    const pin1 = pinsOfUnit(s.libSymbols.get('Device:C')!, 1).find((p) => p.number === '1')!;
    const end = pinPosition(c1, pin1);
    expect(pwr.some((p) => p.value === '+5V' && p.at.x === end.x && p.at.y === end.y)).toBe(true);
    expect(Object.keys(r.placed.C1).sort()).toEqual(['1', '2']);
    expect(r.placed.C1['1']).toHaveLength(1);
  });

  test('a gate reuses a spare unit of an existing chip', async () => {
    const r = await addComponent(sch, design, { libId: '74xx:74LS86', connections: { '4': 'A', '5': 'B' } }, libs);
    expect(r.ref).toBe('U1');
    expect(r.unit).toBe(2);
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.symbols.filter((x) => x.ref === 'U1').map((x) => x.unit).sort()).toEqual([1, 2, 5]);
    expect(s.labels.filter((l) => l.kind === 'label' && (l.text === 'A' || l.text === 'B')).length).toBe(4);
    expect(r.notes.join(' ')).toMatch(/spare gate/);
  });

  test('a new chip gets unit 1 and its power unit, and a note about pins outside the unit', async () => {
    const r = await addComponent(sch, design, { libId: '74xx:74LS00', connections: { '1': 'A', '14': '+5V', '9': 'B' } }, libs);
    expect(r.ref).toBe('U4');
    const s = parseSchematic(r.text, 'PL1_1');
    const units = s.symbols.filter((x) => x.ref === 'U4').map((x) => x.unit).sort();
    expect(units).toEqual([1, 5]);
    expect(r.notes.join(' ')).toMatch(/pin 9/);
    expect(s.symbols.some((x) => x.libId === 'power:+5V' && x.at.y > 0)).toBe(true);
  });

  test('explicit ref and unknown lib', async () => {
    const r = await addComponent(sch, design, { libId: 'Device:R', ref: 'R9', value: '1k' }, libs);
    expect(r.ref).toBe('R9');
    await expect(addComponent(sch, design, { libId: 'Nope:X' }, libs)).rejects.toThrow(/no lib/);
    await expect(addComponent(sch, design, { libId: 'Device:R', ref: 'R1' }, libs)).rejects.toThrow(/already/);
  });
});

describe('connect, disconnect, remove, setValue', () => {
  test('connect to an auto-named net names it first; disconnect removes only what was placed', async () => {
    const r1 = await connectPin(sch, design, 'R3', '2', 'Net-(D1-A)', libs);
    const s1 = parseSchematic(r1.text, 'PL1_1');
    const named = s1.labels.filter((l) => l.text === 'N1');
    expect(named).toHaveLength(2);
    expect(r1.notes.join(' ')).toMatch(/named N1/);
    const placedAll = r1.placed;
    const r2 = disconnectPin(s1, 'R3', '2', placedAll);
    const s2 = parseSchematic(r2.text, 'PL1_1');
    expect(s2.labels.filter((l) => l.text === 'N1')).toHaveLength(1);
    expect(r2.placed['-']).toBeDefined();
    const r3 = disconnectPin(s2, 'R1', '1', {});
    expect(r3.text).toBe(s2.text);
    expect(r3.notes.join(' ')).toMatch(/nothing placed by this tool/);
  });

  test('connect to an existing local net and to a power net', async () => {
    const r = await connectPin(sch, design, 'R4', '2', 'Y1', libs);
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.labels.filter((l) => l.kind === 'label' && l.text === 'Y1')).toHaveLength(2);
    const r2 = await connectPin(s, design, 'R4', '1', 'GND', libs);
    expect(parseSchematic(r2.text, 'PL1_1').symbols.filter((x) => x.libId === 'power:GND')).toHaveLength(7);
    await expect(connectPin(sch, design, 'R4', '9', 'Y1', libs)).rejects.toThrow(/pin 9/);
    await expect(connectPin(sch, design, 'R99', '1', 'Y1', libs)).rejects.toThrow(/R99/);
  });

  test('remove every unit and placed labels; setValue on all units', async () => {
    const added = await addComponent(sch, design, { libId: '74xx:74LS00', connections: { '1': 'A' } }, libs);
    const s = parseSchematic(added.text, 'PL1_1');
    const rm = removeComponent(s, 'U4', added.placed);
    const s2 = parseSchematic(rm.text, 'PL1_1');
    expect(s2.symbols.filter((x) => x.ref === 'U4')).toHaveLength(0);
    expect(s2.labels.length).toBe(4);
    expect(rm.notes.join(' ')).toMatch(/wires drawn by hand/);
    const sv = setValue(sch, 'U2', '74HC04');
    const s3 = parseSchematic(sv.text, 'PL1_1');
    expect(s3.symbols.filter((x) => x.ref === 'U2').every((x) => x.value === '74HC04')).toBe(true);
    expect(() => setValue(sch, 'U9', 'x')).toThrow(/U9/);
  });
});
```

`test/edit-integration.test.ts` (real kicad-cli and libraries; skipped when absent):

```ts
import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KICAD_CLI, KICAD_SYMBOL_DIR } from '../server/config.ts';
import { createKicadCli } from '../server/kicad-cli.ts';
import { createLibraryLookup } from '../server/libraries.ts';
import { ProjectRegistry } from '../server/projects.ts';
import { Service, type ProjectEvent } from '../server/service.ts';
import { Events } from '../server/watch.ts';
import { FIXTURES } from './smoke.test.ts';

const have = existsSync(KICAD_CLI) && existsSync(path.join(KICAD_SYMBOL_DIR, 'Device.kicad_sym'));

async function realService() {
  const work = mkdtempSync(path.join(tmpdir(), 'edit-'));
  const sch = path.join(work, 'PL1_1.kicad_sch');
  copyFileSync(path.join(FIXTURES, 'PL1_1.kicad_sch'), sch);
  const registry = new ProjectRegistry(path.join(work, 'data'));
  await registry.load();
  const service = new Service({ kicad: createKicadCli({ exe: KICAD_CLI, cacheDir: path.join(work, 'cache') }), registry, events: new Events<ProjectEvent>(), watch: false, projectsDir: work, libs: createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR, projectDir: work }) });
  return { service, sch, work };
}

describe.skipIf(!have)('edits verified through kicad-cli', () => {
  test('add an LED with connections, then remove it', async () => {
    const { service, sch, work } = await realService();
    const p = await service.open(sch);
    const out = await service.addComponent(p.info.id, { libId: 'Device:LED', value: 'LED', connections: { '1': 'Y1', '2': '+5V' } });
    expect(out.ref).toBe('D3');
    expect(existsSync(out.backup)).toBe(true);
    expect(readdirSync(path.join(work, '.circuit-ai-backups')).length).toBe(1);
    const d3 = out.project.design.components.get('D3')!;
    expect(d3.pins.get('1')!.net).toBe('/Y1');
    expect(d3.pins.get('2')!.net).toBe('+5V');
    expect(out.project.doc.pinHoles.D3).toBeDefined();
    expect(out.notes.join(' ')).toMatch(/File > Revert/);
    const rm = await service.removeComponent(p.info.id, 'D3');
    expect(rm.project.design.components.has('D3')).toBe(false);
    expect(rm.project.design.nets.get('/Y1')!.some((m) => m.ref === 'D3')).toBe(false);
  }, 60000);

  test('labels land on pins at every rotation and mirror', async () => {
    const { service, work } = await realService();
    const lib = (await createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR }).symbolText('Device:R')).replace(/^\(symbol/, '(symbol');
    const sym = (ref: string, x: number, y: number, rot: number, mirror: string | null) => `(symbol (lib_id "Device:R") (at ${x} ${y} ${rot}) ${mirror ? `(mirror ${mirror}) ` : ''}(unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${crypto.randomUUID()}") (property "Reference" "${ref}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "1k" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${crypto.randomUUID()}")) (pin "2" (uuid "${crypto.randomUUID()}")) (instances (project "rot" (path "/11111111-1111-1111-1111-111111111111" (reference "${ref}") (unit 1)))))`;
    const text = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "11111111-1111-1111-1111-111111111111") (paper "A4") (lib_symbols ${lib}) ${sym('R1', 50, 50, 0, null)} ${sym('R2', 80, 50, 90, null)} ${sym('R3', 110, 50, 180, null)} ${sym('R4', 140, 50, 270, null)} ${sym('R5', 170, 50, 0, 'x')} ${sym('R6', 200, 50, 90, 'y')} (sheet_instances (path "/" (page "1"))))`;
    const file = path.join(work, 'rot.kicad_sch');
    writeFileSync(file, text);
    const p = await service.open(file);
    for (const ref of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      await service.connect(p.info.id, ref, '1', `TOP${ref}`);
      await service.connect(p.info.id, ref, '2', `BOT${ref}`);
    }
    const final = service.get(p.info.id);
    for (const ref of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      expect(final.design.components.get(ref)!.pins.get('1')!.net).toBe(`/TOP${ref}`);
      expect(final.design.components.get(ref)!.pins.get('2')!.net).toBe(`/BOT${ref}`);
    }
  }, 120000);

  test('a stale file is refused', async () => {
    const { service, sch } = await realService();
    const p = await service.open(sch);
    writeFileSync(sch, p.schematic.text + '\n');
    await expect(service.setValue(p.info.id, 'R1', '2k')).rejects.toThrow(/changed on disk/);
    await service.refresh(p.info.id);
    const out = await service.setValue(p.info.id, 'R1', '2k');
    expect(out.project.design.components.get('R1')!.value).toBe('2k');
  }, 60000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/ops.test.ts test/edit-integration.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/kicad/ops.ts**

```ts
// The five schematic operations, pure: they take a parsed Schematic and the
// current Design and return new text plus what was placed.

import type { Design } from '../netlist.ts';
import { displayName, isAutoNamed, isUnconnected } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { parseLibSymbol, parseSchematic, pinsOfUnit, powerUnit, type LibPin, type Point, type Schematic, type SymbolInstance } from './schematic.ts';
import { pinBodyDirection, pinPosition } from './transform.ts';
import { appendTopLevel, freeSpot, insertLibSymbol, labelNode, labelRotation, newUuid, nextLabelName, nextReference, powerRotation, removeByUuid, setPropertyValue, symbolNode } from './writer.ts';
import { isList, parse } from '../sexpr.ts';

export type LibProvider = (libId: string) => Promise<string>;

export interface NetTarget {
  kind: 'local' | 'global' | 'power';
  name: string;
}

export interface OpResult {
  text: string;
  placed: Record<string, Record<string, string[]>>;
  notes: string[];
  ref?: string;
  unit?: number;
}

export class OpError extends Error {}

const REVERT = 'KiCad does not reload files changed on disk: use File > Revert if the project is open in KiCad.';

export function netTarget(netName: string, design: Design): NetTarget | 'auto' {
  if (isAutoNamed(netName)) return 'auto';
  const exact = design.nets.has(netName) ? netName : [...design.nets.keys()].find((n) => displayName(n) === netName);
  const name = exact ?? netName;
  if (powerKind(name)) return { kind: 'power', name: displayName(name) };
  if (name.startsWith('/')) return { kind: 'local', name: name.slice(1) };
  if (exact) return { kind: 'global', name };
  return { kind: 'local', name };
}

export function pinEnd(sch: Schematic, ref: string, pin: string): { sym: SymbolInstance; at: Point; away: Point } | null {
  for (const sym of sch.symbols) {
    if (sym.ref !== ref) continue;
    const lib = sch.libSymbols.get(sym.libId);
    if (!lib) continue;
    const p = pinsOfUnit(lib, sym.unit).find((x) => x.number === pin);
    if (!p) continue;
    const dir = pinBodyDirection(sym, p);
    return { sym, at: pinPosition(sym, p), away: { x: -dir.x, y: -dir.y } };
  }
  return null;
}

const merge = (into: Record<string, Record<string, string[]>>, ref: string, pin: string, uuid: string) => {
  ((into[ref] ??= {})[pin] ??= []).push(uuid);
};

/** Place a label or power symbol on a pin end. Returns new text and the uuid placed. */
async function attach(sch: Schematic, ref: string, pin: string, target: NetTarget, libs: LibProvider): Promise<{ text: string; uuid: string }> {
  const end = pinEnd(sch, ref, pin);
  if (!end) throw new OpError(`${ref} has no pin ${pin} in the schematic`);
  const uuid = newUuid();
  if (target.kind === 'power') {
    const libId = `power:${target.name}`;
    let text = sch.text;
    if (!sch.libSymbols.has(libId)) text = insertLibSymbol(sch, await libs(libId));
    const s2 = parseSchematic(text, sch.project);
    const node = symbolNode({ libId, at: end.at, rot: powerRotation(end.away), unit: 1, ref: nextReference(s2, '#PWR0'), value: target.name, pinNumbers: ['1'], project: s2.project, rootUuid: s2.uuid, hideReference: true, uuid });
    return { text: appendTopLevel(s2, node), uuid };
  }
  const node = labelNode({ kind: target.kind === 'global' ? 'global_label' : 'label', text: target.name, at: end.at, rot: labelRotation(end.away), uuid });
  return { text: appendTopLevel(sch, node), uuid };
}

export async function connectPin(sch: Schematic, design: Design, ref: string, pin: string, net: string, libs: LibProvider): Promise<OpResult> {
  if (!sch.symbols.some((s) => s.ref === ref)) throw new OpError(`no component ${ref} in the schematic`);
  if (!pinEnd(sch, ref, pin)) throw new OpError(`${ref} has no pin ${pin}`);
  const placed: OpResult['placed'] = {};
  const notes: string[] = [];
  let target = netTarget(net, design);
  let cur = sch;
  if (target === 'auto') {
    const members = design.nets.get(net) ?? [];
    const anchor = members.find((m) => pinEnd(cur, m.ref, m.pin));
    if (!anchor) throw new OpError(`net ${net} has no pin to attach a name to`);
    const name = nextLabelName(cur);
    const a = await attach(cur, anchor.ref, anchor.pin, { kind: 'local', name }, libs);
    merge(placed, anchor.ref, anchor.pin, a.uuid);
    notes.push(`net ${net} had only an automatic name; named ${name} with a label on ${anchor.ref} pin ${anchor.pin}`);
    cur = parseSchematic(a.text, sch.project);
    target = { kind: 'local', name };
  }
  const r = await attach(cur, ref, pin, target, libs);
  merge(placed, ref, pin, r.uuid);
  notes.push(`${ref} pin ${pin} joined to ${target.name} with a ${target.kind === 'power' ? 'power symbol' : target.kind + ' label'}`, REVERT);
  return { text: r.text, placed, notes };
}

export async function addComponent(sch: Schematic, design: Design, a: { libId: string; value?: string; ref?: string; connections?: Record<string, string> }, libs: LibProvider): Promise<OpResult> {
  const notes: string[] = [];
  const placed: OpResult['placed'] = {};
  const libText = await libs(a.libId);
  const libRoot = parse(libText).items[0];
  if (!isList(libRoot)) throw new OpError(`library returned no symbol for ${a.libId}`);
  const lib = parseLibSymbol(libRoot);
  let text = insertLibSymbol(sch, libText);
  let cur = parseSchematic(text, sch.project);
  if (a.ref && cur.symbols.some((s) => s.ref === a.ref)) throw new OpError(`reference ${a.ref} is already used; leave ref empty to get the next free one`);
  const pwrUnit = powerUnit(lib);
  const gateUnits = Array.from({ length: lib.unitCount }, (_, i) => i + 1).filter((u) => u !== pwrUnit);
  const prefix = a.ref ? a.ref.replace(/\d+$/, '') : lib.power ? '#PWR0' : (/^(property\s+"Reference"|)/.test('') ? 'U' : refPrefixOf(libText));
  let ref = a.ref ?? '';
  let unit = 1;
  const value = a.value ?? lib.name;
  let spot = 0;
  const nodes: string[] = [];
  const pinsFor = (u: number) => pinsOfUnit(lib, u).map((p) => p.number);
  if (!a.ref && lib.unitCount > 1 && !lib.power) {
    const byRef = new Map<string, Set<number>>();
    for (const s of cur.symbols) if (s.libId === a.libId || (s.value === value && s.libId.endsWith(`:${lib.name}`))) byRef.set(s.ref, new Set([...(byRef.get(s.ref) ?? []), s.unit]));
    for (const [r, used] of byRef) {
      const free = gateUnits.find((u) => !used.has(u));
      if (free) {
        ref = r;
        unit = free;
        notes.push(`used spare gate: unit ${free} of ${r} (${value})`);
        break;
      }
    }
  }
  if (!ref) ref = nextReference(cur, prefix);
  const at = freeSpot(cur, spot++);
  nodes.push(symbolNode({ libId: a.libId, at, unit, ref, value, pinNumbers: pinsFor(unit), project: cur.project, rootUuid: cur.uuid, hideReference: lib.power }));
  const addedUnits = [unit];
  if (!notes.length && pwrUnit && lib.unitCount > 1) {
    const at2 = { x: at.x, y: at.y + 12.7 };
    nodes.push(symbolNode({ libId: a.libId, at: at2, unit: pwrUnit, ref, value, pinNumbers: pinsFor(pwrUnit), project: cur.project, rootUuid: cur.uuid }));
    addedUnits.push(pwrUnit);
  }
  for (const n of nodes) {
    text = appendTopLevel(cur, n);
    cur = parseSchematic(text, sch.project);
  }
  notes.push(`added ${ref} (${a.libId}${value !== lib.name ? `, ${value}` : ''})${addedUnits.length > 1 ? ` with units ${addedUnits.join(' and ')}` : lib.unitCount > 1 ? ` unit ${unit}` : ''}`);
  const available = new Set(addedUnits.flatMap(pinsFor));
  for (const [pin, net] of Object.entries(a.connections ?? {})) {
    if (!available.has(pin)) {
      notes.push(`pin ${pin} is not part of the placed unit${addedUnits.length > 1 ? 's' : ''} (${[...available].join(', ')}); connect it after adding the unit that has it`);
      continue;
    }
    const r = await connectPin(cur, design, ref, pin, net, libs);
    for (const [rr, pins] of Object.entries(r.placed)) for (const [pp, ids] of Object.entries(pins)) for (const id of ids) merge(placed, rr, pp, id);
    notes.push(...r.notes.filter((n) => n !== REVERT));
    text = r.text;
    cur = parseSchematic(text, sch.project);
  }
  notes.push(REVERT);
  return { text, placed, notes, ref, unit };
}

function refPrefixOf(libText: string): string {
  const m = /\(property\s+"Reference"\s+"([A-Za-z#]+)"/.exec(libText);
  return m ? m[1] : 'U';
}

export function disconnectPin(sch: Schematic, ref: string, pin: string, placed: Record<string, Record<string, string[]>>): OpResult {
  const ids = placed[ref]?.[pin] ?? [];
  if (!ids.length) return { text: sch.text, placed: {}, notes: [`${ref} pin ${pin}: nothing placed by this tool to remove; labels or wires drawn by hand stay (delete them in KiCad)`] };
  const text = removeByUuid(sch, ids);
  return { text, placed: { '-': { [ref]: ids, pin: [pin] } }, notes: [`removed ${ids.length} label${ids.length > 1 ? 's' : ''} from ${ref} pin ${pin}`, REVERT] };
}

export function removeComponent(sch: Schematic, ref: string, placed: Record<string, Record<string, string[]>>): OpResult {
  const units = sch.symbols.filter((s) => s.ref === ref);
  if (!units.length) throw new OpError(`no component ${ref} in the schematic`);
  const ids = [...units.map((u) => u.uuid), ...Object.values(placed[ref] ?? {}).flat()];
  return { text: removeByUuid(sch, ids), placed: { '-': { [ref]: ids, '*': ['*'] } }, notes: [`removed ${ref} (${units.length} unit${units.length > 1 ? 's' : ''}) and ${ids.length - units.length} placed labels; wires drawn by hand to ${ref} remain, delete them in KiCad`, REVERT] };
}

export function setValue(sch: Schematic, ref: string, value: string): OpResult {
  let cur = sch;
  const units = sch.symbols.filter((s) => s.ref === ref);
  if (!units.length) throw new OpError(`no component ${ref} in the schematic`);
  for (let i = 0; i < units.length; i++) {
    const sym = cur.symbols.filter((s) => s.ref === ref)[i];
    cur = parseSchematic(setPropertyValue(cur, sym, 'Value', value), sch.project);
  }
  return { text: cur.text, placed: {}, notes: [`${ref} value set to ${value}`, REVERT] };
}

export { isUnconnected };
```

Clean-ups before running: replace the confusing `prefix` line with `const prefix = a.ref ? a.ref.replace(/\d+$/, '') : lib.power ? '#PWR0' : refPrefixOf(libText);` and delete the final `export { isUnconnected };` line and the unused `LibPin` import.

- [ ] **Step 4: Extend server/service.ts and server/boot.ts**

In `service.ts` add imports:

```ts
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { addComponent, connectPin, disconnectPin, removeComponent, setValue, type OpResult } from '../src/kicad/ops.ts';
import type { LibraryLookup } from './libraries.ts';
```

Add `libs: LibraryLookup;` to `ServiceDeps`, and these members to `Service`:

```ts
  private async backup(p: OpenProject): Promise<string> {
    const dir = path.join(path.dirname(p.info.path), '.circuit-ai-backups');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const target = path.join(dir, `${p.info.name}-${stamp}.kicad_sch`);
    await copyFile(p.info.path, target);
    const old = (await readdir(dir)).filter((f) => f.startsWith(`${p.info.name}-`) && f.endsWith('.kicad_sch')).sort().reverse().slice(20);
    for (const f of old) await rm(path.join(dir, f), { force: true });
    return target;
  }

  async edit(id: string, run: (p: OpenProject) => Promise<OpResult>): Promise<EditOutcome> {
    const p = this.get(id);
    const s = await stat(p.info.path);
    if (s.mtimeMs !== p.mtimeMs || s.size !== p.size) throw new ServiceError('the schematic changed on disk since it was read; call refresh (or reopen) and try again', 409);
    const result = await run(p);
    const backup = await this.backup(p);
    await writeFile(p.info.path, result.text);
    const removed = result.placed['-'];
    if (removed) {
      for (const [ref, ids] of Object.entries(removed)) {
        if (ref === 'pin' || ref === '*') continue;
        if (removed['*']) delete p.sidecar.placed[ref];
        else for (const [pin, list] of Object.entries(p.sidecar.placed[ref] ?? {})) p.sidecar.placed[ref][pin] = list.filter((u) => !ids.includes(u));
      }
    }
    for (const [ref, pins] of Object.entries(result.placed)) {
      if (ref === '-') continue;
      for (const [pin, ids] of Object.entries(pins)) ((p.sidecar.placed[ref] ??= {})[pin] ??= []).push(...ids);
    }
    await writeSidecar(p.info.path, p.sidecar);
    const fresh = await this.refresh(id);
    return { project: fresh, backup, notes: result.notes, ref: result.ref, unit: result.unit };
  }

  addComponent(id: string, a: { libId: string; value?: string; ref?: string; connections?: Record<string, string> }) {
    return this.edit(id, (p) => addComponent(p.schematic, p.design, a, this.deps.libs.symbolText).catch(rethrow));
  }
  connect(id: string, ref: string, pin: string, net: string) {
    return this.edit(id, (p) => connectPin(p.schematic, p.design, ref, pin, net, this.deps.libs.symbolText).catch(rethrow));
  }
  disconnect(id: string, ref: string, pin: string) {
    return this.edit(id, async (p) => disconnectPin(p.schematic, ref, pin, p.sidecar.placed));
  }
  removeComponent(id: string, ref: string) {
    return this.edit(id, async (p) => removeComponent(p.schematic, ref, p.sidecar.placed));
  }
  setValue(id: string, ref: string, value: string) {
    return this.edit(id, async (p) => setValue(p.schematic, ref, value));
  }
```

with, at module level:

```ts
export interface EditOutcome {
  project: OpenProject;
  backup: string;
  notes: string[];
  ref?: string;
  unit?: number;
}

const rethrow = (e: unknown): never => {
  throw e instanceof ServiceError ? e : new ServiceError((e as Error).message, 400);
};
```

Also wrap `disconnect`, `removeComponent`, `setValue` callbacks in try/catch that call `rethrow` so `OpError` becomes a 400.

In `boot.ts` import `createLibraryLookup` and `KICAD_SYMBOL_DIR`, and pass `libs: createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR })` to the `Service`. In `test/service.test.ts` `makeService`, pass `libs: { symbolText: async (id) => { throw new Error(`no lib ${id}`); } }` so the earlier tests still construct.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/ops.test.ts test/edit-integration.test.ts test/service.test.ts`
Expected: all pass (the integration tests run because KiCad 9 is installed here). If the rotation test fails for a particular `R`, the failing orientation names the matrix case to re-check against `symbolMatrix`.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/kicad/ops.ts circut-ai-tool/server/service.ts circut-ai-tool/server/boot.ts circut-ai-tool/test/ops.test.ts circut-ai-tool/test/edit-integration.test.ts circut-ai-tool/test/service.test.ts
git commit -m "feat(circuit): add, connect, disconnect, remove and set_value with backups"
```

---

### Task 25: REST routes and MCP tools for editing

**Files:**
- Modify: `circut-ai-tool/server/api.ts`
- Modify: `circut-ai-tool/server/openapi.ts`
- Modify: `circut-ai-tool/server/mcp.ts`
- Modify: `circut-ai-tool/test/mcp.test.ts`
- Modify: `circut-ai-tool/test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp.test.ts`:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { KICAD_CLI, KICAD_SYMBOL_DIR } from '../server/config.ts';

describe('MCP edit tools', () => {
  const have = existsSync(KICAD_CLI) && existsSync(path.join(KICAD_SYMBOL_DIR, 'Device.kicad_sym'));
  test('edit tools are listed and refuse unknown parts', async () => {
    const { client, sch } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['add_component', 'connect', 'disconnect', 'remove_component', 'set_value']) expect(tools).toContain(t);
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const bad = (await client.callTool({ name: 'add_component', arguments: { project: id, part: 'flux capacitor' } })) as Result;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/list_supported_parts/);
  });
  test.skipIf(!have)('set_value through the real pipeline', async () => {
    const { client, sch } = await connectReal();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const r = (await client.callTool({ name: 'set_value', arguments: { project: id, ref: 'R1', value: '2k2' } })) as Result;
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/R1 value set to 2k2/);
    expect(r.content[0].text).toMatch(/File > Revert/);
    expect(r.structuredContent!.backup).toMatch(/\.circuit-ai-backups/);
  }, 60000);
});
```

with a `connectReal()` helper next to `connect()` that builds the service like `realService()` in `test/edit-integration.test.ts` (import it from there by exporting it) and connects an in-memory client.

Append to `test/api.test.ts`:

```ts
  test('edit routes validate input', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const bad = await json(`/api/projects/${id}/edit/connect`, { ref: 'R1' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/pin/);
    const nope = await json(`/api/projects/${id}/edit/value`, { ref: 'R99', value: '1' });
    expect(nope.status).toBe(400);
  });
```

Run: `cd circut-ai-tool && bun test test/mcp.test.ts test/api.test.ts`
Expected: the new tests FAIL (tools and routes missing).

- [ ] **Step 2: Add the REST routes**

In `server/api.ts` add after the layout routes:

```ts
  const editResult = (out: Awaited<ReturnType<Service['setValue']>>) => ({ ok: true, ref: out.ref, unit: out.unit, backup: out.backup, notes: out.notes, checks: out.project.doc.checks, summary: summaryOf(out.project) });
  api.post('/projects/:id/edit/add', async (c) => {
    const b = (await c.req.json()) as { part?: string; libId?: string; value?: string; ref?: string; connections?: Record<string, string> };
    const libId = b.libId ?? (b.part ? resolveAlias(b.part)?.libId : undefined) ?? (b.part?.includes(':') ? b.part : undefined);
    if (!libId) throw new ServiceError(`unknown part "${b.part ?? ''}"; use a name from list_supported_parts (GET /api/parts) or a KiCad lib_id like Device:R`);
    return c.json(editResult(await service.addComponent(c.req.param('id'), { libId, value: b.value ?? resolveAlias(b.part ?? '')?.defaultValue, ref: b.ref, connections: b.connections })));
  });
  api.post('/projects/:id/edit/connect', async (c) => {
    const b = (await c.req.json()) as { ref?: string; pin?: string; net?: string };
    if (!b.ref || !b.pin || !b.net) throw new ServiceError('body must be {"ref": "R1", "pin": "1", "net": "A"}');
    return c.json(editResult(await service.connect(c.req.param('id'), b.ref, String(b.pin), b.net)));
  });
  api.post('/projects/:id/edit/disconnect', async (c) => {
    const b = (await c.req.json()) as { ref?: string; pin?: string };
    if (!b.ref || !b.pin) throw new ServiceError('body must be {"ref": "R1", "pin": "1"}');
    return c.json(editResult(await service.disconnect(c.req.param('id'), b.ref, String(b.pin))));
  });
  api.post('/projects/:id/edit/remove', async (c) => {
    const b = (await c.req.json()) as { ref?: string };
    if (!b.ref) throw new ServiceError('body must be {"ref": "R1"}');
    return c.json(editResult(await service.removeComponent(c.req.param('id'), b.ref)));
  });
  api.post('/projects/:id/edit/value', async (c) => {
    const b = (await c.req.json()) as { ref?: string; value?: string };
    if (!b.ref || b.value === undefined) throw new ServiceError('body must be {"ref": "R1", "value": "10k"}');
    return c.json(editResult(await service.setValue(c.req.param('id'), b.ref, String(b.value))));
  });
```

and import `resolveAlias` from `../src/parts/aliases.ts`. Document the five routes in `server/openapi.ts` with `op(...)` entries and request bodies matching the shapes above.

- [ ] **Step 3: Add the MCP tools**

In `server/mcp.ts`, before `return server;`:

```ts
  const editText = (out: Awaited<ReturnType<Service['setValue']>>) => `${out.notes.join('\n')}\nBackup: ${out.backup}\n${checksText(out.project)}`;
  const editStructured = (out: Awaited<ReturnType<Service['setValue']>>) => ({ ok: true, ref: out.ref, unit: out.unit, backup: out.backup, notes: out.notes, checks: out.project.doc.checks });

  server.registerTool('add_component', { title: 'Add a component', description: 'Add a part to the schematic (and therefore the breadboard). "part" is a name from list_supported_parts ("LED", "10k" is not a part: give value separately) or a KiCad lib_id ("Device:R"). Optional connections map pin numbers to net names; power nets get a power symbol, other nets a label. For 74xx gates a spare gate of an existing chip is reused when possible.', inputSchema: { project, part: z.string().describe('Alias like "resistor", "LED", "74LS00", or lib_id like "Device:R"'), value: z.string().optional().describe('Value shown, e.g. "10k", "100n", "74LS00"'), ref: z.string().optional().describe('Reference to use; default: next free (R5, U4, ...)'), connections: z.record(z.string(), z.string()).optional().describe('pin number -> net name, e.g. {"1": "A", "2": "+5V"}') } }, ({ project: id, part, value, ref, connections }) => guard(async () => {
    const alias = resolveAlias(part);
    const libId = alias?.libId ?? (part.includes(':') ? part : null);
    if (!libId) return fail(`unknown part "${part}"; call list_supported_parts for names, or give a KiCad lib_id like Device:R`);
    const out = await service.addComponent((await open(id)).info.id, { libId, value: value ?? alias?.defaultValue, ref, connections });
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('connect', { title: 'Connect a pin to a net', description: 'Join a pin to a net by placing a label (or a power symbol for +5V, GND and the like) on the pin in the schematic. Use an existing net name to join it, or a new name to start a net.', inputSchema: { project, ref: z.string(), pin: z.string().describe('Pin number as printed on the package, e.g. "3"'), net: z.string().describe('Net name, e.g. "A", "Y1", "+5V", "GND", or a new name') } }, ({ project: id, ref, pin, net }) => guard(async () => {
    const out = await service.connect((await open(id)).info.id, ref, pin, net);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('disconnect', { title: 'Disconnect a pin', description: 'Remove the labels or power symbols this tool placed on a pin. Wires and labels drawn by hand in KiCad are left alone and reported.', inputSchema: { project, ref: z.string(), pin: z.string() } }, ({ project: id, ref, pin }) => guard(async () => {
    const out = await service.disconnect((await open(id)).info.id, ref, pin);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('remove_component', { title: 'Remove a component', description: 'Delete every unit of a component and the labels this tool placed on it.', inputSchema: { project, ref: z.string() } }, ({ project: id, ref }) => guard(async () => {
    const out = await service.removeComponent((await open(id)).info.id, ref);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());

  server.registerTool('set_value', { title: 'Set a value', description: 'Change the Value field of a component (all units), e.g. R1 to "2k2" or U2 to "74HC04".', inputSchema: { project, ref: z.string(), value: z.string() } }, ({ project: id, ref, value }) => guard(async () => {
    const out = await service.setValue((await open(id)).info.id, ref, value);
    return { content: [text(editText(out))], structuredContent: editStructured(out) };
  })());
```

and import `resolveAlias` from `../src/parts/aliases.ts`.

- [ ] **Step 4: Run everything**

Run: `cd circut-ai-tool && bun test && bun run typecheck && bun run build`
Expected: all green.

End-to-end check with the real server: `bun start`, then in Claude Code (with the `circuit-designer` MCP connected) ask it to open PL1_1, add an LED on Y2 with a 330 Ω resistor to +5V, and render the board. Confirm: the schematic gains D3 and R5 with labels, a backup appears in `.circuit-ai-backups`, the browser reloads and shows the new parts placed and wired, and the checks report 0 errors. Then open the project in KiCad, use File > Revert, and confirm the new parts are visible there. Finally `git status` in the repo must show no changes under `Documents\KiCad` (it is outside the repo) and no stray files in the repo.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/server/api.ts circut-ai-tool/server/openapi.ts circut-ai-tool/server/mcp.ts circut-ai-tool/test/mcp.test.ts circut-ai-tool/test/api.test.ts
git commit -m "feat(circuit): schematic edit routes and MCP tools"
```

---

## Self-review (part 4)

- Spec coverage: `add_component` (alias or lib_id, `lib_symbols` copy with flattened extends, free-space grid, next free reference, spare gate reuse, unit 1 plus power unit for new chips, connections), `connect` (local label for `/NAME` nets and new names, global label for global nets, power symbol for power nets, auto-named nets named first), `disconnect` (only app-placed uuids from the sidecar, hand-drawn reported), `remove_component` (all units and placed labels, hand-drawn wires reported), `set_value` (all units), backups (20 kept), stale-file 409, the File > Revert reminder, checks returned after every edit, pin positions validated through kicad-cli at every rotation and both mirrors.
- Placeholder scan: the two draft leftovers in `ops.ts` (`prefix` expression, `export { isUnconnected }`) and one in `writer.ts` (`void font`) are called out for removal in their steps.
- Type consistency: `OpResult.placed` uses the `'-'` key for removals and the service merges it into `sidecar.placed`; `Service.edit` returns `EditOutcome` used by both `api.ts` (`editResult`) and `mcp.ts` (`editText`, `editStructured`); `LibraryLookup.symbolText` has the `LibProvider` signature so it is passed directly to the ops; `resolveAlias` and `PART_ALIASES` come from part 2's `src/parts/aliases.ts`.
