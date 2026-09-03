# Circuit AI Tool Implementation Plan, part 1c: checks, simulator, guide, renderer, pipeline and CLI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify a layout against the netlist, simulate the logic, write the build guide, draw the board as SVG, and tie everything into one `buildLayoutDoc()` plus a command-line script that turns a `.kicad_sch` into JSON and SVG.

**Architecture:** `src/checks` runs union-find over strips and rails to prove the physical wiring equals the netlist, then DC and polarity rules. `src/sim` simulates 74xx combinational gates and 7-segment decoders over the design nets (only reported when the connectivity check passes, so what it shows is the wired board). `src/guide.ts` turns the layout into ordered steps, pinouts and a parts list. `src/render` produces one SVG string for the browser and the server. `src/pipeline.ts` composes all of it into `LayoutDoc`. `scripts/breadboard.ts` is the first end-to-end deliverable.

**Tech Stack:** Bun 1.3, TypeScript 5.9, `bun test`. Depends on parts 1a and 1b.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md` (sections "Checks and simulation", "Guide", "Rendering")

## Global Constraints

- Same as parts 1a and 1b.
- Refinement of the spec: the simulator evaluates over design net names and is gated on the connectivity check having no errors (so the physical wiring is proven equal to the nets first). The renderer takes a concrete `Theme` object instead of CSS variables so the same string renders identically in the browser and through resvg on the server.
- Renderer geometry: pitch `P = 18` px, column 1 at `X0 = 40`, row centres from `ROWY`. Every part, package and wire element carries `data-ref` / `data-net` / `data-wire` attributes so the client can attach behaviour without re-rendering.

---

### Task 8: Checks

**Files:**
- Create: `circut-ai-tool/src/checks/index.ts`
- Test: `circut-ai-tool/test/checks.test.ts`

**Interfaces:**
- Consumes: `EngineResult`, `Design`, `icInfo`, `DC`, `parseOhms`, board helpers.
- Produces:
  - `interface Check { id: string; level: 'error' | 'warning' | 'info'; message: string; refs: string[] }`
  - `class UnionFind { find(x: string): string; union(a: string, b: string): void }`
  - `holeNode(h: Hole, board: BoardSpec): string` (strip id, or rail segment id `T+`, `T+L`, `T+R`)
  - `connectivity(res: EngineResult): UnionFind` (wires and supply leads joined; supply leads also joined to `PSU:<net>`)
  - `runChecks(design: Design, res: EngineResult): Check[]`
  - `hasErrors(checks: Check[]): boolean`

- [ ] **Step 1: Write the failing tests**

`test/checks.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { connectivity, hasErrors, holeNode, runChecks } from '../src/checks/index.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

const pl1 = parseNetlist(readFixture('PL1_1.net'));

describe('holeNode', () => {
  test('strips and split rails', () => {
    const full = { cols: 63, kind: 'full' as const, splitCol: 30, railGapEvery: 6 };
    expect(holeNode({ col: 12, row: 'c' }, full)).toBe('T12');
    expect(holeNode({ col: 12, row: 'T+' }, full)).toBe('T+L');
    expect(holeNode({ col: 40, row: 'B-' }, full)).toBe('B-R');
    expect(holeNode({ col: 40, row: 'B-' }, { ...full, splitCol: null })).toBe('B-');
  });
});

describe('runChecks on PL1_1', () => {
  const res = layout(pl1, emptySidecar());
  const checks = runChecks(pl1, res);

  test('the generated layout passes connectivity and power checks', () => {
    expect(checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(hasErrors(checks)).toBe(false);
    expect(checks.some((c) => c.id === 'connectivity' && c.level === 'info')).toBe(true);
  });

  test('LED polarity is explained', () => {
    const led = checks.filter((c) => c.id === 'led-polarity');
    expect(led).toHaveLength(2);
    expect(led[0].level).toBe('info');
    expect(led[0].message).toMatch(/lights when .* is low/);
  });

  test('unused gate inputs are not reported as floating', () => {
    expect(checks.filter((c) => c.id === 'floating-input')).toEqual([]);
  });

  test('a removed wire breaks connectivity, a moved wire shorts nets', () => {
    const broken = { ...res, wires: res.wires.filter((w) => w.net !== '/A') };
    const c1 = runChecks(pl1, broken);
    expect(c1.some((c) => c.id === 'connectivity' && c.level === 'error' && c.message.includes('A'))).toBe(true);
    const uf = connectivity(broken);
    const holes = pl1.nets.get('/A')!.map((m) => holeNode(res.pinHoles[m.ref][m.pin], res.board));
    expect(new Set(holes.map((h) => uf.find(h))).size).toBeGreaterThan(1);

    const wA = res.wires.find((w) => w.net === '/A')!;
    const wB = res.wires.find((w) => w.net === '/B')!;
    const shorted = { ...res, wires: [...res.wires, { net: '/A', a: wA.a, b: wB.a, role: 'signal' as const }] };
    const c2 = runChecks(pl1, shorted);
    expect(c2.some((c) => c.id === 'short' && c.level === 'error')).toBe(true);
  });
});

describe('DC and polarity rules', () => {
  test('reversed LED, missing resistor, driver conflict and floating input', () => {
    const d = makeDesign({
      U1: { lib: '74xx', part: '74LS00', value: '74LS00', pins: { '1': ['~', 'input', '/A'], '2': ['~', 'input', 'unconnected-(U1-Pad2)'], '3': ['~', 'output', '/Y'], '4': ['~', 'input', '/A'], '5': ['~', 'input', '/A'], '6': ['~', 'output', '/Y'], '7': ['GND', 'power_in', 'GND'], '14': ['VCC', 'power_in', '+5V'], '8': ['~', 'output', 'unconnected-(U1-Pad8)'], '9': ['~', 'input', 'unconnected-(U1-Pad9)'], '10': ['~', 'input', 'unconnected-(U1-Pad10)'], '11': ['~', 'output', 'unconnected-(U1-Pad11)'], '12': ['~', 'input', 'unconnected-(U1-Pad12)'], '13': ['~', 'input', 'unconnected-(U1-Pad13)'] } },
      SW1: { lib: 'Switch', part: 'SW_SPST', value: 'SW_SPST', pins: { '1': ['A', 'passive', '/A'], '2': ['B', 'passive', 'GND'] } },
      R1: { lib: 'Device', part: 'R', value: '10k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/A'] } },
      D1: { lib: 'Device', part: 'LED', value: 'LED', pins: { '1': ['K', 'passive', '+5V'], '2': ['A', 'passive', '/Y'] } },
    });
    const res = layout(d, emptySidecar());
    const checks = runChecks(d, res);
    expect(checks.some((c) => c.id === 'led-polarity' && c.level === 'error' && c.refs.includes('D1'))).toBe(true);
    expect(checks.some((c) => c.id === 'led-current' && c.level === 'warning' && c.message.includes('series resistor'))).toBe(true);
    expect(checks.some((c) => c.id === 'driver-conflict' && c.level === 'error')).toBe(true);
    expect(checks.some((c) => c.id === 'floating-input' && c.refs.includes('U1') && c.message.includes('pin 2'))).toBe(true);
  });

  test('LED current is computed from the series resistor', () => {
    const d = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '47', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/LA'] } },
      D1: { lib: 'Device', part: 'LED', value: 'LED', pins: { '1': ['K', 'passive', 'GND'], '2': ['A', 'passive', '/LA'] } },
    });
    const checks = runChecks(d, layout(d, emptySidecar()));
    const cur = checks.find((c) => c.id === 'led-current')!;
    expect(cur.level).toBe('warning');
    expect(cur.message).toMatch(/64 mA/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/checks.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/checks/index.ts**

```ts
// Verify a layout: hole use, physical connectivity versus the netlist, supply
// reach, LED polarity, driver conflicts, floating inputs, fan-out and LED
// current. Checks read the hole map, not the schematic, so they prove the
// wiring the user will build.

import { holeKey, holeName, isRail, stripOf } from '../layout/board.ts';
import type { EngineResult } from '../layout/engine.ts';
import type { BoardSpec, Hole } from '../layout/types.ts';
import type { Design } from '../netlist.ts';
import { displayName, isUnconnected } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { DC, icInfo } from '../parts/gates.ts';
import { parseOhms } from '../parts/values.ts';

export interface Check {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  refs: string[];
}

export const LED_VF = 2.0;

export class UnionFind {
  private p = new Map<string, string>();

  find(x: string): string {
    let r = this.p.get(x);
    if (r === undefined) {
      this.p.set(x, x);
      return x;
    }
    while (r !== this.p.get(r)) r = this.p.get(r)!;
    let cur = x;
    while (cur !== r) {
      const next = this.p.get(cur)!;
      this.p.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

export function holeNode(h: Hole, board: BoardSpec): string {
  if (!isRail(h.row)) return stripOf(h);
  if (!board.splitCol) return h.row;
  return h.col > board.splitCol ? `${h.row}R` : `${h.row}L`;
}

export function connectivity(res: EngineResult): UnionFind {
  const uf = new UnionFind();
  for (const w of res.wires) uf.union(holeNode(w.a, res.board), holeNode(w.b, res.board));
  for (const lead of res.supply?.leads ?? []) uf.union(`PSU:${lead.net}`, holeNode(lead.hole, res.board));
  return uf;
}

export function hasErrors(checks: Check[]): boolean {
  return checks.some((c) => c.level === 'error');
}

export function supplyVolts(name: string): number {
  const m = /^\+?(\d+(?:\.\d+)?)\s*V/i.exec(displayName(name));
  if (m) return Number(m[1]);
  if (/3V3/i.test(name)) return 3.3;
  return 5;
}

export function runChecks(design: Design, res: EngineResult): Check[] {
  const out: Check[] = [];
  const add = (id: string, level: Check['level'], message: string, refs: string[] = []) => out.push({ id, level, message, refs });
  const placed = (ref: string) => !!res.pinHoles[ref];
  const holeOf = (ref: string, pin: string): Hole | undefined => res.pinHoles[ref]?.[pin];

  if (res.error) add('layout', 'error', res.error);
  for (const u of res.unplaced) add('unplaced', 'warning', `${u.ref} not placed: ${u.reason}`, [u.ref]);
  for (const w of res.warnings) add('layout', 'warning', w);

  // hole conflicts
  const owners = new Map<string, string[]>();
  const own = (h: Hole, who: string) => owners.set(holeKey(h), [...(owners.get(holeKey(h)) ?? []), who]);
  for (const [ref, pins] of Object.entries(res.pinHoles)) for (const [pin, h] of Object.entries(pins)) own(h, `${ref} pin ${pin}`);
  res.wires.forEach((w, i) => {
    own(w.a, `wire ${i + 1} (${displayName(w.net)})`);
    own(w.b, `wire ${i + 1} (${displayName(w.net)})`);
  });
  for (const l of res.supply?.leads ?? []) own(l.hole, l.label);
  for (const [k, who] of owners) if (who.length > 1) add('hole-conflict', 'error', `hole ${k} is used by ${who.join(' and ')}`);

  // connectivity
  const uf = connectivity(res);
  const rootOfNet = new Map<string, string>();
  let joined = 0;
  for (const [net, members] of design.nets) {
    if (isUnconnected(net)) continue;
    const nodes = members.filter((m) => placed(m.ref) && holeOf(m.ref, m.pin)).map((m) => ({ m, node: holeNode(holeOf(m.ref, m.pin)!, res.board) }));
    const kind = powerKind(net);
    if (kind && res.supply?.leads.some((l) => l.net === net)) nodes.push({ m: { ref: 'supply', pin: net }, node: `PSU:${net}` });
    if (!nodes.length) continue;
    const roots = new Set(nodes.map((n) => uf.find(n.node)));
    if (roots.size > 1) {
      const groups = [...roots].map((r) => nodes.filter((n) => uf.find(n.node) === r).map((n) => (n.m.ref === 'supply' ? 'the supply' : `${n.m.ref} pin ${n.m.pin}`)).join(', '));
      add('connectivity', 'error', `net ${displayName(net)} is not fully connected: [${groups.join('] and [')}] are separate`, nodes.map((n) => n.m.ref).filter((r) => r !== 'supply'));
    } else {
      joined++;
      rootOfNet.set(net, [...roots][0]);
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const [net, root] of rootOfNet) byRoot.set(root, [...(byRoot.get(root) ?? []), net]);
  for (const nets of byRoot.values()) {
    const distinct = nets.filter((n, i) => !(powerKind(n) === 'gnd' && nets.slice(0, i).some((m) => powerKind(m) === 'gnd')));
    if (distinct.length > 1) add('short', 'error', `nets ${distinct.map(displayName).join(' and ')} are joined on the board`);
  }
  if (!out.some((c) => c.id === 'connectivity')) add('connectivity', 'info', `${joined} nets match the schematic`);

  // pins by net
  const pinsOnNet = (net: string) => (design.nets.get(net) ?? []).map((m) => ({ ...m, pin: design.components.get(m.ref)!.pins.get(m.pin)! }));
  const outputsOn = (net: string) => pinsOnNet(net).filter((p) => p.pin.type === 'output' || p.pin.type === 'open_collector' || p.pin.type === 'tri_state');
  const inputsOn = (net: string) => pinsOnNet(net).filter((p) => p.pin.type === 'input');

  // driver conflicts
  for (const net of design.nets.keys()) {
    const outs = outputsOn(net).filter((p) => p.pin.type === 'output');
    if (outs.length > 1) add('driver-conflict', 'error', `net ${displayName(net)} is driven by ${outs.map((p) => `${p.ref} pin ${p.pin.num}`).join(' and ')}`, outs.map((p) => p.ref));
  }

  // floating inputs on used gates, fan-out, supply current
  let icc = 0;
  for (const pkg of res.packages) {
    if (pkg.kind !== 'dip') continue;
    const comp = design.components.get(pkg.id);
    if (!comp) continue;
    const info = icInfo(res.values[pkg.id] ?? comp.value, pkg.pins);
    if (!info) continue;
    icc += info.spec?.iccMax ?? 0;
    const dc = DC[info.family];
    for (const gate of info.spec?.gates ?? []) {
      const outPin = comp.pins.get(String(gate.output));
      if (!outPin || isUnconnected(outPin.net)) continue;
      const floating = gate.inputs.filter((i) => isUnconnected(comp.pins.get(String(i))?.net ?? 'unconnected-'));
      if (floating.length) add('floating-input', 'warning', `${pkg.id} gate with output pin ${gate.output} is used but input pin${floating.length > 1 ? 's' : ''} ${floating.join(', ')} float${floating.length > 1 ? '' : 's'}; tie unused inputs high or low`, [pkg.id]);
      const loads = inputsOn(outPin.net).filter((p) => p.ref !== pkg.id || p.pin.num !== outPin.num).length;
      if (loads > dc.fanout) add('fanout', 'warning', `${pkg.id} pin ${gate.output} drives ${loads} inputs; 74${info.family} fan-out is ${dc.fanout}`, [pkg.id]);
    }
  }
  if (icc > 0) add('supply-current', 'info', `chips draw up to about ${Math.round(icc * 1000)} mA from ${displayName(res.power.plusName)}`);

  // LEDs: polarity and current
  const volts = supplyVolts(res.power.plusName);
  for (const part of res.parts) {
    if (part.style !== 'LED') continue;
    const [kNet, aNet] = part.nets;
    const kKind = powerKind(kNet);
    const aKind = powerKind(aNet);
    const sinks = outputsOn(kNet);
    const sources = outputsOn(aNet);
    if (kKind === '+' || aKind === 'gnd') add('led-polarity', 'error', `${part.id} is reversed: the cathode (flat side) is on ${displayName(kNet)} and the anode on ${displayName(aNet)}`, [part.id]);
    else if (sinks.length) add('led-polarity', 'info', `${part.id} lights when ${sinks[0].ref} pin ${sinks[0].pin.num} is low`, [part.id]);
    else if (sources.length) add('led-polarity', 'info', `${part.id} lights when ${sources[0].ref} pin ${sources[0].pin.num} is high`, [part.id]);
    else add('led-polarity', 'info', `${part.id}: cathode on ${displayName(kNet)}, anode on ${displayName(aNet)}`, [part.id]);
    const series = res.parts.find((r) => {
      if (r.style !== 'R' || r.id === part.id) return false;
      const sharesK = r.nets.includes(kNet) && !powerKind(kNet);
      const sharesA = r.nets.includes(aNet) && !powerKind(aNet);
      return sharesK !== sharesA;
    });
    if (!series) {
      add('led-current', 'warning', `${part.id} has no series resistor on either side`, [part.id]);
      continue;
    }
    const ohms = parseOhms(series.value);
    if (ohms === null || ohms <= 0) {
      add('led-current', 'warning', `${part.id}: cannot read the value "${series.value}" of series resistor ${series.id}`, [part.id, series.id]);
      continue;
    }
    const mA = ((volts - LED_VF) / ohms) * 1000;
    add('led-current', mA > 25 ? 'warning' : 'info', `${part.id} through ${series.id} (${series.value}): about ${Math.round(mA)} mA${mA > 25 ? ', above the usual 20 mA limit' : ''}`, [part.id, series.id]);
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/checks.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/src/checks circut-ai-tool/test/checks.test.ts
git commit -m "feat(circuit): wiring checks against the netlist, LED and DC rules"
```

---

### Task 9: Logic simulator and truth table

**Files:**
- Create: `circut-ai-tool/src/sim/index.ts`
- Test: `circut-ai-tool/test/sim.test.ts`

**Interfaces:**
- Produces:
  - `interface SimInput { name: string; net: string; control: string; activeLow: boolean }`
  - `interface SimGate { name: string; kind: GateKind; inputs: string[]; output: string; ref: string; pins: { inputs: number[]; output: number } }`
  - `interface SimDecoder { ref: string; kind: '7447' | '7448'; inputs: Record<'A' | 'B' | 'C' | 'D', string>; lampTest: string; blanking: string; outputs: Record<string, string> }`
  - `interface SimLed { ref: string; cathode: string; anode: string }`
  - `interface SimDisplay { ref: string; common: 'cathode' | 'anode'; segments: Record<string, string>; commonNets: string[] }`
  - `interface SimModel { inputs: SimInput[]; gates: SimGate[]; decoders: SimDecoder[]; leds: SimLed[]; displays: SimDisplay[]; resistors: [string, string][]; power: Record<string, 0 | 1>; notSimulated: string[] }`
  - `interface SimResult { nets: Record<string, 0 | 1>; leds: Record<string, boolean>; segments: Record<string, Record<string, boolean>> }`
  - `interface TruthTable { inputs: string[]; outputs: string[]; leds: string[]; rows: { inputs: number[]; outputs: number[]; leds: boolean[] }[] }`
  - `buildSimModel(design: Design, res: EngineResult): SimModel`, `simulate(model: SimModel, levels: Record<string, 0 | 1>): SimResult`, `truthTable(model: SimModel, maxInputs?: number): TruthTable | null`, `evalGate(kind: GateKind, values: number[]): 0 | 1`, `SEGMENT_DIGITS`

- [ ] **Step 1: Write the failing tests**

`test/sim.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { buildSimModel, evalGate, simulate, truthTable } from '../src/sim/index.ts';
import { readFixture } from './smoke.test.ts';

describe('evalGate', () => {
  test('gate functions', () => {
    expect(evalGate('nand', [1, 1])).toBe(0);
    expect(evalGate('nand', [1, 0])).toBe(1);
    expect(evalGate('nor', [0, 0])).toBe(1);
    expect(evalGate('not', [1])).toBe(0);
    expect(evalGate('xor', [1, 1])).toBe(0);
    expect(evalGate('xor', [1, 0, 1])).toBe(0);
    expect(evalGate('xnor', [1, 0])).toBe(0);
    expect(evalGate('and', [1, 1, 1])).toBe(1);
    expect(evalGate('or', [0, 0, 1])).toBe(1);
  });
});

describe('PL1_1: XOR from a 74LS86 and from NAND gates', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  const model = buildSimModel(d, layout(d, emptySidecar()));

  test('inputs are the switch nets, active low', () => {
    expect(model.inputs.map((i) => i.name)).toEqual(['A', 'B']);
    expect(model.inputs[0]).toMatchObject({ net: '/A', control: 'SW1', activeLow: true });
    expect(model.gates.length).toBeGreaterThanOrEqual(5);
    expect(model.leds.map((l) => l.ref)).toEqual(['D1', 'D2']);
  });

  test('both implementations agree with A xor B and the LEDs follow', () => {
    const t = truthTable(model)!;
    expect(t.inputs).toEqual(['A', 'B']);
    expect(t.outputs).toEqual(['Y1', 'Y2']);
    expect(t.rows).toHaveLength(4);
    for (const row of t.rows) {
      const [a, b] = row.inputs;
      expect(row.outputs).toEqual([a ^ b, a ^ b]);
      expect(row.leds).toEqual([Boolean(a ^ b), Boolean(a ^ b)]);
    }
  });

  test('simulate with explicit levels', () => {
    const r = simulate(model, { '/A': 1, '/B': 0 });
    expect(r.nets['/Y1']).toBe(1);
    expect(r.leds.D1).toBe(true);
    const r2 = simulate(model, { '/A': 1, '/B': 1 });
    expect(r2.nets['/Y2']).toBe(0);
    expect(r2.leds.D2).toBe(false);
  });
});

describe('7447 decoder with a common-anode display', () => {
  const pins: Record<string, [string, string, string]> = {};
  const wire = (n: number, name: string, type: string, net: string) => (pins[String(n)] = [name, type, net]);
  wire(7, 'A', 'input', '/A');
  wire(1, 'B', 'input', '/B');
  wire(2, 'C', 'input', '/C');
  wire(6, 'D', 'input', '/D');
  wire(3, 'LT', 'input', '+5V');
  wire(4, 'BI', 'input', '+5V');
  wire(5, 'RBI', 'input', '+5V');
  for (const [seg, n] of Object.entries({ a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 })) wire(n, seg, 'output', `/s${seg}`);
  wire(16, 'VCC', 'power_in', '+5V');
  wire(8, 'GND', 'power_in', 'GND');
  const d = makeDesign({
    U1: { lib: '74xx', part: '74LS47', value: '74LS47', pins },
    DS1: { lib: 'Display_Character', part: 'SA52', value: 'SA52', pins: { '7': ['A', 'input', '/sa'], '6': ['B', 'input', '/sb'], '4': ['C', 'input', '/sc'], '2': ['D', 'input', '/sd'], '1': ['E', 'input', '/se'], '9': ['F', 'input', '/sf'], '10': ['G', 'input', '/sg'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CA', 'input', '+5V'], '8': ['CA', 'input', '+5V'] } },
    SW1: { lib: 'Switch', part: 'SW_DIP_x04', value: 'SW_DIP_x04', pins: { '1': ['~', 'passive', '/A'], '2': ['~', 'passive', '/B'], '3': ['~', 'passive', '/C'], '4': ['~', 'passive', '/D'], '5': ['~', 'passive', 'GND'], '6': ['~', 'passive', 'GND'], '7': ['~', 'passive', 'GND'], '8': ['~', 'passive', 'GND'] } },
  });
  const model = buildSimModel(d, layout(d, emptySidecar()));

  test('digit 3 lights a b c d g', () => {
    const r = simulate(model, { '/A': 1, '/B': 1, '/C': 0, '/D': 0 });
    expect(r.segments.DS1).toEqual({ a: true, b: true, c: true, d: true, e: false, f: false, g: true });
    expect(r.nets['/sa']).toBe(0);
  });

  test('truth table has 16 rows and the display inputs are DIP positions', () => {
    expect(model.inputs.map((i) => i.control)).toEqual(['SW1 position 1', 'SW1 position 2', 'SW1 position 3', 'SW1 position 4']);
    expect(truthTable(model)!.rows).toHaveLength(16);
  });
});

describe('parts outside the simulator', () => {
  test('op-amps are listed as not simulated and too many inputs disables the table', () => {
    const spec: Parameters<typeof makeDesign>[0] = {
      U1: { lib: 'Amplifier_Operational', part: 'LM741', value: 'LM741', pins: { '2': ['-', 'input', '/INV'], '3': ['+', 'input', 'GND'], '4': ['V-', 'power_in', 'GND'], '6': ['~', 'output', '/OUT'], '7': ['V+', 'power_in', '+5V'], '1': ['NULL', 'input', 'unconnected-(U1-Pad1)'], '5': ['NULL', 'input', 'unconnected-(U1-Pad5)'], '8': ['NC', 'no_connect', 'unconnected-(U1-Pad8)'] } },
    };
    for (let i = 1; i <= 7; i++) spec[`SW${i}`] = { lib: 'Switch', part: 'SW_SPST', value: 'SW', pins: { '1': ['A', 'passive', `/I${i}`], '2': ['B', 'passive', 'GND'] } };
    const d = makeDesign(spec);
    const model = buildSimModel(d, layout(d, emptySidecar()));
    expect(model.notSimulated).toEqual(['U1 (LM741)']);
    expect(model.inputs).toHaveLength(7);
    expect(truthTable(model)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/sim.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/sim/index.ts**

```ts
// Combinational logic simulation over the design nets: 74xx gates, 7447/7448
// decoders, LEDs and 7-segment displays. Inputs are the nets controlled by
// switches. Anything else is placed and checked but reported as not simulated.

import type { EngineResult } from '../layout/engine.ts';
import type { Design } from '../netlist.ts';
import { displayName, isAutoNamed, isUnconnected } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { DECODER_PINS, icInfo, type GateKind } from '../parts/gates.ts';

export interface SimInput {
  name: string;
  net: string;
  control: string;
  activeLow: boolean;
}

export interface SimGate {
  name: string;
  kind: GateKind;
  inputs: string[];
  output: string;
  ref: string;
  pins: { inputs: number[]; output: number };
}

export interface SimDecoder {
  ref: string;
  kind: '7447' | '7448';
  inputs: Record<'A' | 'B' | 'C' | 'D', string>;
  lampTest: string;
  blanking: string;
  outputs: Record<string, string>;
}

export interface SimLed {
  ref: string;
  cathode: string;
  anode: string;
}

export interface SimDisplay {
  ref: string;
  common: 'cathode' | 'anode';
  segments: Record<string, string>;
  commonNets: string[];
}

export interface SimModel {
  inputs: SimInput[];
  gates: SimGate[];
  decoders: SimDecoder[];
  leds: SimLed[];
  displays: SimDisplay[];
  resistors: [string, string][];
  power: Record<string, 0 | 1>;
  notSimulated: string[];
}

export interface SimResult {
  nets: Record<string, 0 | 1>;
  leds: Record<string, boolean>;
  segments: Record<string, Record<string, boolean>>;
}

export interface TruthTable {
  inputs: string[];
  outputs: string[];
  leds: string[];
  rows: { inputs: number[]; outputs: number[]; leds: boolean[] }[];
}

/** Segments lit for digits 0-9 (a b c d e f g). */
export const SEGMENT_DIGITS: Record<number, string> = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

export function evalGate(kind: GateKind, values: number[]): 0 | 1 {
  const all = values.every((v) => v === 1);
  const any = values.some((v) => v === 1);
  const ones = values.filter((v) => v === 1).length;
  switch (kind) {
    case 'and':
      return all ? 1 : 0;
    case 'nand':
      return all ? 0 : 1;
    case 'or':
      return any ? 1 : 0;
    case 'nor':
      return any ? 0 : 1;
    case 'not':
      return values[0] === 1 ? 0 : 1;
    case 'xor':
      return ones % 2 === 1 ? 1 : 0;
    case 'xnor':
      return ones % 2 === 1 ? 0 : 1;
  }
}

export function buildSimModel(design: Design, res: EngineResult): SimModel {
  const model: SimModel = { inputs: [], gates: [], decoders: [], leds: [], displays: [], resistors: [], power: {}, notSimulated: [] };
  for (const n of res.power.plus) model.power[n] = 1;
  for (const n of res.power.gnd) model.power[n] = 0;
  for (const n of res.power.minus) model.power[n] = 0;
  const seenInput = new Set<string>();
  const addInput = (net: string, other: string, control: string) => {
    if (powerKind(net) || isUnconnected(net) || seenInput.has(net)) return;
    seenInput.add(net);
    model.inputs.push({ name: displayName(net), net, control, activeLow: powerKind(other) !== '+' });
  };
  const dipPosition = new Map<string, string>();
  for (const pkg of res.packages) if (pkg.kind === 'dipswitch' && pkg.map) for (const [pos, ref] of Object.entries(pkg.map)) if (pkg.id === 'SW') dipPosition.set(ref, `DIP position ${pos}`);

  const refs = Object.keys(res.footprints).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const ref of refs) {
    const fp = res.footprints[ref];
    const comp = design.components.get(ref);
    if (!comp) continue;
    const net = (pin: string) => comp.pins.get(pin)?.net ?? `unconnected-(${ref}-Pad${pin})`;
    switch (fp.kind) {
      case 'lead2': {
        if (fp.style === 'SW' || fp.style === 'BTN') {
          addInput(net(fp.a), net(fp.b), dipPosition.get(ref) ?? ref);
          addInput(net(fp.b), net(fp.a), dipPosition.get(ref) ?? ref);
        } else if (fp.style === 'LED') model.leds.push({ ref, cathode: net(fp.a), anode: net(fp.b) });
        else if (fp.style === 'R') model.resistors.push([net(fp.a), net(fp.b)]);
        else model.notSimulated.push(`${ref} (${res.values[ref]})`);
        break;
      }
      case 'dipswitch':
        fp.pairs.forEach(([a, b], i) => {
          addInput(net(a), net(b), `${ref} position ${i + 1}`);
          addInput(net(b), net(a), `${ref} position ${i + 1}`);
        });
        break;
      case 'sevenseg': {
        const segments: Record<string, string> = {};
        for (const [seg, pin] of Object.entries(fp.segments)) segments[seg] = net(pin);
        model.displays.push({ ref, common: fp.common, segments, commonNets: fp.commonPins.map(net) });
        break;
      }
      case 'dip': {
        const info = icInfo(res.values[ref] ?? comp.value, fp.pins);
        if (!info?.spec) {
          model.notSimulated.push(`${ref} (${res.values[ref] ?? comp.value})`);
          break;
        }
        if (info.spec.decoder) {
          const p = DECODER_PINS;
          const outputs: Record<string, string> = {};
          for (const [seg, pin] of Object.entries(p.outputs)) outputs[seg] = net(String(pin));
          model.decoders.push({ ref, kind: info.spec.decoder, inputs: { A: net(String(p.inputs.A)), B: net(String(p.inputs.B)), C: net(String(p.inputs.C)), D: net(String(p.inputs.D)) }, lampTest: net(String(p.lampTest)), blanking: net(String(p.blanking)), outputs });
          break;
        }
        info.spec.gates.forEach((g, i) => {
          const out = net(String(g.output));
          if (isUnconnected(out)) return;
          model.gates.push({ name: `${ref}${String.fromCharCode(65 + i)}`, kind: info.spec!.kind!, inputs: g.inputs.map((n) => net(String(n))), output: out, ref, pins: { inputs: g.inputs, output: g.output } });
        });
        break;
      }
      case 'to92':
      case 'pot3':
        model.notSimulated.push(`${ref} (${res.values[ref] ?? comp.value})`);
        break;
      default:
        break;
    }
  }
  model.inputs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return model;
}

export function simulate(model: SimModel, levels: Record<string, 0 | 1>): SimResult {
  const L: Record<string, 0 | 1> = { ...model.power };
  for (const i of model.inputs) L[i.net] = i.activeLow ? 1 : 0;
  Object.assign(L, levels);
  const val = (net: string): 0 | 1 => L[net] ?? 1; // an open TTL input reads high
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const g of model.gates) {
      const out = evalGate(g.kind, g.inputs.map(val));
      if (L[g.output] !== out) {
        L[g.output] = out;
        changed = true;
      }
    }
    for (const dec of model.decoders) {
      const digit = val(dec.inputs.A) + 2 * val(dec.inputs.B) + 4 * val(dec.inputs.C) + 8 * val(dec.inputs.D);
      const lit = val(dec.lampTest) === 0 ? 'abcdefg' : val(dec.blanking) === 0 ? '' : (SEGMENT_DIGITS[digit] ?? '');
      for (const [seg, net] of Object.entries(dec.outputs)) {
        const on = lit.includes(seg);
        const out: 0 | 1 = dec.kind === '7447' ? (on ? 0 : 1) : on ? 1 : 0;
        if (L[net] !== out) {
          L[net] = out;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // A net that is only reached through a resistor takes the level of the far side.
  const term = (net: string): 0 | 1 | null => {
    if (L[net] !== undefined) return L[net];
    for (const [a, b] of model.resistors) {
      if (a === net && L[b] !== undefined) return L[b];
      if (b === net && L[a] !== undefined) return L[a];
    }
    return null;
  };
  const leds: Record<string, boolean> = {};
  for (const led of model.leds) leds[led.ref] = term(led.anode) === 1 && term(led.cathode) === 0;
  const segments: Record<string, Record<string, boolean>> = {};
  for (const disp of model.displays) {
    const commonLevel = disp.commonNets.map(term).find((v) => v !== null) ?? (disp.common === 'cathode' ? 0 : 1);
    const segs: Record<string, boolean> = {};
    for (const [seg, net] of Object.entries(disp.segments)) {
      const lv = term(net);
      segs[seg] = disp.common === 'cathode' ? lv === 1 && commonLevel === 0 : lv === 0 && commonLevel === 1;
    }
    segments[disp.ref] = segs;
  }
  return { nets: L, leds, segments };
}

export function truthTable(model: SimModel, maxInputs = 6): TruthTable | null {
  const inputs = model.inputs;
  if (!inputs.length || inputs.length > maxInputs) return null;
  const outputNets = [...new Set([...model.gates.map((g) => g.output), ...model.decoders.flatMap((d) => Object.values(d.outputs))])]
    .filter((n) => !isAutoNamed(n) && !isUnconnected(n))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
  const leds = model.leds.map((l) => l.ref);
  const rows: TruthTable['rows'] = [];
  for (let code = 0; code < 1 << inputs.length; code++) {
    const levels: Record<string, 0 | 1> = {};
    const bits = inputs.map((inp, i) => {
      const bit = ((code >> (inputs.length - 1 - i)) & 1) as 0 | 1;
      levels[inp.net] = bit;
      return bit;
    });
    const r = simulate(model, levels);
    rows.push({ inputs: bits, outputs: outputNets.map((n) => r.nets[n] ?? 1), leds: leds.map((ref) => r.leds[ref]) });
  }
  return { inputs: inputs.map((i) => i.name), outputs: outputNets.map(displayName), leds, rows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/sim.test.ts`
Expected: all pass. If the PL1_1 XOR test fails, compare `model.gates` against the schematic: U1 is the 74LS86 (Y1 = A xor B), U3 the 74LS00 four-NAND XOR (Y2), U2 the 74LS04 inverters that drive the LED cathodes.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/src/sim circut-ai-tool/test/sim.test.ts
git commit -m "feat(circuit): combinational logic simulator, decoders and truth table"
```

---

### Task 10: Build guide, pinouts and parts list

**Files:**
- Create: `circut-ai-tool/src/guide.ts`
- Test: `circut-ai-tool/test/guide.test.ts`

**Interfaces:**
- Produces:
  - `interface Step { n: number; phase: 'Chips' | 'Power' | 'Inputs' | 'Signals' | 'Outputs' | 'Other'; kind: 'chip' | 'supply' | 'wire' | 'part'; ref?: string; net?: string; wire?: number; label: string }` (`wire` is the index into `res.wires`)
  - `interface Pinout { ref: string; name: string; pins: { num: number; function: string; net: string; hole: string; used: boolean }[] }`
  - `buildSteps(design: Design, res: EngineResult, sim: SimModel): Step[]`, `buildPinouts(design: Design, res: EngineResult): Pinout[]`, `buildPartsList(res: EngineResult): string[]`

- [ ] **Step 1: Write the failing tests**

`test/guide.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildPartsList, buildPinouts, buildSteps } from '../src/guide.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildSimModel } from '../src/sim/index.ts';
import { readFixture } from './smoke.test.ts';

const d = parseNetlist(readFixture('PL1_1.net'));
const res = layout(d, emptySidecar());
const sim = buildSimModel(d, res);

describe('buildSteps', () => {
  const steps = buildSteps(d, res, sim);
  test('numbered, phased, and covering every wire and part once', () => {
    expect(steps.map((s) => s.n)).toEqual(steps.map((_, i) => i + 1));
    expect(steps[0]).toMatchObject({ phase: 'Chips', kind: 'chip', ref: 'U1' });
    expect(steps[0].label).toMatch(/pin 1 in f\d+/);
    const wireSteps = steps.filter((s) => s.kind === 'wire').map((s) => s.wire!).sort((a, b) => a - b);
    expect(wireSteps).toEqual(res.wires.map((_, i) => i));
    const partSteps = steps.filter((s) => s.kind === 'part').map((s) => s.ref!).sort();
    expect(partSteps).toEqual(res.parts.map((p) => p.id).sort());
    expect(steps.find((s) => s.kind === 'supply')!.label).toMatch(/\+5V lead into the top \+ rail, column 1/);
    const phases = [...new Set(steps.map((s) => s.phase))];
    expect(phases).toEqual(['Chips', 'Power', 'Inputs', 'Signals', 'Outputs']);
  });
  test('LED steps name the cathode and its hole', () => {
    const led = steps.find((s) => s.ref === 'D1')!;
    expect(led.label).toMatch(/cathode \(flat edge, short leg\) in [a-j]\d+/);
  });
});

describe('buildPinouts and buildPartsList', () => {
  test('pinouts label supply pins and gates', () => {
    const p = buildPinouts(d, res);
    expect(p.map((x) => x.ref)).toEqual(['U1', 'U2', 'U3']);
    const u3 = p[2];
    expect(u3.pins).toHaveLength(14);
    expect(u3.pins.find((x) => x.num === 14)).toMatchObject({ function: 'VCC', net: '+5V', used: true });
    expect(u3.pins.find((x) => x.num === 3)!.function).toBe('Gate 1 out');
    expect(u3.pins.find((x) => x.num === 1)!.hole).toMatch(/^f\d+$/);
  });
  test('parts list groups by value', () => {
    const list = buildPartsList(res);
    expect(list.some((l) => /1 × 74LS00 quad 2-input NAND \(U3\)/.test(l))).toBe(true);
    expect(list.some((l) => /2 × 1k resistor \(R1, R2\)/.test(l))).toBe(true);
    expect(list[list.length - 1]).toMatch(/jumper wires/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/guide.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/guide.ts**

```ts
// Ordered build steps, chip pinouts and a parts list from a layout.

import { holeName, isRail, stripOf } from './layout/board.ts';
import type { EngineResult } from './layout/engine.ts';
import type { Hole, PlacedPart, Wire } from './layout/types.ts';
import type { Design } from './netlist.ts';
import { displayName, isUnconnected } from './netlist.ts';
import { icInfo } from './parts/gates.ts';
import { compareRefs } from './parts/values.ts';
import type { SimModel } from './sim/index.ts';

export interface Step {
  n: number;
  phase: 'Chips' | 'Power' | 'Inputs' | 'Signals' | 'Outputs' | 'Other';
  kind: 'chip' | 'supply' | 'wire' | 'part';
  ref?: string;
  net?: string;
  wire?: number;
  label: string;
}

export interface Pinout {
  ref: string;
  name: string;
  pins: { num: number; function: string; net: string; hole: string; used: boolean }[];
}

const STYLE_NAMES: Record<string, string> = { R: 'resistor', C: 'capacitor', Cpol: 'electrolytic capacitor', L: 'inductor', D: 'diode', Z: 'Zener diode', LED: 'LED', SW: 'switch', BTN: 'pushbutton', X: 'part', POT: 'potentiometer' };

export function buildSteps(design: Design, res: EngineResult, sim: SimModel): Step[] {
  const stripPins = new Map<string, { ref: string; pin: string }[]>();
  for (const [ref, pins] of Object.entries(res.pinHoles)) for (const [pin, h] of Object.entries(pins)) stripPins.set(stripOf(h), [...(stripPins.get(stripOf(h)) ?? []), { ref, pin }]);
  const isChip = (ref: string) => res.footprints[ref]?.kind === 'dip' || res.footprints[ref]?.kind === 'sevenseg';
  const chipStrips = new Set([...stripPins.entries()].filter(([, ps]) => ps.some((p) => isChip(p.ref))).map(([s]) => s));
  const hint = (h: Hole) => {
    if (isRail(h.row)) return '';
    const ps = (stripPins.get(stripOf(h)) ?? []).filter((p) => isChip(p.ref));
    return ps.length ? ` (${ps[0].ref} pin ${ps[0].pin})` : '';
  };
  const hn = (h: Hole) => holeName(h);
  const steps: Step[] = [];
  const wireStep = (phase: Step['phase'], i: number, text?: string) => {
    const w = res.wires[i];
    steps.push({ n: 0, phase, kind: 'wire', net: w.net, wire: i, label: text ?? `${displayName(w.net)}: ${hn(w.a)}${hint(w.a)} to ${hn(w.b)}${hint(w.b)}.` });
  };
  const partStep = (phase: Step['phase'], p: PlacedPart) => {
    let text: string;
    if (p.style === 'LED') text = `${p.id}: cathode (flat edge, short leg) in ${hn(p.holes[0])}${hint(p.holes[0])}, anode in ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else if (p.kind === 'lead2' && p.polarized) text = `${p.id} (${p.value}): ${p.labels[0]} side in ${hn(p.holes[0])}${hint(p.holes[0])}, ${p.labels[1]} side in ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else if (p.kind === 'lead2') text = `${p.id} (${p.value}): ${hn(p.holes[0])}${hint(p.holes[0])} to ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else text = `${p.id} (${p.value}): ${p.labels.map((l, i) => `${l} in ${hn(p.holes[i])}${hint(p.holes[i])}`).join(', ')}, flat face toward you.`;
    steps.push({ n: 0, phase, kind: 'part', ref: p.id, label: text });
  };

  for (const pkg of res.packages) {
    if (pkg.kind === 'dip' || pkg.kind === 'sevenseg') {
      const half = pkg.pins / 2;
      const what = pkg.kind === 'dip' ? 'across the gutter, notch on the left' : 'across the gutter, decimal points at the bottom';
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `Place ${pkg.id} (${pkg.name}) ${what}, pin 1 in f${pkg.col0}. Pins 1 to ${half} sit in row f, columns ${pkg.col0} to ${pkg.col0 + half - 1}; pins ${half + 1} to ${pkg.pins} in row e, columns ${pkg.col0 + half - 1} down to ${pkg.col0}.` });
    } else {
      const who = Object.entries(pkg.map ?? {}).map(([k, ref]) => {
        const inp = sim.inputs.find((i) => i.control === `DIP position ${k}` || i.control === `${ref} position ${k}`);
        return `position ${k} (column ${pkg.col0 + Number(k) - 1}) is input ${inp ? inp.name : ref}`;
      });
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `Place the ${pkg.name} across the gutter with its pins in e${pkg.col0} to e${pkg.col0 + (pkg.positions ?? 1) - 1} and f${pkg.col0} to f${pkg.col0 + (pkg.positions ?? 1) - 1}; ${who.join('; ')}. A position set to ON joins its top pin to its bottom pin.` });
    }
  }
  if (res.supply) {
    steps.push({ n: 0, phase: 'Power', kind: 'supply', ref: 'PSU', label: `Connect the supply: ${res.supply.leads.map((l) => `${displayName(l.net)} lead into the ${hn(l.hole)}`).join(', ')}. A bench supply or USB is fine; nothing else is powered directly.` });
  }
  res.wires.forEach((w, i) => {
    if (w.role === 'bridge') wireStep('Power', i, `Bridge the ${hn(w.a)} to the ${hn(w.b)}.`);
  });
  res.wires.forEach((w, i) => {
    if (w.role === 'split') wireStep('Power', i, `Rail split: ${hn(w.a)} to ${hn(w.b)}. Most full-size boards break every rail in the middle; skip only if yours run the full length.`);
  });
  const powerWires = res.wires.map((w, i) => [w, i] as [Wire, number]).filter(([w]) => w.role === 'power').sort((x, y) => x[0].a.col - y[0].a.col);
  for (const [w, i] of powerWires) if (chipStrips.has(stripOf(w.a))) wireStep('Power', i);
  const inputNets = new Set(sim.inputs.map((i) => i.net));
  const done = new Set<string>();
  const inputParts = res.parts.filter((p) => p.nets.some((n) => inputNets.has(n)));
  for (const p of inputParts) {
    partStep('Inputs', p);
    done.add(p.id);
  }
  for (const [w, i] of powerWires) if (!chipStrips.has(stripOf(w.a))) wireStep('Inputs', i, `${displayName(w.net)}: ${hn(w.a)} to the ${hn(w.b)}.`);
  const depth = new Map<string, number>();
  for (const n of inputNets) depth.set(n, 0);
  for (let k = 0; k <= sim.gates.length; k++) {
    for (const g of sim.gates) {
      const d = 1 + Math.max(0, ...g.inputs.map((n) => depth.get(n) ?? 0));
      if (depth.get(g.output) !== d) depth.set(g.output, d);
    }
  }
  const signalWires = res.wires.map((w, i) => [w, i] as [Wire, number]).filter(([w]) => w.role === 'signal').sort((x, y) => (depth.get(x[0].net) ?? 99) - (depth.get(y[0].net) ?? 99) || displayName(x[0].net).localeCompare(displayName(y[0].net)) || x[0].a.col - y[0].a.col);
  for (const [, i] of signalWires) wireStep('Signals', i);
  for (const p of res.parts) {
    if (done.has(p.id) || p.style !== 'LED') continue;
    partStep('Outputs', p);
    done.add(p.id);
    for (const qd of res.parts) {
      if (done.has(qd.id) || !p.nets.some((n) => !isUnconnected(n) && qd.nets.includes(n))) continue;
      partStep('Outputs', qd);
      done.add(qd.id);
    }
  }
  for (const p of res.parts) {
    if (done.has(p.id)) continue;
    partStep('Other', p);
    done.add(p.id);
  }
  steps.forEach((s, i) => (s.n = i + 1));
  return steps;
}

export function buildPinouts(design: Design, res: EngineResult): Pinout[] {
  const out: Pinout[] = [];
  for (const pkg of res.packages) {
    if (pkg.kind === 'dipswitch') continue;
    const comp = design.components.get(pkg.id);
    if (!comp) continue;
    const func: Record<string, string> = {};
    const info = pkg.kind === 'dip' ? icInfo(res.values[pkg.id] ?? comp.value, pkg.pins) : null;
    if (info) {
      func[String(info.vcc)] = 'VCC';
      func[String(info.gnd)] = 'GND';
      info.spec?.gates.forEach((g, i) => {
        for (const n of g.inputs) func[String(n)] = `Gate ${i + 1} in`;
        func[String(g.output)] = `Gate ${i + 1} out`;
      });
    }
    const pins = [...comp.pins.values()]
      .filter((p) => /^\d+$/.test(p.num))
      .sort((a, b) => Number(a.num) - Number(b.num))
      .map((p) => {
        const h = res.pinHoles[pkg.id]?.[p.num];
        const used = !isUnconnected(p.net);
        return { num: Number(p.num), function: func[p.num] ?? (p.name && p.name !== '~' ? p.name : 'pin'), net: used ? displayName(p.net) : '', hole: h ? holeName(h) : '', used };
      });
    out.push({ ref: pkg.id, name: pkg.name, pins });
  }
  return out;
}

export function buildPartsList(res: EngineResult): string[] {
  const items: string[] = [];
  for (const pkg of res.packages) {
    if (pkg.kind === 'dip') {
      const info = icInfo(pkg.name, pkg.pins);
      items.push(`1 × ${pkg.name} ${info?.spec?.description ?? `${pkg.pins}-pin DIP`} (${pkg.id})`);
    } else if (pkg.kind === 'sevenseg') items.push(`1 × ${pkg.name} 7-segment display, common ${pkg.common} (${pkg.id})`);
    else items.push(`1 × ${pkg.name}${pkg.map ? ` (positions ${Object.keys(pkg.map).join(', ')} used)` : ''}`);
  }
  const groups = new Map<string, string[]>();
  for (const p of res.parts) {
    const k = `${p.style} ${p.value}`;
    groups.set(k, [...(groups.get(k) ?? []), p.id]);
  }
  for (const [k, refs] of [...groups.entries()].sort()) {
    const [style, value] = k.split(' ');
    const name = STYLE_NAMES[style] ?? (style.length === 3 ? 'transistor' : 'part');
    items.push(`${refs.length} × ${value} ${name} (${refs.sort(compareRefs).join(', ')})`);
  }
  items.push(`About ${res.wires.length} jumper wires, ${res.supply ? res.supply.leads.map((l) => displayName(l.net)).join(' and ') + ' supply' : 'no supply'}, a ${res.board.kind}-size breadboard`);
  return items;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/guide.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/src/guide.ts circut-ai-tool/test/guide.test.ts
git commit -m "feat(circuit): build steps, pinouts and parts list"
```

---

### Task 11: SVG renderer

**Files:**
- Create: `circut-ai-tool/src/render/theme.ts`
- Create: `circut-ai-tool/src/render/index.ts`
- Test: `circut-ai-tool/test/render.test.ts`

**Interfaces:**
- Produces (theme.ts): `interface Theme { name: 'light' | 'dark'; board; boardStroke; gutter; hole; text; textMuted; railPlus; railMinus; chip; chipText; lead; body; bodyStroke; bodyText; ledOff; ledOn; segOff; segOn; notch; dim: number }` (all strings except `dim`), `LIGHT: Theme`, `DARK: Theme`
- Produces (index.ts):
  - `P = 18`, `X0 = 40`, `ROWY: Record<Row, number>`, `pt(h: Hole): [number, number]`
  - `interface SimState { leds: Record<string, boolean>; segments: Record<string, Record<string, boolean>>; switches: Record<string, boolean> }`
  - `interface Highlight { net?: string; ref?: string; wire?: number }`
  - `interface RenderOptions { theme?: Theme; highlight?: Highlight | null; sim?: SimState | null }`
  - `svgSize(board: BoardSpec): { width: number; height: number; viewBox: string }`
  - `renderSvg(res: EngineResult, opts?: RenderOptions): string` (a complete `<svg>` element; consumes only `EngineResult` fields so it works before the pipeline exists)

- [ ] **Step 1: Write the failing tests**

`test/render.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { renderSvg, svgSize } from '../src/render/index.ts';
import { DARK } from '../src/render/theme.ts';
import { readFixture } from './smoke.test.ts';

const d = parseNetlist(readFixture('PL1_1.net'));
const res = layout(d, emptySidecar());

describe('renderSvg', () => {
  const svg = renderSvg(res);
  test('is one svg element with a viewBox and no undefined values', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain(`viewBox="${svgSize(res.board).viewBox}"`);
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
  });
  test('draws every package, part and wire with data attributes', () => {
    for (const p of res.packages) expect(svg).toContain(`data-ref="${p.id}"`);
    for (const p of res.parts) expect(svg).toContain(`data-ref="${p.id}"`);
    expect((svg.match(/class="wire"/g) ?? []).length).toBe(res.wires.length);
    expect(svg).toContain('data-net="/A"');
    expect(svg).toContain(res.nets['/A'].color);
  });
  test('highlight dims everything that is not on the net', () => {
    const h = renderSvg(res, { highlight: { net: '/A' } });
    const dimmed = (h.match(/opacity="0\.18"/g) ?? []).length;
    expect(dimmed).toBeGreaterThan(0);
    expect(dimmed).toBeLessThan(res.wires.length + res.parts.length);
    const w = renderSvg(res, { highlight: { wire: 0 } });
    expect((w.match(/opacity="0\.18"/g) ?? []).length).toBe(res.wires.length - 1 + res.parts.length);
  });
  test('sim state lights LEDs and dark theme changes the board colour', () => {
    const lit = renderSvg(res, { sim: { leds: { D1: true, D2: false }, segments: {}, switches: {} } });
    expect(lit).toContain('data-led="on"');
    expect(lit).toContain('data-led="off"');
    expect(renderSvg(res, { theme: DARK })).toContain(DARK.board);
  });
  test('all footprints render', () => {
    const d2 = makeDesign({
      Q1: { lib: 'Transistor_BJT', part: '2N3904', value: '2N3904', pins: { '1': ['E', 'passive', 'GND'], '2': ['B', 'input', '/IN'], '3': ['C', 'passive', '/OUT'] } },
      RV1: { lib: 'Device', part: 'R_Potentiometer', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/IN'], '3': ['3', 'passive', 'GND'] } },
      C1: { lib: 'Device', part: 'C_Polarized', value: '10uF', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', 'GND'] } },
      C2: { lib: 'Device', part: 'C', value: '100n', pins: { '1': ['~', 'passive', '/OUT'], '2': ['~', 'passive', 'GND'] } },
      L1: { lib: 'Device', part: 'L', value: '1mH', pins: { '1': ['1', 'passive', '/OUT'], '2': ['2', 'passive', '/X'] } },
      D1: { lib: 'Diode', part: '1N4148', value: '1N4148', pins: { '1': ['K', 'passive', '/X'], '2': ['A', 'passive', 'GND'] } },
      SW1: { lib: 'Switch', part: 'SW_DIP_x02', value: 'SW_DIP_x02', pins: { '1': ['~', 'passive', '/IN'], '2': ['~', 'passive', '/X'], '3': ['~', 'passive', 'GND'], '4': ['~', 'passive', 'GND'] } },
      DS1: { lib: 'Display_Character', part: 'D168K', value: 'D168K', pins: { '7': ['A', 'input', '/OUT'], '6': ['B', 'input', '/X'], '4': ['C', 'input', '/IN'], '2': ['D', 'input', '/d'], '1': ['E', 'input', '/e'], '9': ['F', 'input', '/f'], '10': ['G', 'input', '/g'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CC', 'input', 'GND'], '8': ['CC', 'input', 'GND'] } },
    });
    const r2 = layout(d2, emptySidecar());
    const s2 = renderSvg(r2, { sim: { leds: {}, segments: { DS1: { a: true, b: false, c: true, d: false, e: false, f: false, g: false } }, switches: { SW1: true } } });
    for (const ref of ['Q1', 'RV1', 'C1', 'C2', 'L1', 'D1', 'SW1', 'DS1']) expect(s2).toContain(`data-ref="${ref}"`);
    expect(s2).toContain('data-seg="a" data-lit="on"');
    expect(s2).not.toContain('undefined');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/render.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/render/theme.ts**

```ts
// Concrete colours for the renderer. The client picks LIGHT or DARK from the
// page theme; the server always renders LIGHT for PNG output.

export interface Theme {
  name: 'light' | 'dark';
  board: string;
  boardStroke: string;
  gutter: string;
  hole: string;
  text: string;
  textMuted: string;
  railPlus: string;
  railMinus: string;
  chip: string;
  chipText: string;
  lead: string;
  body: string;
  bodyStroke: string;
  bodyText: string;
  ledOff: string;
  ledOn: string;
  segOff: string;
  segOn: string;
  notch: string;
  dim: number;
}

export const LIGHT: Theme = {
  name: 'light',
  board: '#EAE5D6',
  boardStroke: '#C9C2AE',
  gutter: '#DAD4C2',
  hole: '#6E7079',
  text: '#1E2229',
  textMuted: '#5B6270',
  railPlus: '#D7263D',
  railMinus: '#2F6FBF',
  chip: '#2B2D33',
  chipText: '#FFFFFF',
  lead: '#8A8F98',
  body: '#E8D5A3',
  bodyStroke: '#5B4A1F',
  bodyText: '#1E2229',
  ledOff: '#B7BCC6',
  ledOn: '#FF3B30',
  segOff: '#3A3D44',
  segOn: '#FF453A',
  notch: '#EAE5D6',
  dim: 0.18,
};

export const DARK: Theme = {
  ...LIGHT,
  name: 'dark',
  board: '#2A2D34',
  boardStroke: '#3B3F48',
  gutter: '#23262C',
  hole: '#8A8F98',
  text: '#E7E5DF',
  textMuted: '#A3A8B3',
  chip: '#15171B',
  body: '#C9B27A',
  bodyText: '#15171B',
  ledOff: '#4A4F59',
  notch: '#2A2D34',
};
```

- [ ] **Step 4: Write src/render/index.ts**

```ts
// One SVG generator for the browser and the server. Pure string building:
// no DOM, no dependencies. Elements carry data-ref / data-net / data-wire so
// the client can attach hover, drag and click handlers.

import { isRail } from '../layout/board.ts';
import type { EngineResult } from '../layout/engine.ts';
import type { BoardSpec, Hole, Package, PlacedPart, Row, Wire } from '../layout/types.ts';
import { displayName } from '../netlist.ts';
import { LIGHT, type Theme } from './theme.ts';

export const P = 18;
export const X0 = 40;
export const ROWY: Record<Row, number> = { 'T+': 30, 'T-': 48, a: 84, b: 102, c: 120, d: 138, e: 156, f: 192, g: 210, h: 228, i: 246, j: 264, 'B-': 300, 'B+': 318 };
const HEIGHT = 350;

export interface SimState {
  leds: Record<string, boolean>;
  segments: Record<string, Record<string, boolean>>;
  switches: Record<string, boolean>;
}

export interface Highlight {
  net?: string;
  ref?: string;
  wire?: number;
}

export interface RenderOptions {
  theme?: Theme;
  highlight?: Highlight | null;
  sim?: SimState | null;
}

export function pt(h: Hole): [number, number] {
  return [X0 + (h.col - 1) * P, ROWY[h.row]];
}

export function svgSize(board: BoardSpec): { width: number; height: number; viewBox: string } {
  const xr = X0 + (board.cols - 1) * P;
  const width = xr + 140;
  return { width, height: HEIGHT, viewBox: `-100 0 ${width} ${HEIGHT}` };
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function el(tag: string, attrs: Record<string, string | number | undefined>, inner = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${typeof v === 'number' ? n(v) : esc(v as string)}"`)
    .join(' ');
  return inner ? `<${tag} ${a}>${inner}</${tag}>` : `<${tag} ${a}/>`;
}

function text(x: number, y: number, s: string, extra: Record<string, string | number> = {}): string {
  return el('text', { x, y, 'font-family': 'ui-monospace, Consolas, monospace', 'font-size': 9, 'text-anchor': 'middle', ...extra }, esc(s));
}

// ---------- board ----------

function drawBoard(res: EngineResult, t: Theme): string {
  const b = res.board;
  const xr = X0 + (b.cols - 1) * P;
  const out: string[] = [];
  out.push(el('rect', { x: 8, y: 8, width: xr + 16, height: 334, rx: 6, fill: t.board, stroke: t.boardStroke }));
  out.push(el('rect', { x: 26, y: 168, width: xr - 10, height: 12, rx: 2, fill: t.gutter }));
  const gapL = b.splitCol ? pt({ col: b.splitCol, row: 'a' })[0] + 7 : null;
  const gapR = b.splitCol ? pt({ col: b.splitCol + 1, row: 'a' })[0] - 7 : null;
  const railNet: Record<string, string> = { 'T+': res.power.plus.length ? displayName(res.power.plusName) : '+', 'T-': displayName(res.power.gndName), 'B-': displayName(res.power.gndName), 'B+': displayName(res.power.secondName ?? res.power.plusName) };
  for (const [row, color] of [['T+', t.railPlus], ['T-', t.railMinus], ['B-', t.railMinus], ['B+', t.railPlus]] as [Row, string][]) {
    const y = ROWY[row];
    if (gapL !== null && gapR !== null) {
      out.push(el('line', { x1: 34, y1: y, x2: gapL, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
      out.push(el('line', { x1: gapR, y1: y, x2: xr + 10, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
    } else out.push(el('line', { x1: 34, y1: y, x2: xr + 10, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
    out.push(text(xr + 18, y + 3.5, row[1], { 'font-size': 12, fill: color, 'font-weight': 600 }));
    out.push(text(-40, y + 3.5, railNet[row], { 'font-size': 9, fill: color, 'font-weight': 600, 'text-anchor': 'end' }));
    for (let c = 1; c <= b.cols; c++) if (c % b.railGapEvery !== 0) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: y, r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
  }
  if (gapL !== null && gapR !== null) {
    const sx = (gapL + gapR) / 2;
    out.push(el('line', { x1: sx, y1: 22, x2: sx, y2: 56, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    out.push(el('line', { x1: sx, y1: 292, x2: sx, y2: 326, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    out.push(text(sx, 6, 'rail split', { 'font-size': 6.5, fill: t.textMuted }));
  }
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as Row[]) {
    out.push(text(22, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    out.push(text(xr + 18, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    for (let c = 1; c <= b.cols; c++) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: ROWY[row], r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
  }
  for (let c = 1; c <= b.cols; c++) {
    if (c !== 1 && c % 5 !== 0) continue;
    out.push(text(pt({ col: c, row: 'a' })[0], 70, String(c), { 'font-size': 8.5, fill: t.textMuted }));
    out.push(text(pt({ col: c, row: 'a' })[0], 285, String(c), { 'font-size': 8.5, fill: t.textMuted }));
  }
  return out.join('');
}

// ---------- supply ----------

function drawSupply(res: EngineResult, t: Theme, dim: (nets: string[], refs: string[]) => number | undefined): string {
  if (!res.supply) return '';
  return res.supply.leads
    .map((lead, i) => {
      const [x, y] = pt(lead.hole);
      const color = res.nets[lead.net]?.color ?? t.text;
      const x0 = -70;
      const y0 = y + (i - 1) * 4;
      return el('g', { class: 'supply', 'data-net': lead.net, opacity: dim([lead.net], []) }, el('path', { d: `M ${n(x0)} ${n(y0)} C ${n(x0 + 40)} ${n(y0)} ${n(x - 30)} ${n(y)} ${n(x)} ${n(y)}`, fill: 'none', stroke: color, 'stroke-width': 2.6 }) + el('circle', { cx: x, cy: y, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) + text(x0 - 4, y0 + 3, displayName(lead.net), { 'text-anchor': 'end', fill: color, 'font-weight': 600 }));
    })
    .join('');
}

// ---------- packages ----------

const SEG_SHAPES: Record<string, [number, number, number, number]> = { a: [-7, -14, 14, 3], b: [7, -12, 3, 11], c: [7, 1, 3, 11], d: [-7, 11, 14, 3], e: [-10, 1, 3, 11], f: [-10, -12, 3, 11], g: [-7, -1.5, 14, 3] };

function drawPackage(pkg: Package, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined): string {
  const width = pkg.kind === 'dipswitch' ? (pkg.positions ?? 1) : pkg.pins / 2;
  const x1 = pt({ col: pkg.col0, row: 'e' })[0] - P / 2 + 2;
  const x2 = pt({ col: pkg.col0 + width - 1, row: 'e' })[0] + P / 2 - 2;
  const y1 = ROWY.e - 7;
  const y2 = ROWY.f + 7;
  const ym = (y1 + y2) / 2;
  const nets = Object.keys(res.pinHoles[pkg.id] ? Object.fromEntries(Object.entries(res.pinHoles[pkg.id]).map(([pin]) => [pin, 0])) : {}).map((pin) => res.nets[Object.entries(res.nets).find(([net]) => (res as unknown as { design?: unknown }) && net)?.[0] ?? '']?.name ?? '');
  void nets;
  const parts: string[] = [];
  if (pkg.kind === 'dipswitch') {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: '#B4232C', stroke: '#6E1219' }));
    for (let i = 0; i < width; i++) {
      const cx = pt({ col: pkg.col0 + i, row: 'e' })[0];
      const on = !!sim?.switches[pkg.map?.[String(i + 1)] ?? pkg.id] || !!sim?.switches[`${pkg.id}:${i + 1}`];
      parts.push(el('rect', { x: cx - 4, y: y1 + 8, width: 8, height: y2 - y1 - 16, rx: 2, fill: '#F2E9D8', stroke: '#6E1219' }));
      parts.push(el('rect', { x: cx - 3, y: on ? y1 + 9 : ym + 1, width: 6, height: (y2 - y1) / 2 - 10, rx: 1.5, fill: '#3A3D44', class: 'slider', 'data-switch': pkg.map?.[String(i + 1)] ?? `${pkg.id}:${i + 1}`, 'data-on': on ? 'on' : 'off' }));
      parts.push(text(cx, y2 - 2, String(i + 1), { 'font-size': 6, fill: '#F2E9D8' }));
    }
    parts.push(text((x1 + x2) / 2, y1 - 4, pkg.name, { fill: t.text, 'font-size': 8 }));
  } else if (pkg.kind === 'sevenseg') {
    parts.push(el('rect', { x: x1, y: y1 - 6, width: x2 - x1, height: y2 - y1 + 12, rx: 3, fill: '#1B1C20', stroke: '#000' }));
    const cx = (x1 + x2) / 2;
    const state = sim?.segments[pkg.id] ?? {};
    for (const [seg, [dx, dy, w, h]] of Object.entries(SEG_SHAPES)) parts.push(el('rect', { x: cx + dx, y: ym + dy, width: w, height: h, rx: 1, fill: state[seg] ? t.segOn : t.segOff, 'data-seg': seg, 'data-lit': state[seg] ? 'on' : 'off' }));
    parts.push(el('circle', { cx: x2 - 5, cy: y2 + 1, r: 1.5, fill: t.segOff }));
    parts.push(text(cx, y1 - 10, `${pkg.id} ${pkg.name}`, { fill: t.text, 'font-size': 8 }));
  } else {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: t.chip, stroke: '#000' }));
    parts.push(el('circle', { cx: x1, cy: ym, r: 5, fill: t.notch }));
    parts.push(el('circle', { cx: x1 + 8, cy: y2 - 8, r: 1.8, fill: t.chipText }));
    parts.push(text((x1 + x2) / 2, ym + 3, pkg.name, { fill: t.chipText, 'font-size': 9, 'font-weight': 600 }));
    parts.push(text((x1 + x2) / 2, y1 - 4, pkg.id, { fill: t.text, 'font-size': 8 }));
  }
  return el('g', { class: 'pkg', 'data-ref': pkg.id, opacity: dim([], [pkg.id]) }, parts.join(''));
}

// ---------- parts ----------

function body2(part: PlacedPart, t: Theme, sim: SimState | null): string {
  // Drawn horizontally, centred at the origin; the caller rotates it along the leg axis.
  const value = part.value;
  switch (part.style) {
    case 'R':
      return el('rect', { x: -11, y: -4.5, width: 22, height: 9, rx: 2, fill: t.body, stroke: t.bodyStroke }) + el('rect', { x: -6, y: -4.5, width: 2, height: 9, fill: '#B4232C' }) + el('rect', { x: -1, y: -4.5, width: 2, height: 9, fill: '#3A3D44' }) + el('rect', { x: 4, y: -4.5, width: 2, height: 9, fill: '#E3B505' });
    case 'C':
      return el('rect', { x: -3.5, y: -6, width: 2.2, height: 12, fill: '#2F6FBF' }) + el('rect', { x: 1.3, y: -6, width: 2.2, height: 12, fill: '#2F6FBF' });
    case 'Cpol':
      return el('rect', { x: -9, y: -6, width: 18, height: 12, rx: 3, fill: '#2F3E5C', stroke: '#101827' }) + el('rect', { x: 3, y: -6, width: 4, height: 12, fill: '#E7E5DF' }) + text(-4, 2.5, '+', { fill: '#FFFFFF', 'font-size': 8, 'font-weight': 700 });
    case 'L':
      return el('rect', { x: -11, y: -4.5, width: 22, height: 9, rx: 4.5, fill: '#4A6B3A', stroke: '#22361A' }) + el('path', { d: 'M -8 0 a 2.7 2.7 0 0 1 5.4 0 a 2.7 2.7 0 0 1 5.4 0 a 2.7 2.7 0 0 1 5.4 0', fill: 'none', stroke: '#C9D9B8', 'stroke-width': 1.2 });
    case 'D':
    case 'Z':
      return el('rect', { x: -9, y: -4, width: 18, height: 8, rx: 2, fill: '#1B1C20', stroke: '#000' }) + el('rect', { x: -8, y: -4, width: 2.5, height: 8, fill: '#D0D3D8' }) + (part.style === 'Z' ? text(0, 2.5, 'Z', { fill: '#FFFFFF', 'font-size': 6 }) : '');
    case 'LED': {
      const on = !!sim?.leds[part.id];
      return el('circle', { cx: 0, cy: 0, r: 6.5, fill: on ? t.ledOn : t.ledOff, stroke: '#7A1F1F', 'data-led': on ? 'on' : 'off' }) + el('line', { x1: -6.5, y1: -4, x2: -6.5, y2: 4, stroke: '#1E1E1E', 'stroke-width': 1.6 });
    }
    case 'SW': {
      const on = !!sim?.switches[part.id];
      return el('rect', { x: -10, y: -5, width: 20, height: 10, rx: 2, fill: '#3A3D44', stroke: '#000' }) + el('line', { x1: -6, y1: 0, x2: on ? 6 : 4, y2: on ? 0 : -6, stroke: '#E7E5DF', 'stroke-width': 1.8, 'data-switch': part.id, 'data-on': on ? 'on' : 'off' });
    }
    case 'BTN': {
      const on = !!sim?.switches[part.id];
      return el('rect', { x: -7, y: -7, width: 14, height: 14, rx: 2, fill: '#3A3D44', stroke: '#000' }) + el('circle', { cx: 0, cy: 0, r: 3.5, fill: on ? '#E3B505' : '#8A8F98', 'data-switch': part.id, 'data-on': on ? 'on' : 'off' });
    }
    default:
      return el('rect', { x: -10, y: -4.5, width: 20, height: 9, rx: 2, fill: '#8A8F98', stroke: '#3A3D44' }) + text(0, 2.5, value.slice(0, 4), { fill: '#FFFFFF', 'font-size': 6 });
  }
}

function drawPart(part: PlacedPart, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined): string {
  const pts = part.holes.map(pt);
  const inner: string[] = [];
  if (part.kind === 'lead2') {
    const [[ax, ay], [bx, by]] = pts;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    inner.push(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: t.lead, 'stroke-width': 1.8 }));
    inner.push(el('g', { transform: `translate(${n(mx)} ${n(my)}) rotate(${n(deg)})` }, body2(part, t, sim)));
    for (const [x, y] of pts) inner.push(el('circle', { cx: x, cy: y, r: 2.2, fill: t.lead }));
    const perp = Math.abs(deg) < 45 || Math.abs(deg) > 135 ? [0, -10] : [12, 3];
    inner.push(text(mx + perp[0], my + perp[1], part.style === 'LED' ? part.id : `${part.id} ${part.value}`, { fill: t.text, 'font-size': 7.5, 'text-anchor': perp[0] ? 'start' : 'middle' }));
  } else {
    const [[x0, y0], [x1], [x2]] = pts;
    const cx = x1;
    const up = part.holes[0].row <= 'e';
    const dir = up ? -1 : 1;
    for (const [x, y] of pts) inner.push(el('line', { x1: x, y1: y, x2: x, y2: y + dir * 12, stroke: t.lead, 'stroke-width': 1.8 }));
    if (part.kind === 'to92') {
      const yb = y0 + dir * 12;
      inner.push(el('path', { d: `M ${n(x0 - 6)} ${n(yb)} L ${n(x2 + 6)} ${n(yb)} A ${n((x2 - x0) / 2 + 6)} ${n((x2 - x0) / 2 + 6)} 0 0 ${up ? 0 : 1} ${n(x0 - 6)} ${n(yb)} Z`, fill: '#1B1C20', stroke: '#000' }));
      inner.push(text(cx, yb + dir * 14 + 3, part.value, { fill: '#FFFFFF', 'font-size': 7 }));
    } else {
      const yb = up ? y0 - 12 - 24 : y0 + 12;
      inner.push(el('rect', { x: x0 - 8, y: yb, width: x2 - x0 + 16, height: 24, rx: 3, fill: '#2F6FBF', stroke: '#1B3F73' }));
      inner.push(el('circle', { cx, cy: yb + 12, r: 7, fill: '#E7E5DF', stroke: '#1B3F73' }));
      inner.push(el('line', { x1: cx, y1: yb + 12, x2: cx + 5, y2: yb + 7, stroke: '#1B3F73', 'stroke-width': 1.5 }));
      inner.push(text(cx, up ? yb - 4 : yb + 34, `${part.id} ${part.value}`, { fill: t.text, 'font-size': 7.5 }));
    }
    part.labels.forEach((l, i) => inner.push(text(pts[i][0], pts[i][1] + dir * -4 + (up ? 0 : 0) + (up ? 12 : -6), l, { fill: t.textMuted, 'font-size': 6 })));
    for (const [x, y] of pts) inner.push(el('circle', { cx: x, cy: y, r: 2.2, fill: t.lead }));
  }
  return el('g', { class: 'part', 'data-ref': part.id, 'data-net': part.nets.join(' '), opacity: dim(part.nets, [part.id]) }, inner.join(''));
}

// ---------- wires ----------

function drawWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined): string {
  const [ax, ay] = pt(w.a);
  const [bx, by] = pt(w.b);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const bulge = Math.min(0.28 * len, 26) * (w.role === 'power' || w.role === 'bridge' ? 0.6 : 1);
  const cx = (ax + bx) / 2 + (-dy / len) * bulge;
  const cy = (ay + by) / 2 + (dx / len) * bulge;
  const rail = isRail(w.a.row) || isRail(w.b.row);
  return el('g', { class: 'wire', 'data-net': w.net, 'data-wire': i, opacity }, el('path', { d: `M ${n(ax)} ${n(ay)} Q ${n(cx)} ${n(cy)} ${n(bx)} ${n(by)}`, fill: 'none', stroke: color, 'stroke-width': rail ? 2.2 : 2.6, 'stroke-linecap': 'round' }) + el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) + el('circle', { cx: bx, cy: by, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }));
}

// ---------- entry ----------

export function renderSvg(res: EngineResult, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;
  const hl = opts.highlight ?? null;
  const sim = opts.sim ?? null;
  const dim = (nets: string[], refs: string[], wire?: number): number | undefined => {
    if (!hl) return undefined;
    if (hl.net !== undefined) return nets.includes(hl.net) ? undefined : t.dim;
    if (hl.ref !== undefined) return refs.includes(hl.ref) ? undefined : t.dim;
    if (hl.wire !== undefined) return wire === hl.wire ? undefined : t.dim;
    return undefined;
  };
  const dimPart = (nets: string[], refs: string[]) => (hl?.wire !== undefined ? t.dim : dim(nets, refs));
  const size = svgSize(res.board);
  const layers = [
    drawBoard(res, t),
    el('g', { class: 'packages' }, res.packages.map((p) => drawPackage(p, res, t, sim, hl?.wire !== undefined || hl?.net !== undefined ? () => undefined : dim)).join('')),
    el('g', { class: 'parts' }, res.parts.map((p) => drawPart(p, res, t, sim, dimPart)).join('')),
    el('g', { class: 'wires' }, res.wires.map((w, i) => drawWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i))).join('')),
    drawSupply(res, t, hl?.wire !== undefined ? () => undefined : dim),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${size.viewBox}" width="${size.width}" height="${size.height}" font-family="ui-monospace, Consolas, monospace">${layers.join('')}</svg>`;
}
```

Remove the two leftover lines in `drawPackage` that compute `nets` and `void nets` before running the tests; they are placeholders from an earlier draft and do nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/render.test.ts`
Expected: all pass. Open the SVG from Task 12 in a browser to eyeball it; the tests only prove structure.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/render circut-ai-tool/test/render.test.ts
git commit -m "feat(circuit): SVG breadboard renderer with highlight and sim state"
```

---

### Task 12: Pipeline and the command-line script

**Files:**
- Create: `circut-ai-tool/src/pipeline.ts`
- Create: `circut-ai-tool/scripts/breadboard.ts`
- Test: `circut-ai-tool/test/pipeline.test.ts`

**Interfaces:**
- Produces:
  - `interface LayoutDoc extends EngineResult { steps: Step[]; pinouts: Pinout[]; partsList: string[]; checks: Check[]; sim: { model: SimModel; truthTable: TruthTable | null; note: string | null } }`
  - `buildLayoutDoc(design: Design, sidecar: Sidecar): LayoutDoc`
  - `summarize(doc: LayoutDoc): string` (a few lines of plain text for MCP captions)
  - Script: `bun scripts/breadboard.ts <path.kicad_sch> [--net path.net] [--out dir]` writes `<stem>.breadboard.json` and `<stem>.breadboard.svg` next to the schematic (or into `--out`) and prints the summary. Uses `KICAD_CLI` env or the default install path when `--net` is not given.

- [ ] **Step 1: Write the failing test**

`test/pipeline.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, summarize } from '../src/pipeline.ts';
import { readFixture } from './smoke.test.ts';

describe('buildLayoutDoc', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  const doc = buildLayoutDoc(d, emptySidecar());
  test('composes engine, checks, sim and guide', () => {
    expect(doc.error).toBeNull();
    expect(doc.checks.some((c) => c.level === 'error')).toBe(false);
    expect(doc.sim.truthTable!.rows).toHaveLength(4);
    expect(doc.sim.note).toBeNull();
    expect(doc.steps.length).toBeGreaterThan(10);
    expect(doc.pinouts).toHaveLength(3);
    expect(doc.partsList.length).toBeGreaterThan(3);
    expect(JSON.parse(JSON.stringify(doc))).toBeTruthy();
  });
  test('summary mentions the board, parts and checks', () => {
    const s = summarize(doc);
    expect(s).toMatch(/full-size|half-size/);
    expect(s).toMatch(/3 chips/);
    expect(s).toMatch(/0 errors/);
  });
  test('the truth table is withheld when the wiring has errors', () => {
    const broken = { ...emptySidecar() };
    broken.pinned.R1 = { '1': { col: 1, row: 'a' }, '2': { col: 2, row: 'a' } };
    const doc2 = buildLayoutDoc(d, broken);
    if (doc2.checks.some((c) => c.level === 'error')) {
      expect(doc2.sim.truthTable).toBeNull();
      expect(doc2.sim.note).toMatch(/errors/);
    } else expect(doc2.sim.truthTable).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd circut-ai-tool && bun test test/pipeline.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/pipeline.ts**

```ts
// design + sidecar -> LayoutDoc. Pure; the server and the client call this.

import { hasErrors, runChecks, type Check } from './checks/index.ts';
import { buildPartsList, buildPinouts, buildSteps, type Pinout, type Step } from './guide.ts';
import { layout, type EngineResult } from './layout/engine.ts';
import type { Sidecar } from './layout/types.ts';
import type { Design } from './netlist.ts';
import { buildSimModel, truthTable, type SimModel, type TruthTable } from './sim/index.ts';

export interface LayoutDoc extends EngineResult {
  steps: Step[];
  pinouts: Pinout[];
  partsList: string[];
  checks: Check[];
  sim: { model: SimModel; truthTable: TruthTable | null; note: string | null };
}

export function buildLayoutDoc(design: Design, sidecar: Sidecar): LayoutDoc {
  const res = layout(design, sidecar);
  const checks = runChecks(design, res);
  const model = buildSimModel(design, res);
  let table: TruthTable | null = null;
  let note: string | null = null;
  if (hasErrors(checks)) note = 'the wiring has errors, so the simulation is withheld until they are fixed';
  else if (!model.inputs.length) note = 'no switch-controlled inputs; nothing to tabulate';
  else if (model.inputs.length > 6) note = `${model.inputs.length} inputs is too many for a truth table (limit 6); use simulate with explicit levels`;
  else table = truthTable(model);
  if (!note && model.notSimulated.length) note = `not simulated: ${model.notSimulated.join(', ')}`;
  return { ...res, steps: buildSteps(design, res, model), pinouts: buildPinouts(design, res), partsList: buildPartsList(res), checks, sim: { model, truthTable: table, note } };
}

export function summarize(doc: LayoutDoc): string {
  const errors = doc.checks.filter((c) => c.level === 'error').length;
  const warnings = doc.checks.filter((c) => c.level === 'warning').length;
  const chips = doc.packages.filter((p) => p.kind === 'dip').length;
  const lines = [
    `${doc.board.kind}-size breadboard (${doc.board.cols} columns${doc.board.splitCol ? ', split rails' : ''}); ${chips} chips, ${doc.packages.length - chips} other packages, ${doc.parts.length} two- and three-lead parts, ${doc.wires.length} jumper wires.`,
    `Checks: ${errors} errors, ${warnings} warnings.` + (errors ? ' ' + doc.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' ') : ''),
  ];
  if (doc.unplaced.length) lines.push(`Not placed: ${doc.unplaced.map((u) => `${u.ref} (${u.reason})`).join('; ')}.`);
  if (doc.sim.truthTable) lines.push(`Truth table: inputs ${doc.sim.truthTable.inputs.join(', ')}; outputs ${doc.sim.truthTable.outputs.join(', ')}.`);
  if (doc.sim.note) lines.push(`Simulation: ${doc.sim.note}.`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Write scripts/breadboard.ts**

```ts
// bun scripts/breadboard.ts <file.kicad_sch> [--net file.net] [--out dir]
// Exports the netlist with kicad-cli (unless --net is given), builds the
// layout and writes <stem>.breadboard.json and <stem>.breadboard.svg.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, summarize } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';

const args = process.argv.slice(2);
const sch = args.find((a) => !a.startsWith('--'));
if (!sch) {
  console.error('usage: bun scripts/breadboard.ts <file.kicad_sch> [--net file.net] [--out dir]');
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const schPath = path.resolve(sch);
const stem = path.basename(schPath, '.kicad_sch');
const outDir = opt('--out') ? path.resolve(opt('--out')!) : path.dirname(schPath);
mkdirSync(outDir, { recursive: true });

let netText: string;
const netArg = opt('--net');
if (netArg) netText = readFileSync(netArg, 'utf8');
else {
  const cli = process.env.KICAD_CLI ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'KiCad', '9.0', 'bin', 'kicad-cli.exe');
  const tmp = path.join(tmpdir(), `${stem}-${Date.now()}.net`);
  execFileSync(cli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', tmp, schPath], { stdio: 'pipe' });
  netText = readFileSync(tmp, 'utf8');
}
const sidecarPath = path.join(path.dirname(schPath), `${stem}.breadboard.json`);
const sidecar = existsSync(sidecarPath) ? normalizeSidecar(JSON.parse(readFileSync(sidecarPath, 'utf8'))) : normalizeSidecar({});
const doc = buildLayoutDoc(parseNetlist(netText), sidecar);
writeFileSync(path.join(outDir, `${stem}.breadboard.layout.json`), JSON.stringify(doc, null, 1));
writeFileSync(path.join(outDir, `${stem}.breadboard.svg`), renderSvg(doc));
console.log(summarize(doc));
console.log(`wrote ${path.join(outDir, `${stem}.breadboard.svg`)}`);
```

- [ ] **Step 5: Run the test, then the script on the real project**

Run: `cd circut-ai-tool && bun test test/pipeline.test.ts && bun scripts/breadboard.ts test/fixtures/PL1_1.kicad_sch --net test/fixtures/PL1_1.net --out ../.tmp-breadboard`
Expected: tests pass; the script prints the summary with `0 errors` and writes `.tmp-breadboard/PL1_1.breadboard.svg`. Open that SVG in a browser and confirm three chips across the gutter, resistors, LEDs and switches on the top and bottom strips, coloured jumpers, and red/black supply leads. Then run without `--net` against `%USERPROFILE%\Documents\KiCad\9.0\projects\PL1_1\PL1_1.kicad_sch` to prove the kicad-cli path works. Delete `.tmp-breadboard` afterwards (it is a folder the script created, not a project folder).

- [ ] **Step 6: Run everything and commit**

Run: `cd circut-ai-tool && bun test && bun run typecheck`
Expected: all green.

```bash
git add circut-ai-tool/src/pipeline.ts circut-ai-tool/scripts/breadboard.ts circut-ai-tool/test/pipeline.test.ts
git commit -m "feat(circuit): layout pipeline and breadboard CLI"
```

---

## Self-review (part 1c)

- Spec coverage: checks (hole conflicts, connectivity with split rails, supply reach through `PSU:` nodes, shorts, LED polarity, driver conflicts, floating inputs on used gates, fan-out, LED current, supply current, unplaced and warnings), simulator (gates 00 02 04 08 10 11 20 21 27 30 32 86, 7447/7448 with lamp test and blanking, LEDs through resistors, 7-segment common cathode/anode, truth table up to six inputs, not-simulated list), guide (phases, hole names with chip-pin hints, LED cathode wording, DIP switch positions, pinouts with VCC/GND/gate functions, parts list), renderer (board, rails with net labels, split marks, packages by kind, every lead2 style, TO-92, pot, wires with end dots, highlight by net/ref/wire, sim state on LEDs, switches and segments, light and dark themes), pipeline and CLI.
- Placeholder scan: the `drawPackage` draft contained two dead lines (`const nets = ...; void nets;`); Step 4 of Task 11 instructs to delete them. No other TODO/TBD.
- Type consistency: `Step.wire` is the index into `res.wires` used by `Highlight.wire`; `SimState.switches` is keyed by switch ref (or `${ref}:${position}` for real DIP switches), matching what the client will send in part 3; `LayoutDoc extends EngineResult` so the renderer, which takes `EngineResult`, accepts a `LayoutDoc`.
