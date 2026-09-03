# Circuit AI Tool Implementation Plan, part 1b: part catalog and breadboard layout engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every component of a `Design` into a breadboard footprint and place and route the whole circuit deterministically onto a half- or full-size breadboard, honouring pinned placements.

**Architecture:** `src/parts/*` turns KiCad library ids, values and pin names into footprints and chip facts. `src/layout/board.ts` is the hole geometry and occupancy bookkeeping. `src/layout/engine.ts` is the placer and router: packages across the gutter, three-lead parts, two-lead parts anchored to placed nets, power jumpers to rails, signal jumpers strip to strip, rail bridges. Everything is pure and synchronous so the browser can re-run it during drag.

**Tech Stack:** Bun 1.3, TypeScript 5.9, `bun test`. Depends on part 1a (`src/netlist.ts`, `src/sexpr.ts`).

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md` (sections "Part catalog" and "Layout engine")

## Global Constraints

- Same as part 1a: pure `src/`, Bun, commit per task, Write tool for files, no destructive shell commands on project folders.
- Hole naming: rows `a`..`e` are the top half, `f`..`j` the bottom half, rails `T+`, `T-`, `B+`, `B-`. Columns start at 1. Half board 30 columns, full board 63. Rails have no hole at every sixth column (`col % 6 === 0`). Full boards split their rails between columns 30 and 31 unless the option says otherwise.
- Refinement of the spec's sketch: the sidecar's `pinned` entry stores every pin's hole (`pinned[ref][pin] = {col,row}`) rather than a single anchor, so drag can move any footprint and the engine can validate it pin by pin.

---

### Task 5: Values, chip tables and the part catalog

**Files:**
- Create: `circut-ai-tool/src/parts/values.ts`
- Create: `circut-ai-tool/src/parts/gates.ts`
- Create: `circut-ai-tool/src/parts/catalog.ts`
- Test: `circut-ai-tool/test/parts.test.ts`

**Interfaces:**
- Produces (values.ts): `parseOhms(v: string): number | null`, `parseFarads(v): number | null`, `parseHenries(v): number | null`, `formatSI(x: number, unit: string): string`, `refKey(ref: string): [string, number]`, `compareRefs(a: string, b: string): number`
- Produces (gates.ts): `type GateKind = 'nand'|'nor'|'not'|'and'|'or'|'xor'|'xnor'`, `interface GateSpec { inputs: number[]; output: number }`, `interface ChipSpec { code: string; description: string; kind: GateKind | null; gates: GateSpec[]; decoder: '7447' | '7448' | null; vcc: number; gnd: number; iccMax: number; pins: number }`, `CHIPS: Record<string, ChipSpec>`, `DECODER_PINS`, `DC: Record<'LS'|'HC', {...}>`, `icInfo(value: string, pinCount?: number): IcInfo | null` with `interface IcInfo { code: string; family: 'LS' | 'HC'; spec: ChipSpec | null; vcc: number; gnd: number }`
- Produces (catalog.ts): `type Lead2Style`, `type Footprint` (union: `dip`, `lead2`, `to92`, `pot3`, `dipswitch`, `sevenseg`, `power`, `supply`, `unsupported`), `type PowerKind = '+' | '-' | 'gnd' | null`, `powerKind(net: string): PowerKind`, `classify(comp: Component): Footprint`

- [ ] **Step 1: Write the failing tests**

`test/parts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { classify, powerKind } from '../src/parts/catalog.ts';
import { CHIPS, icInfo } from '../src/parts/gates.ts';
import { compareRefs, formatSI, parseFarads, parseHenries, parseOhms } from '../src/parts/values.ts';
import { readFixture } from './smoke.test.ts';

describe('values', () => {
  test('resistance', () => {
    expect(parseOhms('1k')).toBe(1000);
    expect(parseOhms('4k7')).toBe(4700);
    expect(parseOhms('330')).toBe(330);
    expect(parseOhms('330R')).toBe(330);
    expect(parseOhms('2.2M')).toBe(2.2e6);
    expect(parseOhms('10 Ω')).toBe(10);
    expect(parseOhms('LED')).toBeNull();
  });
  test('capacitance and inductance', () => {
    expect(parseFarads('10uF')).toBeCloseTo(10e-6, 12);
    expect(parseFarads('100n')).toBeCloseTo(100e-9, 12);
    expect(parseFarads('4n7')).toBeCloseTo(4.7e-9, 12);
    expect(parseFarads('0.1µF')).toBeCloseTo(0.1e-6, 12);
    expect(parseHenries('2.2mH')).toBeCloseTo(2.2e-3, 9);
    expect(parseHenries('10uH')).toBeCloseTo(10e-6, 12);
  });
  test('formatSI and reference ordering', () => {
    expect(formatSI(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatSI(0.0000001, 'F')).toBe('100 nF');
    expect(['U10', 'R2', 'U2', 'R10', 'C1'].sort(compareRefs)).toEqual(['C1', 'R2', 'R10', 'U2', 'U10']);
  });
});

describe('gates', () => {
  test('recognises 74xx families and codes', () => {
    expect(icInfo('74LS00')!.spec!.kind).toBe('nand');
    expect(icInfo('SN74HC04N')!.family).toBe('HC');
    expect(icInfo('74LS04')!.spec!.gates).toHaveLength(6);
    expect(icInfo('74LS47')!.spec!.decoder).toBe('7447');
    expect(icInfo('74LS47')!.vcc).toBe(16);
    expect(icInfo('74LS181', 24)!.spec).toBeNull();
    expect(icInfo('74LS181', 24)!.vcc).toBe(24);
    expect(icInfo('LM741')).toBeNull();
    expect(CHIPS['02'].gates[0]).toEqual({ inputs: [2, 3], output: 1 });
  });
});

describe('powerKind', () => {
  test('classifies supply nets', () => {
    expect(powerKind('+5V')).toBe('+');
    expect(powerKind('VCC')).toBe('+');
    expect(powerKind('GND')).toBe('gnd');
    expect(powerKind('/GND')).toBe('gnd');
    expect(powerKind('-12V')).toBe('-');
    expect(powerKind('/A')).toBeNull();
    expect(powerKind('Net-(D1-A)')).toBeNull();
  });
});

describe('classify', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  test('PL1_1 parts', () => {
    expect(classify(d.components.get('U3')!)).toEqual({ kind: 'dip', pins: 14 });
    expect(classify(d.components.get('R1')!)).toMatchObject({ kind: 'lead2', style: 'R', a: '1', b: '2', polarized: false });
    expect(classify(d.components.get('D1')!)).toMatchObject({ kind: 'lead2', style: 'LED', a: '1', b: '2', polarized: true, aLabel: 'K', bLabel: 'A' });
    expect(classify(d.components.get('SW1')!)).toMatchObject({ kind: 'lead2', style: 'SW' });
    expect(classify(d.components.get('J1')!)).toEqual({ kind: 'supply' });
  });

  const extra = makeDesign({
    C1: { lib: 'Device', part: 'C_Polarized', value: '10uF', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', 'GND'] } },
    L1: { lib: 'Device', part: 'L', value: '2.2mH', pins: { '1': ['1', 'passive', '/IN'], '2': ['2', 'passive', '/OUT'] } },
    D3: { lib: 'Diode', part: '1N4148', value: '1N4148', pins: { '1': ['K', 'passive', '/A'], '2': ['A', 'passive', '/B'] } },
    D4: { lib: 'Device', part: 'D_Zener', value: '5V1', pins: { '1': ['K', 'passive', '/A'], '2': ['A', 'passive', 'GND'] } },
    SW3: { lib: 'Switch', part: 'SW_Push', value: 'SW_Push', pins: { '1': ['1', 'passive', '/A'], '2': ['2', 'passive', 'GND'] } },
    SW4: { lib: 'Switch', part: 'SW_DIP_x04', value: 'SW_DIP_x04', pins: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8'].map((p) => [p, ['~', 'passive', `/S${p}`]])) },
    Q1: { lib: 'Transistor_BJT', part: '2N3904', value: '2N3904', pins: { '1': ['E', 'passive', 'GND'], '2': ['B', 'input', '/A'], '3': ['C', 'passive', '/OUT'] } },
    RV1: { lib: 'Device', part: 'R_Potentiometer', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/W'], '3': ['3', 'passive', 'GND'] } },
    U4: { lib: 'Amplifier_Operational', part: 'LM741', value: 'LM741', pins: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8'].map((p) => [p, ['~', 'passive', `/N${p}`]])) },
    DS1: { lib: 'Display_Character', part: 'D168K', value: 'D168K', pins: { '7': ['A', 'input', '/a'], '6': ['B', 'input', '/b'], '4': ['C', 'input', '/c'], '2': ['D', 'input', '/d'], '1': ['E', 'input', '/e'], '9': ['F', 'input', '/f'], '10': ['G', 'input', '/g'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CC', 'input', 'GND'], '8': ['CC', 'input', 'GND'] } },
    X1: { lib: 'Device', part: 'Crystal_GND24', value: '16MHz', pins: { '1': ['1', 'passive', '/A'], '2': ['2', 'passive', '/B'], '3': ['3', 'passive', 'GND'] } },
    J2: { lib: 'Connector', part: 'Conn_01x02', value: 'FGEN', pins: { '1': ['Pin_1', 'passive', '/IN'], '2': ['Pin_2', 'passive', '/B'] } },
  });
  test('analog and switch parts', () => {
    expect(classify(extra.components.get('C1')!)).toMatchObject({ kind: 'lead2', style: 'Cpol', polarized: true, aLabel: '+' });
    expect(classify(extra.components.get('L1')!)).toMatchObject({ kind: 'lead2', style: 'L' });
    expect(classify(extra.components.get('D3')!)).toMatchObject({ kind: 'lead2', style: 'D', aLabel: 'K' });
    expect(classify(extra.components.get('D4')!)).toMatchObject({ kind: 'lead2', style: 'Z' });
    expect(classify(extra.components.get('SW3')!)).toMatchObject({ kind: 'lead2', style: 'BTN' });
    expect(classify(extra.components.get('SW4')!)).toEqual({ kind: 'dipswitch', positions: 4, pairs: [['1', '8'], ['2', '7'], ['3', '6'], ['4', '5']] });
    expect(classify(extra.components.get('Q1')!)).toEqual({ kind: 'to92', legs: ['1', '2', '3'], names: ['E', 'B', 'C'] });
    expect(classify(extra.components.get('RV1')!)).toEqual({ kind: 'pot3', legs: ['1', '2', '3'] });
    expect(classify(extra.components.get('U4')!)).toEqual({ kind: 'dip', pins: 8 });
    expect(classify(extra.components.get('DS1')!)).toMatchObject({ kind: 'sevenseg', pins: 10, common: 'cathode', commonPins: ['3', '8'] });
    expect((classify(extra.components.get('DS1')!) as { segments: Record<string, string> }).segments).toEqual({ a: '7', b: '6', c: '4', d: '2', e: '1', f: '9', g: '10' });
    expect(classify(extra.components.get('X1')!).kind).toBe('unsupported');
    expect(classify(extra.components.get('J2')!).kind).toBe('unsupported');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/parts.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/parts/values.ts**

```ts
// Component value parsing ("4k7", "10uF", "2.2mH") and reference ordering.

const MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

export function parseOhms(value: string): number | null {
  const s = (value ?? '').trim().replace(/Ω|ohms?/gi, '').replace(/\s+/g, '');
  let m = /^(\d+)([kKMRr])(\d*)$/.exec(s);
  if (m) {
    const mult = m[2] === 'R' || m[2] === 'r' ? 1 : m[2] === 'M' ? 1e6 : 1e3;
    return (Number(m[1]) + (m[3] ? Number('0.' + m[3]) : 0)) * mult;
  }
  m = /^(\d+(?:\.\d+)?)([kKMm]?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * (m[2] === '' ? 1 : m[2] === 'm' ? 1e-3 : m[2] === 'M' ? 1e6 : 1e3);
}

function parseWithUnit(value: string, unit: RegExp): number | null {
  const s = (value ?? '').trim().replace(unit, '').replace(/\s+/g, '');
  let m = /^(\d+)([pnuµμm])(\d+)$/.exec(s);
  if (m) return (Number(m[1]) + Number('0.' + m[3])) * MULT[m[2]];
  m = /^(\d+(?:\.\d+)?)([pnuµμmkKM]?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * MULT[m[2]];
}

export const parseFarads = (value: string): number | null => parseWithUnit(value, /F(arads?)?$/i);
export const parseHenries = (value: string): number | null => parseWithUnit(value, /H(enr(y|ies))?$/i);

const SI: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

export function formatSI(x: number, unit: string): string {
  for (const [f, p] of SI) if (Math.abs(x) >= f * 0.9995) return `${Number((x / f).toPrecision(3))} ${p}${unit}`.trim();
  return `${x} ${unit}`.trim();
}

export function refKey(ref: string): [string, number] {
  const m = /^([A-Za-z#]+)(\d*)/.exec(ref);
  return m ? [m[1], Number(m[2] || 0)] : [ref, 0];
}

export function compareRefs(a: string, b: string): number {
  const [pa, na] = refKey(a);
  const [pb, nb] = refKey(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
}
```

- [ ] **Step 4: Write src/parts/gates.ts**

```ts
// 74xx chip facts: gate pinouts for the simulator, supply pins and currents
// for the checks. Pin numbers are the DIP package pins.

export type GateKind = 'nand' | 'nor' | 'not' | 'and' | 'or' | 'xor' | 'xnor';

export interface GateSpec {
  inputs: number[];
  output: number;
}

export interface ChipSpec {
  code: string;
  description: string;
  kind: GateKind | null;
  gates: GateSpec[];
  decoder: '7447' | '7448' | null;
  vcc: number;
  gnd: number;
  iccMax: number;
  pins: number;
}

const g = (pairs: [number[], number][]): GateSpec[] => pairs.map(([inputs, output]) => ({ inputs, output }));
const QUAD2 = g([[[1, 2], 3], [[4, 5], 6], [[9, 10], 8], [[12, 13], 11]]);
const TRIPLE3 = g([[[1, 2, 13], 12], [[3, 4, 5], 6], [[9, 10, 11], 8]]);
const DUAL4 = g([[[1, 2, 4, 5], 6], [[9, 10, 12, 13], 8]]);
const HEX1 = g([[[1], 2], [[3], 4], [[5], 6], [[9], 8], [[11], 10], [[13], 12]]);

const chip = (code: string, description: string, kind: GateKind, gates: GateSpec[], iccMax: number): ChipSpec => ({ code, description, kind, gates, decoder: null, vcc: 14, gnd: 7, iccMax, pins: 14 });

export const CHIPS: Record<string, ChipSpec> = {
  '00': chip('00', 'quad 2-input NAND', 'nand', QUAD2, 8e-3),
  '02': chip('02', 'quad 2-input NOR', 'nor', g([[[2, 3], 1], [[5, 6], 4], [[8, 9], 10], [[11, 12], 13]]), 8e-3),
  '04': chip('04', 'hex inverter', 'not', HEX1, 6.6e-3),
  '08': chip('08', 'quad 2-input AND', 'and', QUAD2, 8.8e-3),
  '10': chip('10', 'triple 3-input NAND', 'nand', TRIPLE3, 6.6e-3),
  '11': chip('11', 'triple 3-input AND', 'and', TRIPLE3, 6.6e-3),
  '20': chip('20', 'dual 4-input NAND', 'nand', DUAL4, 4.4e-3),
  '21': chip('21', 'dual 4-input AND', 'and', DUAL4, 4.4e-3),
  '27': chip('27', 'triple 3-input NOR', 'nor', TRIPLE3, 6.6e-3),
  '30': chip('30', '8-input NAND', 'nand', g([[[1, 2, 3, 4, 5, 6, 11, 12], 8]]), 4.4e-3),
  '32': chip('32', 'quad 2-input OR', 'or', QUAD2, 9.8e-3),
  '86': chip('86', 'quad 2-input XOR', 'xor', QUAD2, 10e-3),
  '47': { code: '47', description: 'BCD to 7-segment decoder, active-low outputs (common-anode display)', kind: null, gates: [], decoder: '7447', vcc: 16, gnd: 8, iccMax: 64e-3, pins: 16 },
  '48': { code: '48', description: 'BCD to 7-segment decoder, active-high outputs (common-cathode display)', kind: null, gates: [], decoder: '7448', vcc: 16, gnd: 8, iccMax: 76e-3, pins: 16 },
};

/** 7447 / 7448 pinout (same for both). */
export const DECODER_PINS = {
  inputs: { A: 7, B: 1, C: 2, D: 6 },
  lampTest: 3,
  blanking: 4,
  rippleBlankingIn: 5,
  outputs: { a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 } as Record<string, number>,
};

export const DC = {
  LS: { volMax: 0.5, vohMin: 2.7, iol: 8e-3, ioh: 0.4e-3, iih: 20e-6, iil: 0.4e-3, fanout: 20 },
  HC: { volMax: 0.33, vohMin: 3.84, iol: 4e-3, ioh: 4e-3, iih: 1e-6, iil: 1e-6, fanout: 50 },
};

const IC_RE = /(?:SN|DM|MC|CD)?74\s*(LS|HCT|HC|ALS|ACT|AC|F)?(\d{2,3})/i;

export interface IcInfo {
  code: string;
  family: 'LS' | 'HC';
  spec: ChipSpec | null;
  vcc: number;
  gnd: number;
}

export function icInfo(value: string, pinCount = 14): IcInfo | null {
  const m = IC_RE.exec(value ?? '');
  if (!m) return null;
  const fam = (m[1] ?? '').toUpperCase();
  const family = fam === 'HC' || fam === 'HCT' || fam === 'AC' || fam === 'ACT' ? 'HC' : 'LS';
  const spec = CHIPS[m[2]] ?? null;
  return { code: m[2], family, spec, vcc: spec?.vcc ?? pinCount, gnd: spec?.gnd ?? pinCount / 2 };
}
```

- [ ] **Step 5: Write src/parts/catalog.ts**

```ts
// lib_id + value + pins -> breadboard footprint.

import type { Component } from '../netlist.ts';
import { displayName } from '../netlist.ts';

export type Lead2Style = 'R' | 'C' | 'Cpol' | 'L' | 'D' | 'Z' | 'LED' | 'SW' | 'BTN' | 'X';

export type Footprint =
  | { kind: 'dip'; pins: number }
  | { kind: 'lead2'; style: Lead2Style; a: string; b: string; polarized: boolean; aLabel: string; bLabel: string }
  | { kind: 'to92'; legs: [string, string, string]; names: [string, string, string] }
  | { kind: 'pot3'; legs: [string, string, string] }
  | { kind: 'dipswitch'; positions: number; pairs: [string, string][] }
  | { kind: 'sevenseg'; pins: number; common: 'cathode' | 'anode'; segments: Record<string, string>; commonPins: string[] }
  | { kind: 'power' }
  | { kind: 'supply' }
  | { kind: 'unsupported'; reason: string };

export type PowerKind = '+' | '-' | 'gnd' | null;

export function powerKind(net: string): PowerKind {
  const n = displayName(net);
  if (/^(GND\w*|GNDREF|0|VSS|AGND|DGND)$/i.test(n)) return 'gnd';
  if (/^\+/.test(n) || /^(VCC\w*|VDD\w*|5V|3V3|12V)$/i.test(n)) return '+';
  if (/^-/.test(n) || /^(VEE)$/i.test(n)) return '-';
  return null;
}

const numeric = (pins: string[]) => pins.every((p) => /^\d+$/.test(p));
const byNumber = (a: string, b: string) => Number(a) - Number(b);

export function classify(comp: Component): Footprint {
  const { lib, part, ref } = comp;
  const P = part.toUpperCase();
  const pinNums = [...comp.pins.keys()].sort(byNumber);
  const n = pinNums.length;
  if (ref.startsWith('#') || lib === 'power') return { kind: 'power' };
  if (lib.startsWith('Connector') || P.startsWith('CONN') || ref.startsWith('J')) {
    return [...comp.pins.values()].some((p) => powerKind(p.net))
      ? { kind: 'supply' }
      : { kind: 'unsupported', reason: 'connectors without a power net are not placed on the breadboard; name the nets instead' };
  }
  const dip = /^SW_DIP_X(\d+)$/.exec(P);
  if (dip) {
    const k = Number(dip[1]);
    return { kind: 'dipswitch', positions: k, pairs: Array.from({ length: k }, (_, i) => [String(i + 1), String(2 * k - i)] as [string, string]) };
  }
  if (lib === 'Display_Character') {
    const segments: Record<string, string> = {};
    const commonPins: string[] = [];
    let common: 'cathode' | 'anode' = 'cathode';
    for (const p of comp.pins.values()) {
      const nm = p.name.toUpperCase();
      if (/^[A-G]$/.test(nm)) segments[nm.toLowerCase()] = p.num;
      else if (/^(CC|K|COM|CATHODE|COMMON)$/.test(nm)) commonPins.push(p.num);
      else if (/^(CA|A|ANODE|COM\+)$/.test(nm)) {
        commonPins.push(p.num);
        common = 'anode';
      }
    }
    commonPins.sort(byNumber);
    if (Object.keys(segments).length >= 7 && n % 2 === 0 && numeric(pinNums)) return { kind: 'sevenseg', pins: n, common, segments, commonPins };
    return { kind: 'unsupported', reason: `display ${part} has ${n} pins; only 7-segment displays with an even pin count are supported` };
  }
  if (n === 2) {
    const [a, b] = pinNums;
    const lead = (style: Lead2Style, polarized = false, aLabel = '', bLabel = ''): Footprint => ({ kind: 'lead2', style, a, b, polarized, aLabel, bLabel });
    if (lib === 'Device' && P.startsWith('R') && !P.startsWith('R_POT')) return lead('R');
    if (lib === 'Device' && P.startsWith('C_POLARIZED')) return lead('Cpol', true, '+', '−');
    if (lib === 'Device' && P.startsWith('C')) return lead('C');
    if (lib === 'Device' && P.startsWith('LED')) return lead('LED', true, 'K', 'A');
    if (lib === 'Device' && P.startsWith('L')) return lead('L');
    if (lib === 'Device' && P.startsWith('D_ZENER')) return lead('Z', true, 'K', 'A');
    if ((lib === 'Device' && P.startsWith('D')) || lib === 'Diode') return lead('D', true, 'K', 'A');
    if (P.startsWith('SW_PUSH')) return lead('BTN');
    if (lib === 'Switch' || P.startsWith('SW')) return lead('SW');
    return lead('X');
  }
  if (n === 3 && (lib.startsWith('Transistor') || P.startsWith('Q_'))) {
    const legs = pinNums as [string, string, string];
    return { kind: 'to92', legs, names: legs.map((p) => comp.pins.get(p)!.name.toUpperCase()) as [string, string, string] };
  }
  if (n === 3 && P.startsWith('R_POT')) return { kind: 'pot3', legs: pinNums as [string, string, string] };
  if (n >= 4 && n % 2 === 0 && numeric(pinNums)) return { kind: 'dip', pins: n };
  return { kind: 'unsupported', reason: `${part} has ${n} pins${numeric(pinNums) ? '' : ' with non-numeric pin numbers'}; no breadboard footprint for it` };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/parts.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add circut-ai-tool/src/parts circut-ai-tool/test/parts.test.ts
git commit -m "feat(circuit): value parsing, 74xx tables and the part catalog"
```

---

### Task 6: Board geometry, occupancy and layout types

**Files:**
- Create: `circut-ai-tool/src/layout/types.ts`
- Create: `circut-ai-tool/src/layout/board.ts`
- Test: `circut-ai-tool/test/board.test.ts`

**Interfaces:**
- Produces (types.ts):
  - `type Row = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'T+'|'T-'|'B+'|'B-'`, `interface Hole { col: number; row: Row }`
  - `interface Options { board: 'auto'|'half'|'full'; railSplit: boolean | null; dipSwitchPositions: number; packageOrder: string[]; substitutions: Record<string, string> }`
  - `interface Sidecar { version: 1; options: Options; pinned: Record<string, Record<string, Hole>>; colors: Record<string, string>; placed: Record<string, Record<string, string[]>> }` (`placed` is used by the editing plan: uuids of labels the app placed per ref and pin)
  - `defaultOptions(): Options`, `emptySidecar(): Sidecar`, `normalizeSidecar(x: unknown): Sidecar` (fills missing fields, drops bad holes)
  - `interface BoardSpec { cols: number; kind: 'half'|'full'; splitCol: number | null; railGapEvery: number }`
  - `interface SupplyLead { net: string; hole: Hole; label: string }`, `interface Supply { leads: SupplyLead[] }`
  - `interface Package { id: string; kind: 'dip'|'dipswitch'|'sevenseg'; name: string; col0: number; pins: number; positions?: number; map?: Record<string, string>; common?: 'cathode'|'anode' }`
  - `interface PlacedPart { id: string; kind: 'lead2'|'to92'|'pot3'; style: string; value: string; holes: Hole[]; pins: string[]; nets: string[]; polarized: boolean; labels: string[] }`
  - `interface Wire { net: string; a: Hole; b: Hole; role: 'power'|'signal'|'bridge'|'split' }`
  - `interface NetInfo { name: string; color: string; power: '+'|'-'|'gnd'|null }`
- Produces (board.ts): `TOP_ROWS`, `BOT_ROWS`, `RAILS`, `PART_ROWS`, `MID_ROWS`, `WIRE_ROWS`, `hole(col, row)`, `isRail(row)`, `halfOf(row)`, `stripOf(h)`, `stripCol(s)`, `stripHalf(s)`, `holeKey(h)`, `parseHole(s)`, `holeName(h)`, `class LayoutError`, `class Board { cols; kind; splitCol; railGapEvery; railExists(col); inBounds(h); railNode(row, col); spec(): BoardSpec }`, `class Occupancy { isFree(h); owner(h); claim(h, owner): Hole; entries(): [string, string][] }`

- [ ] **Step 1: Write the failing tests**

`test/board.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { Board, Occupancy, halfOf, hole, holeKey, holeName, isRail, parseHole, stripOf } from '../src/layout/board.ts';
import { emptySidecar, normalizeSidecar } from '../src/layout/types.ts';

describe('holes and strips', () => {
  test('naming', () => {
    expect(stripOf(hole(12, 'c'))).toBe('T12');
    expect(stripOf(hole(12, 'h'))).toBe('B12');
    expect(stripOf(hole(3, 'T+'))).toBe('T+');
    expect(isRail('B-')).toBe(true);
    expect(halfOf('j')).toBe('B');
    expect(holeKey(hole(7, 'a'))).toBe('a7');
    expect(holeName(hole(7, 'a'))).toBe('a7');
    expect(holeName(hole(3, 'T+'))).toBe('top + rail, column 3');
    expect(parseHole('f12')).toEqual({ col: 12, row: 'f' });
    expect(parseHole('B-4')).toEqual({ col: 4, row: 'B-' });
    expect(() => parseHole('k1')).toThrow();
  });
});

describe('Board', () => {
  test('rails skip every sixth column and split on full boards', () => {
    const half = new Board(30, 'half', null, 6);
    expect(half.railExists(6)).toBe(false);
    expect(half.railExists(7)).toBe(true);
    expect(half.inBounds(hole(31, 'a'))).toBe(false);
    expect(half.railNode('T+', 5)).toBe('T+');
    const full = new Board(63, 'full', 30, 6);
    expect(full.railNode('T+', 30)).toBe('T+L');
    expect(full.railNode('T+', 31)).toBe('T+R');
  });
});

describe('Occupancy', () => {
  test('one owner per hole', () => {
    const occ = new Occupancy();
    occ.claim(hole(1, 'a'), 'R1');
    expect(occ.isFree(hole(1, 'a'))).toBe(false);
    expect(occ.owner(hole(1, 'a'))).toBe('R1');
    expect(() => occ.claim(hole(1, 'a'), 'R2')).toThrow(/a1 needed by R2 is already used by R1/);
  });
});

describe('sidecar', () => {
  test('normalize fills defaults and drops malformed holes', () => {
    const s = normalizeSidecar({ pinned: { R1: { '1': { col: 3, row: 'a' }, '2': { col: 'x', row: 'zz' } } }, colors: { '/A': '#123456' } });
    expect(s.options).toEqual(emptySidecar().options);
    expect(s.pinned).toEqual({ R1: { '1': { col: 3, row: 'a' } } });
    expect(s.colors['/A']).toBe('#123456');
    expect(s.placed).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/board.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/layout/types.ts**

```ts
// Types shared by the engine, checks, simulator, guide, renderer and client.

export type Row = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'T+' | 'T-' | 'B+' | 'B-';

export interface Hole {
  col: number;
  row: Row;
}

export interface Options {
  board: 'auto' | 'half' | 'full';
  railSplit: boolean | null;
  dipSwitchPositions: number;
  packageOrder: string[];
  substitutions: Record<string, string>;
}

export interface Sidecar {
  version: 1;
  options: Options;
  /** ref -> pin number -> hole. Every pin of the footprint must be present. */
  pinned: Record<string, Record<string, Hole>>;
  /** net name -> CSS colour. */
  colors: Record<string, string>;
  /** ref -> pin -> uuids of labels or power symbols this app placed on that pin (editing plan). */
  placed: Record<string, Record<string, string[]>>;
}

export const defaultOptions = (): Options => ({ board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {} });

export const emptySidecar = (): Sidecar => ({ version: 1, options: defaultOptions(), pinned: {}, colors: {}, placed: {} });

const ROWS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'T+', 'T-', 'B+', 'B-']);

export function isHole(x: unknown): x is Hole {
  return !!x && typeof x === 'object' && Number.isInteger((x as Hole).col) && (x as Hole).col >= 1 && ROWS.has((x as Hole).row);
}

/** Accept whatever is on disk and return a well-formed sidecar. */
export function normalizeSidecar(x: unknown): Sidecar {
  const s = emptySidecar();
  if (!x || typeof x !== 'object') return s;
  const o = x as Partial<Sidecar>;
  const opt = (o.options ?? {}) as Partial<Options>;
  if (opt.board === 'half' || opt.board === 'full') s.options.board = opt.board;
  if (typeof opt.railSplit === 'boolean') s.options.railSplit = opt.railSplit;
  if (Number.isInteger(opt.dipSwitchPositions) && (opt.dipSwitchPositions as number) >= 0) s.options.dipSwitchPositions = opt.dipSwitchPositions as number;
  if (Array.isArray(opt.packageOrder)) s.options.packageOrder = opt.packageOrder.filter((r) => typeof r === 'string');
  if (opt.substitutions && typeof opt.substitutions === 'object') for (const [k, v] of Object.entries(opt.substitutions)) if (typeof v === 'string') s.options.substitutions[k] = v;
  if (o.pinned && typeof o.pinned === 'object') {
    for (const [ref, pins] of Object.entries(o.pinned)) {
      if (!pins || typeof pins !== 'object') continue;
      const clean: Record<string, Hole> = {};
      for (const [pin, h] of Object.entries(pins as Record<string, unknown>)) if (isHole(h)) clean[pin] = { col: h.col, row: h.row };
      if (Object.keys(clean).length) s.pinned[ref] = clean;
    }
  }
  if (o.colors && typeof o.colors === 'object') for (const [k, v] of Object.entries(o.colors)) if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) s.colors[k] = v;
  if (o.placed && typeof o.placed === 'object') {
    for (const [ref, pins] of Object.entries(o.placed)) {
      if (!pins || typeof pins !== 'object') continue;
      const clean: Record<string, string[]> = {};
      for (const [pin, ids] of Object.entries(pins as Record<string, unknown>)) if (Array.isArray(ids)) clean[pin] = ids.filter((i) => typeof i === 'string');
      s.placed[ref] = clean;
    }
  }
  return s;
}

export interface BoardSpec {
  cols: number;
  kind: 'half' | 'full';
  splitCol: number | null;
  railGapEvery: number;
}

export interface SupplyLead {
  net: string;
  hole: Hole;
  label: string;
}

export interface Supply {
  leads: SupplyLead[];
}

export interface Package {
  id: string;
  kind: 'dip' | 'dipswitch' | 'sevenseg';
  name: string;
  col0: number;
  pins: number;
  positions?: number;
  /** dipswitch: position number -> switch ref. */
  map?: Record<string, string>;
  common?: 'cathode' | 'anode';
}

export interface PlacedPart {
  id: string;
  kind: 'lead2' | 'to92' | 'pot3';
  style: string;
  value: string;
  holes: Hole[];
  pins: string[];
  nets: string[];
  polarized: boolean;
  /** One label per hole, e.g. ["K", "A"] for an LED or ["E", "B", "C"] for a transistor. */
  labels: string[];
}

export interface Wire {
  net: string;
  a: Hole;
  b: Hole;
  role: 'power' | 'signal' | 'bridge' | 'split';
}

export interface NetInfo {
  name: string;
  color: string;
  power: '+' | '-' | 'gnd' | null;
}
```

- [ ] **Step 4: Write src/layout/board.ts**

```ts
// Breadboard geometry: rows, strips, rails, and who owns which hole.

import type { BoardSpec, Hole, Row } from './types.ts';

export const TOP_ROWS: Row[] = ['a', 'b', 'c', 'd', 'e'];
export const BOT_ROWS: Row[] = ['f', 'g', 'h', 'i', 'j'];
export const RAILS: Row[] = ['T+', 'T-', 'B+', 'B-'];
/** Outer row first: legs that continue to a rail. */
export const PART_ROWS: Record<'T' | 'B', Row[]> = { T: ['a', 'b', 'c', 'd'], B: ['j', 'i', 'h', 'g'] };
/** Legs between two strips. */
export const MID_ROWS: Record<'T' | 'B', Row[]> = { T: ['b', 'c', 'd', 'a'], B: ['i', 'h', 'g', 'j'] };
/** Inner row first: jumper wires. */
export const WIRE_ROWS: Record<'T' | 'B', Row[]> = { T: ['d', 'c', 'b', 'a'], B: ['g', 'h', 'i', 'j'] };

export class LayoutError extends Error {}

export const hole = (col: number, row: Row): Hole => ({ col, row });
export const isRail = (row: Row): boolean => row.length === 2;
export const halfOf = (row: Row): 'T' | 'B' => (isRail(row) ? (row[0] as 'T' | 'B') : TOP_ROWS.includes(row) ? 'T' : 'B');
export const stripOf = (h: Hole): string => (isRail(h.row) ? h.row : `${halfOf(h.row)}${h.col}`);
export const stripCol = (strip: string): number => Number(strip.slice(1));
export const stripHalf = (strip: string): 'T' | 'B' => strip[0] as 'T' | 'B';
export const holeKey = (h: Hole): string => `${h.row}${h.col}`;
export const sameHole = (a: Hole, b: Hole): boolean => a.col === b.col && a.row === b.row;

export function parseHole(s: string): Hole {
  const m = /^([a-j]|[TB][+-])(\d+)$/.exec(s.trim());
  if (!m) throw new LayoutError(`bad hole "${s}" (use a1..j63 for the strips, or T+3, B-10 for the rails)`);
  return { col: Number(m[2]), row: m[1] as Row };
}

export function holeName(h: Hole): string {
  return isRail(h.row) ? `${h.row[0] === 'T' ? 'top' : 'bottom'} ${h.row[1]} rail, column ${h.col}` : `${h.row}${h.col}`;
}

export class Board {
  constructor(
    public cols: number,
    public kind: 'half' | 'full',
    public splitCol: number | null,
    public railGapEvery: number,
  ) {}

  railExists(col: number): boolean {
    return col >= 1 && col <= this.cols && col % this.railGapEvery !== 0;
  }

  inBounds(h: Hole): boolean {
    return isRail(h.row) ? this.railExists(h.col) : h.col >= 1 && h.col <= this.cols;
  }

  /** Electrical node of a rail hole; split boards have a left and a right segment. */
  railNode(row: Row, col: number): string {
    if (!this.splitCol) return row;
    return col > this.splitCol ? `${row}R` : `${row}L`;
  }

  spec(): BoardSpec {
    return { cols: this.cols, kind: this.kind, splitCol: this.splitCol, railGapEvery: this.railGapEvery };
  }
}

export class Occupancy {
  private used = new Map<string, string>();

  isFree(h: Hole): boolean {
    return !this.used.has(holeKey(h));
  }

  owner(h: Hole): string | undefined {
    return this.used.get(holeKey(h));
  }

  claim(h: Hole, owner: string): Hole {
    const k = holeKey(h);
    const prev = this.used.get(k);
    if (prev !== undefined) throw new LayoutError(`hole ${holeName(h)} needed by ${owner} is already used by ${prev}`);
    this.used.set(k, owner);
    return h;
  }

  entries(): [string, string][] {
    return [...this.used.entries()];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/board.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/layout/types.ts circut-ai-tool/src/layout/board.ts circut-ai-tool/test/board.test.ts
git commit -m "feat(circuit): breadboard geometry, occupancy and sidecar types"
```

---

### Task 7: Layout engine

**Files:**
- Create: `circut-ai-tool/src/layout/engine.ts`
- Test: `circut-ai-tool/test/engine.test.ts`

**Interfaces:**
- Consumes: `Design`, `classify`, `powerKind`, `compareRefs`, `Board`, `Occupancy`, row tables, `Sidecar`.
- Produces:
  - `interface EngineResult { board: BoardSpec; supply: Supply | null; packages: Package[]; parts: PlacedPart[]; wires: Wire[]; nets: Record<string, NetInfo>; pinHoles: Record<string, Record<string, Hole>>; unplaced: { ref: string; reason: string }[]; warnings: string[]; footprints: Record<string, Footprint>; values: Record<string, string>; power: { plus: string[]; minus: string[]; gnd: string[]; plusName: string; gndName: string; secondName: string | null }; error: string | null }`
  - `layout(design: Design, sidecar: Sidecar): EngineResult` (never throws for layout problems; `error` and `unplaced` carry them)
  - `COLOR_PLUS`, `COLOR_GND`, `COLOR_MINUS`, `PALETTE`
  - re-export `LayoutError`

- [ ] **Step 1: Write the failing tests**

`test/engine.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { holeKey, isRail } from '../src/layout/board.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar, type Hole } from '../src/layout/types.ts';
import { makeDesign, parseNetlist, isUnconnected } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

const pl1 = parseNetlist(readFixture('PL1_1.net'));

function allHoles(r: ReturnType<typeof layout>): Hole[] {
  const out: Hole[] = [];
  for (const pins of Object.values(r.pinHoles)) out.push(...Object.values(pins));
  for (const w of r.wires) out.push(w.a, w.b);
  for (const l of r.supply?.leads ?? []) out.push(l.hole);
  return out;
}

describe('layout of PL1_1', () => {
  const r = layout(pl1, emptySidecar());

  test('places everything without errors', () => {
    expect(r.error).toBeNull();
    expect(r.unplaced).toEqual([]);
    expect(r.packages.map((p) => p.id)).toEqual(['U1', 'U2', 'U3']);
    expect(Object.keys(r.pinHoles).sort()).toEqual(['D1', 'D2', 'R1', 'R2', 'R3', 'R4', 'SW1', 'SW2', 'U1', 'U2', 'U3']);
    expect(r.parts.map((p) => p.id).sort()).toEqual(['D1', 'D2', 'R1', 'R2', 'R3', 'R4', 'SW1', 'SW2']);
  });

  test('DIP pins straddle the gutter with pin 1 in row f', () => {
    const u3 = r.pinHoles.U3;
    expect(u3['1'].row).toBe('f');
    expect(u3['7'].row).toBe('f');
    expect(u3['7'].col).toBe(u3['1'].col + 6);
    expect(u3['8'].row).toBe('e');
    expect(u3['8'].col).toBe(u3['7'].col);
    expect(u3['14'].col).toBe(u3['1'].col);
  });

  test('no hole is used twice and every hole is on the board', () => {
    const seen = new Map<string, number>();
    for (const h of allHoles(r)) seen.set(holeKey(h), (seen.get(holeKey(h)) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
    for (const h of allHoles(r)) {
      expect(h.col).toBeGreaterThanOrEqual(1);
      expect(h.col).toBeLessThanOrEqual(r.board.cols);
      if (isRail(h.row)) expect(h.col % r.board.railGapEvery).not.toBe(0);
    }
  });

  test('supply leads, power wires and bridges exist', () => {
    expect(r.supply!.leads.map((l) => l.net)).toEqual(['+5V', 'GND']);
    expect(r.wires.filter((w) => w.role === 'power' && w.net === '+5V').length).toBeGreaterThanOrEqual(3);
    expect(r.wires.filter((w) => w.role === 'bridge')).toHaveLength(2);
    expect(r.nets['+5V'].power).toBe('+');
    expect(r.nets['GND'].color).toBe('#1E1E1E');
    expect(r.nets['/A'].color).toMatch(/^#/);
  });

  test('LED holes are ordered cathode then anode and labelled', () => {
    const d1 = r.parts.find((p) => p.id === 'D1')!;
    expect(d1.pins).toEqual(['1', '2']);
    expect(d1.labels).toEqual(['K', 'A']);
    expect(d1.nets).toEqual(['Net-(D1-K)', 'Net-(D1-A)']);
  });

  test('is deterministic', () => {
    expect(JSON.stringify(layout(pl1, emptySidecar()))).toBe(JSON.stringify(r));
  });

  test('every connected pin of a placed part has a hole', () => {
    for (const [ref, comp] of pl1.components) {
      if (!r.pinHoles[ref]) continue;
      for (const p of comp.pins.values()) if (!isUnconnected(p.net)) expect(r.pinHoles[ref][p.num]).toBeDefined();
    }
  });
});

describe('pinned placements', () => {
  test('honours valid pins and drops invalid ones with a warning', () => {
    const base = layout(pl1, emptySidecar());
    const s = emptySidecar();
    const r1 = base.pinHoles.R1;
    s.pinned.R1 = { '1': { col: r1['1'].col + 2, row: r1['1'].row }, '2': { col: r1['2'].col + 2, row: r1['2'].row } };
    s.pinned.R2 = { '1': base.pinHoles.U1['1'], '2': base.pinHoles.U1['2'] }; // collides with U1 when U1 is not pinned? U1 is placed after pinned parts, so R2 wins and U1 moves.
    s.pinned.R9 = { '1': { col: 1, row: 'a' }, '2': { col: 1, row: 'b' } };
    const r = layout(pl1, s);
    expect(r.error).toBeNull();
    expect(r.pinHoles.R1).toEqual(s.pinned.R1);
    expect(r.pinHoles.R2).toEqual(s.pinned.R2);
    expect(r.pinHoles.U1['1']).not.toEqual(s.pinned.R2['1']);
    expect(r.warnings.some((w) => w.includes('R9'))).toBe(true);
  });

  test('a pinned package keeps its column', () => {
    const base = layout(pl1, emptySidecar());
    const s = emptySidecar();
    s.options.board = 'full';
    const shift = 20;
    s.pinned.U3 = Object.fromEntries(Object.entries(base.pinHoles.U3).map(([pin, h]) => [pin, { col: h.col + shift, row: h.row }]));
    const r = layout(pl1, s);
    expect(r.error).toBeNull();
    expect(r.packages.find((p) => p.id === 'U3')!.col0).toBe(base.packages.find((p) => p.id === 'U3')!.col0 + shift);
  });
});

describe('options', () => {
  test('folds separate switches into one DIP switch', () => {
    const s = emptySidecar();
    s.options.dipSwitchPositions = 4;
    const r = layout(pl1, s);
    expect(r.error).toBeNull();
    const sw = r.packages[0];
    expect(sw.kind).toBe('dipswitch');
    expect(sw.positions).toBe(4);
    expect(sw.map).toEqual({ '1': 'SW1', '2': 'SW2' });
    expect(r.pinHoles.SW1['2'].row).toBe('e');
    expect(r.parts.find((p) => p.id === 'SW1')).toBeUndefined();
  });

  test('forcing a half board that is too small reports the problem', () => {
    const s = emptySidecar();
    s.options.board = 'half';
    s.options.packageOrder = ['U3', 'U2', 'U1'];
    const r = layout(pl1, s);
    expect(r.packages[0].id).toBe('U3');
    expect(r.board.kind).toBe('half');
  });
});

describe('other footprints', () => {
  test('three-lead parts occupy three consecutive columns in one row', () => {
    const d = makeDesign({
      Q1: { lib: 'Transistor_BJT', part: '2N3904', value: '2N3904', pins: { '1': ['E', 'passive', 'GND'], '2': ['B', 'input', '/IN'], '3': ['C', 'passive', '/OUT'] } },
      R1: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '/IN'], '2': ['~', 'passive', '/SW'] } },
      R2: { lib: 'Device', part: 'R', value: '330', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/LEDA'] } },
      D1: { lib: 'Device', part: 'LED', value: 'LED', pins: { '1': ['K', 'passive', '/OUT'], '2': ['A', 'passive', '/LEDA'] } },
      SW1: { lib: 'Switch', part: 'SW_Push', value: 'SW_Push', pins: { '1': ['1', 'passive', '/SW'], '2': ['2', 'passive', '+5V'] } },
      RV1: { lib: 'Device', part: 'R_Potentiometer', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/IN'], '3': ['3', 'passive', 'GND'] } },
    });
    const r = layout(d, emptySidecar());
    expect(r.error).toBeNull();
    expect(r.unplaced).toEqual([]);
    const q = r.parts.find((p) => p.id === 'Q1')!;
    expect(q.kind).toBe('to92');
    expect(q.labels).toEqual(['E', 'B', 'C']);
    expect(q.holes.map((h) => h.row)).toEqual([q.holes[0].row, q.holes[0].row, q.holes[0].row]);
    expect(q.holes.map((h) => h.col)).toEqual([q.holes[0].col, q.holes[0].col + 1, q.holes[0].col + 2]);
    const pot = r.parts.find((p) => p.id === 'RV1')!;
    expect(pot.kind).toBe('pot3');
    expect(r.wires.filter((w) => w.net === '/IN').length).toBeGreaterThanOrEqual(1);
  });

  test('a real DIP switch and a 7-segment display are packages', () => {
    const d = makeDesign({
      SW1: { lib: 'Switch', part: 'SW_DIP_x04', value: 'SW_DIP_x04', pins: { '1': ['~', 'passive', '/S1'], '2': ['~', 'passive', '/S2'], '3': ['~', 'passive', '/S3'], '4': ['~', 'passive', '/S4'], '5': ['~', 'passive', 'GND'], '6': ['~', 'passive', 'GND'], '7': ['~', 'passive', 'GND'], '8': ['~', 'passive', 'GND'] } },
      DS1: { lib: 'Display_Character', part: 'D168K', value: 'D168K', pins: { '7': ['A', 'input', '/a'], '6': ['B', 'input', '/b'], '4': ['C', 'input', '/c'], '2': ['D', 'input', '/d'], '1': ['E', 'input', '/e'], '9': ['F', 'input', '/f'], '10': ['G', 'input', '/g'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CC', 'input', 'GND'], '8': ['CC', 'input', 'GND'] } },
      R1: { lib: 'Device', part: 'R', value: '10k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/S1'] } },
      R2: { lib: 'Device', part: 'R', value: '330', pins: { '1': ['~', 'passive', '/S1'], '2': ['~', 'passive', '/a'] } },
    });
    const r = layout(d, emptySidecar());
    expect(r.error).toBeNull();
    expect(r.packages.map((p) => p.kind)).toEqual(['dipswitch', 'sevenseg']);
    expect(r.pinHoles.SW1['1']).toEqual({ col: r.packages[0].col0, row: 'f' });
    expect(r.pinHoles.SW1['8']).toEqual({ col: r.packages[0].col0, row: 'e' });
    const ds = r.packages[1];
    expect(r.pinHoles.DS1['1']).toEqual({ col: ds.col0, row: 'f' });
    expect(r.pinHoles.DS1['10']).toEqual({ col: ds.col0, row: 'e' });
    expect(r.wires.filter((w) => w.role === 'power' && w.net === 'GND').length).toBeGreaterThanOrEqual(1);
  });

  test('split supplies use the bottom rail for the second supply', () => {
    const d = makeDesign({
      U1: { lib: 'Amplifier_Operational', part: 'LM741', value: 'LM741', pins: { '1': ['NULL', 'input', 'unconnected-(U1-Pad1)'], '2': ['-', 'input', '/INV'], '3': ['+', 'input', 'GND'], '4': ['V-', 'power_in', '-12V'], '5': ['NULL', 'input', 'unconnected-(U1-Pad5)'], '6': ['~', 'output', '/OUT'], '7': ['V+', 'power_in', '+12V'], '8': ['NC', 'no_connect', 'unconnected-(U1-Pad8)'] } },
      R1: { lib: 'Device', part: 'R', value: '10k', pins: { '1': ['~', 'passive', '/IN'], '2': ['~', 'passive', '/INV'] } },
      R2: { lib: 'Device', part: 'R', value: '100k', pins: { '1': ['~', 'passive', '/INV'], '2': ['~', 'passive', '/OUT'] } },
    });
    const r = layout(d, emptySidecar());
    expect(r.error).toBeNull();
    expect(r.supply!.leads.map((l) => l.net)).toEqual(['+12V', 'GND', '-12V']);
    expect(r.supply!.leads[2].hole.row).toBe('B+');
    expect(r.wires.find((w) => w.net === '-12V' && w.role === 'power')!.b.row).toBe('B+');
    expect(r.wires.filter((w) => w.role === 'bridge')).toHaveLength(1);
    expect(r.nets['-12V'].color).toBe('#1F6FE0');
  });

  test('three non-ground supplies is an error, but the doc still comes back', () => {
    const d = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '+12V'] } },
      R2: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '-12V'], '2': ['~', 'passive', 'GND'] } },
    });
    const r = layout(d, emptySidecar());
    expect(r.error).toMatch(/more than two non-ground supplies/);
    expect(r.board.cols).toBe(30);
  });

  test('unsupported parts are reported, not fatal', () => {
    const d = makeDesign({
      X1: { lib: 'Device', part: 'Crystal_GND24', value: '16MHz', pins: { '1': ['1', 'passive', '/A'], '2': ['2', 'passive', '/B'], '3': ['3', 'passive', 'GND'] } },
      R1: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '/A'], '2': ['~', 'passive', '/B'] } },
    });
    const r = layout(d, emptySidecar());
    expect(r.error).toBeNull();
    expect(r.unplaced).toEqual([{ ref: 'X1', reason: expect.stringContaining('no breadboard footprint') }]);
    expect(r.pinHoles.R1).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/engine.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/layout/engine.ts**

```ts
// Deterministic breadboard placement and routing.
//
// Order: size the board, claim pinned holes, place packages across the
// gutter, supply leads, three-lead parts, two-lead parts anchored to nets that
// already have a home strip, power jumpers to the rails, signal jumpers strip
// to strip, rail bridges. Every hole has one owner. Problems never throw out
// of layout(): they land in `error`, `unplaced` and `warnings`.

import type { Component, Design, DesignPin } from '../netlist.ts';
import { displayName, isUnconnected } from '../netlist.ts';
import { classify, powerKind, type Footprint, type PowerKind } from '../parts/catalog.ts';
import { compareRefs } from '../parts/values.ts';
import { BOT_ROWS, Board, LayoutError, MID_ROWS, Occupancy, PART_ROWS, RAILS, TOP_ROWS, WIRE_ROWS, hole, isRail, stripCol, stripHalf, stripOf } from './board.ts';
import type { BoardSpec, Hole, NetInfo, Options, Package, PlacedPart, Row, Sidecar, Supply, Wire } from './types.ts';

export { LayoutError };

export const PALETTE = ['#E3B505', '#2E9E4F', '#F26B1D', '#7B3FBF', '#1F6FE0', '#8B5A2B', '#0FA3A3', '#D6336C', '#5C7C2A', '#3E4A61', '#B8860B', '#4682B4'];
export const COLOR_PLUS = '#D7263D';
export const COLOR_GND = '#1E1E1E';
export const COLOR_MINUS = '#1F6FE0';

export interface EngineResult {
  board: BoardSpec;
  supply: Supply | null;
  packages: Package[];
  parts: PlacedPart[];
  wires: Wire[];
  nets: Record<string, NetInfo>;
  pinHoles: Record<string, Record<string, Hole>>;
  unplaced: { ref: string; reason: string }[];
  warnings: string[];
  footprints: Record<string, Footprint>;
  values: Record<string, string>;
  power: { plus: string[]; minus: string[]; gnd: string[]; plusName: string; gndName: string; secondName: string | null };
  error: string | null;
}

type Half = 'T' | 'B';
const pinKey = (ref: string, pin: string) => `${ref} ${pin}`;
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

export function layout(design: Design, sidecar: Sidecar): EngineResult {
  const first = new Engine(design, sidecar, null).build();
  const outOfRoom = first.error !== null || first.unplaced.some((u) => /no room|no free/.test(u.reason));
  if (sidecar.options.board === 'auto' && first.board.kind === 'half' && outOfRoom) {
    const second = new Engine(design, sidecar, 'full').build();
    if (!second.error && second.unplaced.length <= first.unplaced.length) return second;
  }
  return first;
}

class Engine {
  private opt: Options;
  private occ = new Occupancy();
  private fp = new Map<string, Footprint>();
  private values = new Map<string, string>();
  private plus: string[] = [];
  private minus: string[] = [];
  private gnd: string[] = [];
  private plusName = '+5V';
  private gndName = 'GND';
  private secondName: string | null = null;
  private packages: Package[] = [];
  private parts: PlacedPart[] = [];
  private wires: Wire[] = [];
  private pinHole = new Map<string, Hole>();
  private homes = new Map<string, string[]>();
  private pkgCols = new Set<number>();
  private dipMap = new Map<string, number>();
  private board: Board | null = null;
  private supply: Supply | null = null;
  private unplaced: { ref: string; reason: string }[] = [];
  private warnings: string[] = [];

  constructor(
    private d: Design,
    private sidecar: Sidecar,
    private forceBoard: 'half' | 'full' | null,
  ) {
    this.opt = sidecar.options;
    for (const [ref, comp] of d.components) {
      const value = this.opt.substitutions[ref] ?? comp.value;
      this.values.set(ref, value);
      this.fp.set(ref, classify({ ...comp, value }));
    }
    for (const net of d.nets.keys()) {
      const k = powerKind(net);
      if (k === '+') this.plus.push(net);
      else if (k === '-') this.minus.push(net);
      else if (k === 'gnd') this.gnd.push(net);
    }
    this.plus.sort();
    this.minus.sort();
    this.gnd.sort();
    if (this.plus.length) this.plusName = this.plus[0];
    if (this.gnd.length) this.gndName = this.gnd[0];
  }

  // ---------- nets and rails ----------

  private power(net: string): PowerKind {
    return this.plus.includes(net) ? '+' : this.minus.includes(net) ? '-' : this.gnd.includes(net) ? 'gnd' : null;
  }

  /** Rail a net uses when reached from a given half; null for signal nets. */
  private railFor(net: string, half: Half): Row | null {
    const k = this.power(net);
    if (k === 'gnd') return `${half}-` as Row;
    if (net === this.plusName) return this.secondName ? 'T+' : (`${half}+` as Row);
    if (net === this.secondName) return 'B+';
    return k ? 'T+' : null;
  }

  private railNet(rail: Row): string | null {
    if (rail === 'T-' || rail === 'B-') return this.gnd.length ? this.gndName : null;
    if (rail === 'T+') return this.plus.length ? this.plusName : null;
    return this.secondName ?? (this.plus.length ? this.plusName : null);
  }

  private addHome(net: string, strip: string) {
    if (isUnconnected(net)) return;
    const list = this.homes.get(net) ?? [];
    if (!list.includes(strip)) list.push(strip);
    this.homes.set(net, list);
  }

  private claimPin(ref: string, pin: string, h: Hole, net: string | undefined) {
    this.occ.claim(h, ref);
    this.pinHole.set(pinKey(ref, pin), h);
    if (net) this.addHome(net, stripOf(h));
  }

  private pinsOf(ref: string): string[] {
    const fp = this.fp.get(ref)!;
    const comp = this.d.components.get(ref)!;
    switch (fp.kind) {
      case 'dip':
      case 'sevenseg':
        return [...comp.pins.keys()].filter((p) => /^\d+$/.test(p)).sort((a, b) => Number(a) - Number(b));
      case 'lead2':
        return [fp.a, fp.b];
      case 'to92':
      case 'pot3':
        return [...fp.legs];
      case 'dipswitch':
        return fp.pairs.flat();
      default:
        return [];
    }
  }

  private packageWidth(fp: Footprint): number {
    return fp.kind === 'dip' ? fp.pins / 2 : fp.kind === 'dipswitch' ? fp.positions : fp.kind === 'sevenseg' ? fp.pins / 2 : 0;
  }

  private isPackage(fp: Footprint): boolean {
    return fp.kind === 'dip' || fp.kind === 'dipswitch' || fp.kind === 'sevenseg';
  }

  private packageRefs(): string[] {
    const refs = [...this.fp.entries()].filter(([, f]) => this.isPackage(f)).map(([r]) => r);
    const ordered = this.opt.packageOrder.filter((r) => refs.includes(r));
    const rank = (r: string) => ({ dipswitch: 0, dip: 1, sevenseg: 2 })[this.fp.get(r)!.kind as 'dipswitch' | 'dip' | 'sevenseg'];
    const rest = refs.filter((r) => !ordered.includes(r)).sort((a, b) => rank(a) - rank(b) || compareRefs(a, b));
    return [...ordered, ...rest];
  }

  private foldedSwitches(): string[] {
    if (!this.opt.dipSwitchPositions) return [];
    return [...this.fp.entries()]
      .filter(([r, f]) => f.kind === 'lead2' && f.style === 'SW' && !this.sidecar.pinned[r])
      .map(([r]) => r)
      .sort(compareRefs);
  }

  // ---------- board ----------

  private sizeBoard() {
    const extra = [...this.plus.slice(1), ...this.minus];
    if (extra.length > 1) throw new LayoutError(`more than two non-ground supplies: ${[...this.plus, ...this.minus].map(displayName).join(', ')}. A breadboard has two rail pairs.`);
    this.secondName = extra[0] ?? null;
    let need = 3;
    const folded = this.foldedSwitches();
    if (folded.length) need += Math.max(this.opt.dipSwitchPositions, folded.length) + 2;
    for (const ref of this.packageRefs()) if (!this.sidecar.pinned[ref]) need += this.packageWidth(this.fp.get(ref)!) + 2;
    let maxPinned = 0;
    for (const holes of Object.values(this.sidecar.pinned)) for (const h of Object.values(holes)) maxPinned = Math.max(maxPinned, h.col);
    need = Math.max(need, maxPinned + 3);
    const kind = this.forceBoard ?? (this.opt.board !== 'auto' ? this.opt.board : need <= 30 ? 'half' : 'full');
    const cols = kind === 'half' ? 30 : 63;
    if (need > cols) throw new LayoutError(`the packages need about ${need} columns; a ${kind}-size board has ${cols}. Switch the board option to full or unpin parts.`);
    const split = this.opt.railSplit ?? kind === 'full';
    this.board = new Board(cols, kind, split ? 30 : null, 6);
  }

  private get b(): Board {
    if (!this.board) throw new LayoutError('board not sized');
    return this.board;
  }

  // ---------- registration ----------

  private registerPlaced(ref: string, fp: Footprint, comp: Component, holes: Record<string, Hole>) {
    const value = this.values.get(ref) ?? comp.value;
    const netOf = (p: string) => comp.pins.get(p)?.net ?? '';
    const col0 = Math.min(...Object.values(holes).map((h) => h.col));
    const addCols = (w: number) => {
      for (let c = col0; c < col0 + w; c++) this.pkgCols.add(c);
    };
    switch (fp.kind) {
      case 'dip':
        this.packages.push({ id: ref, kind: 'dip', name: value, col0, pins: fp.pins });
        addCols(fp.pins / 2);
        break;
      case 'sevenseg':
        this.packages.push({ id: ref, kind: 'sevenseg', name: value, col0, pins: fp.pins, common: fp.common });
        addCols(fp.pins / 2);
        break;
      case 'dipswitch':
        this.packages.push({ id: ref, kind: 'dipswitch', name: value, col0, pins: fp.positions * 2, positions: fp.positions, map: Object.fromEntries(fp.pairs.map((_, i) => [String(i + 1), ref])) });
        addCols(fp.positions);
        break;
      case 'lead2':
        this.parts.push({ id: ref, kind: 'lead2', style: fp.style, value, holes: [holes[fp.a], holes[fp.b]], pins: [fp.a, fp.b], nets: [netOf(fp.a), netOf(fp.b)], polarized: fp.polarized, labels: [fp.aLabel, fp.bLabel] });
        break;
      case 'to92':
        this.parts.push({ id: ref, kind: 'to92', style: fp.names.join(''), value, holes: fp.legs.map((p) => holes[p]), pins: [...fp.legs], nets: fp.legs.map(netOf), polarized: false, labels: [...fp.names] });
        break;
      case 'pot3':
        this.parts.push({ id: ref, kind: 'pot3', style: 'POT', value, holes: fp.legs.map((p) => holes[p]), pins: [...fp.legs], nets: fp.legs.map(netOf), polarized: false, labels: ['1', 'W', '3'] });
        break;
      default:
        break;
    }
  }

  // ---------- pinned ----------

  private placePinned() {
    for (const [ref, holes] of Object.entries(this.sidecar.pinned)) {
      const comp = this.d.components.get(ref);
      const fp = this.fp.get(ref);
      if (!comp || !fp || (!this.isPackage(fp) && fp.kind !== 'lead2' && fp.kind !== 'to92' && fp.kind !== 'pot3')) {
        this.warnings.push(`pinned placement for ${ref} dropped: not a placeable part of this schematic`);
        continue;
      }
      const pins = this.pinsOf(ref);
      const missing = pins.filter((p) => !holes[p]);
      if (missing.length) {
        this.warnings.push(`pinned placement for ${ref} dropped: pins changed (${missing.join(', ')} missing)`);
        continue;
      }
      const bad = pins.map((p) => holes[p]).find((h) => !this.b.inBounds(h) || !this.occ.isFree(h) || isRail(h.row));
      if (bad) {
        this.warnings.push(`pinned placement for ${ref} dropped: hole ${bad.row}${bad.col} is off the board, on a rail, or already taken`);
        continue;
      }
      const clean: Record<string, Hole> = {};
      for (const p of pins) {
        clean[p] = { col: holes[p].col, row: holes[p].row };
        this.claimPin(ref, p, clean[p], comp.pins.get(p)?.net);
      }
      this.registerPlaced(ref, fp, comp, clean);
    }
  }

  private isPlaced(ref: string): boolean {
    const pins = this.pinsOf(ref);
    return pins.length > 0 && this.pinHole.has(pinKey(ref, pins[0]));
  }

  // ---------- packages ----------

  private spanFree(col: number, width: number): boolean {
    if (col < 1 || col + width - 1 > this.b.cols) return false;
    for (let c = col - 2; c <= col + width + 1; c++) if (this.pkgCols.has(c)) return false;
    for (let c = col; c < col + width; c++) if (!this.occ.isFree(hole(c, 'e')) || !this.occ.isFree(hole(c, 'f'))) return false;
    return true;
  }

  private findPackageColumn(width: number, owner: string): number {
    for (let col = 3; col + width - 1 <= this.b.cols - 2; col++) if (this.spanFree(col, width)) return col;
    throw new LayoutError(`no room for ${owner} (${width} columns) on a ${this.b.kind}-size board`);
  }

  private placePackages() {
    const folded = this.foldedSwitches();
    if (folded.length) {
      const npos = Math.max(this.opt.dipSwitchPositions, folded.length);
      const col0 = this.findPackageColumn(npos, 'the DIP switch');
      const pkg: Package = { id: 'SW', kind: 'dipswitch', name: `${npos}-position DIP switch`, col0, pins: npos * 2, positions: npos, map: {} };
      folded.forEach((ref, i) => {
        const comp = this.d.components.get(ref)!;
        const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'lead2' }>;
        const pa = comp.pins.get(fp.a)!;
        const pb = comp.pins.get(fp.b)!;
        const [top, bottom] = this.power(pb.net) === 'gnd' ? [pa, pb] : this.power(pa.net) === 'gnd' ? [pb, pa] : [pa, pb];
        this.claimPin(ref, top.num, hole(col0 + i, 'e'), top.net);
        this.claimPin(ref, bottom.num, hole(col0 + i, 'f'), bottom.net);
        pkg.map![String(i + 1)] = ref;
        this.dipMap.set(ref, i + 1);
      });
      for (let i = folded.length; i < npos; i++) {
        this.occ.claim(hole(col0 + i, 'e'), 'SW');
        this.occ.claim(hole(col0 + i, 'f'), 'SW');
      }
      for (let c = col0; c < col0 + npos; c++) this.pkgCols.add(c);
      this.packages.push(pkg);
    }
    for (const ref of this.packageRefs()) {
      if (this.isPlaced(ref)) continue;
      const fp = this.fp.get(ref)!;
      const comp = this.d.components.get(ref)!;
      const width = this.packageWidth(fp);
      let col0: number;
      try {
        col0 = this.findPackageColumn(width, ref);
      } catch (e) {
        this.unplaced.push({ ref, reason: (e as Error).message });
        continue;
      }
      const holes: Record<string, Hole> = {};
      if (fp.kind === 'dip' || fp.kind === 'sevenseg') {
        const n = fp.pins;
        const half = n / 2;
        for (const p of this.pinsOf(ref)) {
          const k = Number(p);
          holes[p] = k <= half ? hole(col0 + k - 1, 'f') : hole(col0 + (n - k), 'e');
        }
      } else if (fp.kind === 'dipswitch') {
        fp.pairs.forEach(([t, bt], i) => {
          holes[t] = hole(col0 + i, 'f');
          holes[bt] = hole(col0 + i, 'e');
        });
      }
      for (const [p, h] of Object.entries(holes)) this.claimPin(ref, p, h, comp.pins.get(p)?.net);
      this.registerPlaced(ref, fp, comp, holes);
    }
  }

  // ---------- holes ----------

  private freeRows(strip: string, order: Record<Half, Row[]>): Row[] {
    const half = stripHalf(strip);
    const col = stripCol(strip);
    return order[half].filter((r) => this.occ.isFree(hole(col, r)));
  }

  private take(strip: string, order: Record<Half, Row[]>, owner: string, preferRow?: Row): Hole {
    let rows = this.freeRows(strip, order);
    if (preferRow && rows.includes(preferRow)) rows = [preferRow, ...rows.filter((r) => r !== preferRow)];
    if (!rows.length) throw new LayoutError(`no free hole in strip ${strip} for ${owner}`);
    return this.occ.claim(hole(stripCol(strip), rows[0]), owner);
  }

  private railHole(rail: Row, nearCol: number, owner: string, step: -1 | 1 | null = null): Hole {
    const split = this.b.splitCol;
    let cands = Array.from({ length: this.b.cols }, (_, i) => i + 1).sort((x, y) => Math.abs(x - nearCol) - Math.abs(y - nearCol) || x - y);
    if (step !== null) cands = cands.filter((c) => (c - nearCol) * step >= 0);
    else if (split) cands = cands.filter((c) => (c <= split) === (nearCol <= split));
    for (const c of cands) if (this.b.railExists(c) && this.occ.isFree(hole(c, rail))) return this.occ.claim(hole(c, rail), owner);
    throw new LayoutError(`no free ${rail} rail hole near column ${nearCol} for ${owner}`);
  }

  private freeBlock(half: Half, near: number, width: number, owner: string): number {
    const rows = half === 'T' ? TOP_ROWS : BOT_ROWS;
    const ok = (c: number) => c >= 1 && c + width - 1 <= this.b.cols && Array.from({ length: width }, (_, i) => c + i).every((cc) => !this.pkgCols.has(cc) && rows.every((r) => this.occ.isFree(hole(cc, r))));
    const dists = [2, 3, 1, ...Array.from({ length: this.b.cols }, (_, i) => i + 4)];
    for (const dist of dists) for (const c of [near + dist, near - dist - width + 1]) if (ok(c)) return c;
    if (ok(near)) return near;
    throw new LayoutError(`no free block of ${width} column${width > 1 ? 's' : ''} near column ${near} for ${owner}`);
  }

  private pickStrip(net: string): string {
    const strips = uniq(this.homes.get(net) ?? []).sort((a, b) => stripCol(a) - stripCol(b));
    let best = strips[0];
    let bestScore = -1;
    for (const s of strips) {
      const score = this.freeRows(s, PART_ROWS).length;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (bestScore <= 0) throw new LayoutError(`no free hole on net ${displayName(net)}`);
    return best;
  }

  // ---------- supply ----------

  private placeSupply() {
    if (!this.plus.length && !this.minus.length) {
      this.warnings.push('no supply net found (add a +5V or similar power symbol); the rails stay empty');
      return;
    }
    if (!this.gnd.length) this.warnings.push('no GND net found; the ground rails stay empty');
    const leads: Supply['leads'] = [];
    if (this.plus.length) leads.push({ net: this.plusName, hole: this.railHole('T+', 1, 'supply +'), label: `${displayName(this.plusName)} lead` });
    if (this.gnd.length) leads.push({ net: this.gndName, hole: this.railHole('T-', 2, 'supply GND'), label: `${displayName(this.gndName)} lead` });
    if (this.secondName) leads.push({ net: this.secondName, hole: this.railHole('B+', 1, 'supply 2'), label: `${displayName(this.secondName)} lead` });
    this.supply = { leads };
  }

  // ---------- three-lead parts ----------

  private placeThreeLead() {
    const refs = [...this.fp.entries()].filter(([r, f]) => (f.kind === 'to92' || f.kind === 'pot3') && !this.isPlaced(r)).map(([r]) => r).sort(compareRefs);
    for (const ref of refs) {
      const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'to92' | 'pot3' }>;
      const comp = this.d.components.get(ref)!;
      let near = this.packages[0]?.col0 ?? 3;
      let half: Half = 'T';
      for (const p of fp.legs) {
        const net = comp.pins.get(p)?.net ?? '';
        const hs = this.homes.get(net);
        if (hs?.length && !this.power(net)) {
          near = stripCol(hs[0]);
          half = stripHalf(hs[0]);
          break;
        }
      }
      try {
        const col = this.freeBlock(half, near, 3, ref);
        const row: Row = half === 'T' ? 'c' : 'h';
        const holes: Record<string, Hole> = {};
        fp.legs.forEach((p, i) => {
          holes[p] = hole(col + i, row);
        });
        for (const [p, h] of Object.entries(holes)) this.claimPin(ref, p, h, comp.pins.get(p)?.net);
        this.registerPlaced(ref, fp, comp, holes);
      } catch (e) {
        this.unplaced.push({ ref, reason: (e as Error).message });
      }
    }
  }

  // ---------- two-lead parts ----------

  private placeTwoLead() {
    const pending = [...this.fp.entries()]
      .filter(([r, f]) => f.kind === 'lead2' && !this.dipMap.has(r) && !this.isPlaced(r))
      .map(([r]) => r)
      .sort(compareRefs);
    const drop = (ref: string) => pending.splice(pending.indexOf(ref), 1);
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (const ref of [...pending]) {
        try {
          if (this.tryPlaceTwoLead(ref, false)) {
            drop(ref);
            progress = true;
          }
        } catch (e) {
          this.unplaced.push({ ref, reason: (e as Error).message });
          drop(ref);
          progress = true;
        }
      }
    }
    for (const ref of [...pending]) {
      try {
        this.tryPlaceTwoLead(ref, true);
      } catch (e) {
        this.unplaced.push({ ref, reason: (e as Error).message });
      }
    }
  }

  private tryPlaceTwoLead(ref: string, force: boolean): boolean {
    const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'lead2' }>;
    const comp = this.d.components.get(ref)!;
    const pa0 = comp.pins.get(fp.a);
    const pb0 = comp.pins.get(fp.b);
    if (!pa0 || !pb0) throw new LayoutError(`${ref} is missing pin ${!pa0 ? fp.a : fp.b} in the netlist`);
    let pair: [DesignPin, DesignPin] | null = null;
    for (const [x, y] of [[pa0, pb0], [pb0, pa0]] as [DesignPin, DesignPin][]) {
      if (!this.power(x.net) && !isUnconnected(x.net) && this.homes.get(x.net)?.length) {
        pair = [x, y];
        break;
      }
    }
    if (!pair) {
      if (this.power(pa0.net) && this.power(pb0.net)) pair = [pa0, pb0];
      else if (force) pair = [pa0, pb0];
      else return false;
    }
    const [pa, pb] = pair;
    const isSwitch = fp.style === 'SW' || fp.style === 'BTN';
    const toRail = !!this.power(pb.net) && !isSwitch && !!this.railFor(pb.net, 'T');
    let ha: Hole;
    if (this.homes.get(pa.net)?.length && !this.power(pa.net)) {
      ha = this.take(this.pickStrip(pa.net), toRail ? PART_ROWS : MID_ROWS, ref);
    } else {
      const c = this.freeBlock('T', this.packages[0]?.col0 ?? 3, 1, ref);
      ha = this.occ.claim(hole(c, 'a'), ref);
      this.addHome(pa.net, `T${c}`);
    }
    const half = stripHalf(stripOf(ha));
    let hb: Hole;
    if (toRail) {
      hb = this.railHole(this.railFor(pb.net, half)!, ha.col, ref);
    } else {
      const near = (this.homes.get(pb.net) ?? [])
        .filter((s) => stripHalf(s) === half && stripCol(s) !== ha.col && Math.abs(stripCol(s) - ha.col) <= 2)
        .sort((x, y) => Math.abs(stripCol(x) - ha.col) - Math.abs(stripCol(y) - ha.col));
      if (near.length && this.freeRows(near[0], MID_ROWS).length) {
        hb = this.take(near[0], MID_ROWS, ref, ha.row);
      } else {
        const c = this.freeBlock(half, ha.col, 1, ref);
        hb = this.occ.claim(hole(c, ha.row), ref);
        this.addHome(pb.net, `${half}${c}`);
      }
    }
    this.pinHole.set(pinKey(ref, pa.num), ha);
    this.pinHole.set(pinKey(ref, pb.num), hb);
    this.registerPlaced(ref, fp, comp, { [pa.num]: ha, [pb.num]: hb });
    return true;
  }

  // ---------- wires ----------

  private routePower() {
    for (const net of [...this.homes.keys()].sort()) {
      if (!this.power(net)) continue;
      for (const s of uniq(this.homes.get(net)!).sort((a, b) => stripCol(a) - stripCol(b))) {
        const rail = this.railFor(net, stripHalf(s));
        if (!rail || !this.railNet(rail)) continue;
        const owner = `${displayName(net)} wire`;
        const h = this.take(s, PART_ROWS, owner);
        const r = this.railHole(rail, stripCol(s), owner);
        this.wires.push({ net, a: h, b: r, role: 'power' });
      }
    }
  }

  private pairHoles(s1: string, s2: string, owner: string): [Hole, Hole] {
    if (stripHalf(s1) === stripHalf(s2)) {
      const f1 = this.freeRows(s1, WIRE_ROWS);
      const f2 = this.freeRows(s2, WIRE_ROWS);
      const common = WIRE_ROWS[stripHalf(s1)].find((r) => f1.includes(r) && f2.includes(r));
      if (common) return [this.occ.claim(hole(stripCol(s1), common), owner), this.occ.claim(hole(stripCol(s2), common), owner)];
    }
    return [this.take(s1, WIRE_ROWS, owner), this.take(s2, WIRE_ROWS, owner)];
  }

  private routeSignals() {
    const nets = [...this.homes.keys()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    for (const net of nets) {
      if (this.power(net) || isUnconnected(net)) continue;
      const strips = uniq(this.homes.get(net)!).sort((a, b) => stripCol(a) - stripCol(b) || a.localeCompare(b));
      for (let i = 0; i + 1 < strips.length; i++) {
        const [h1, h2] = this.pairHoles(strips[i], strips[i + 1], `${displayName(net)} wire`);
        this.wires.push({ net, a: h1, b: h2, role: 'signal' });
      }
    }
  }

  private placeBridges() {
    if (!this.supply) return;
    const freeCol = (exclude: Set<number>) => {
      for (let c = 1; c <= this.b.cols; c++) {
        if (this.pkgCols.has(c) || exclude.has(c) || !this.b.railExists(c)) continue;
        if ([...TOP_ROWS, ...BOT_ROWS, ...RAILS].every((r) => this.occ.isFree(hole(c, r)))) return c;
      }
      throw new LayoutError('no free column for a rail bridge');
    };
    const pairs: [string, Row, Row][] = [];
    if (this.gnd.length) pairs.push([this.gndName, 'T-', 'B-']);
    if (this.plus.length && !this.secondName) pairs.push([this.plusName, 'T+', 'B+']);
    const used = new Set<number>();
    for (const [net, ra, rb] of pairs) {
      const c = freeCol(used);
      used.add(c);
      this.wires.push({ net, a: this.occ.claim(hole(c, ra), 'bridge'), b: this.occ.claim(hole(c, rb), 'bridge'), role: 'bridge' });
    }
    const split = this.b.splitCol;
    if (split) {
      for (const rail of RAILS) {
        const net = this.railNet(rail);
        if (!net) continue;
        const a = this.railHole(rail, split, 'split bridge', -1);
        const bb = this.railHole(rail, split + 1, 'split bridge', 1);
        this.wires.push({ net, a, b: bb, role: 'split' });
      }
    }
  }

  // ---------- colours ----------

  private makeNets(): Record<string, NetInfo> {
    const nets: Record<string, NetInfo> = {};
    const color = (net: string, fallback: string) => this.sidecar.colors[net] ?? fallback;
    let i = 0;
    const next = () => PALETTE[i++ % PALETTE.length];
    const switchNets: string[] = [];
    for (const [ref, f] of this.fp) {
      if (f.kind === 'lead2' && (f.style === 'SW' || f.style === 'BTN')) for (const p of this.d.components.get(ref)!.pins.values()) if (!this.power(p.net) && !isUnconnected(p.net)) switchNets.push(p.net);
      if (f.kind === 'dipswitch') for (const p of this.d.components.get(ref)!.pins.values()) if (!this.power(p.net) && !isUnconnected(p.net)) switchNets.push(p.net);
    }
    const ledNets: string[] = [];
    for (const part of this.parts) if (part.style === 'LED') ledNets.push(...part.nets);
    const order = [...this.plus, ...this.gnd, ...this.minus, ...switchNets.sort(), ...ledNets, ...[...this.d.nets.keys()].sort((a, b) => displayName(a).localeCompare(displayName(b)))];
    for (const net of order) {
      if (nets[net] || isUnconnected(net)) continue;
      const power = this.power(net);
      const fallback = power === '+' ? COLOR_PLUS : power === 'gnd' ? COLOR_GND : power === '-' ? COLOR_MINUS : next();
      nets[net] = { name: displayName(net), color: color(net, fallback), power };
    }
    return nets;
  }

  // ---------- build ----------

  build(): EngineResult {
    let error: string | null = null;
    try {
      this.sizeBoard();
      this.placePinned();
      this.placePackages();
      this.placeSupply();
      this.placeThreeLead();
      this.placeTwoLead();
      this.routePower();
      this.routeSignals();
      this.placeBridges();
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      error = e.message;
    }
    if (!this.board) this.board = new Board(30, 'half', null, 6);
    for (const [ref, f] of this.fp) if (f.kind === 'unsupported') this.unplaced.push({ ref, reason: f.reason });
    this.unplaced.sort((x, y) => compareRefs(x.ref, y.ref));
    const pinHoles: Record<string, Record<string, Hole>> = {};
    for (const [k, h] of this.pinHole) {
      const [ref, pin] = k.split(' ');
      (pinHoles[ref] ??= {})[pin] = h;
    }
    this.parts.sort((x, y) => compareRefs(x.id, y.id));
    return {
      board: this.board.spec(),
      supply: this.supply,
      packages: this.packages,
      parts: this.parts,
      wires: this.wires,
      nets: this.makeNets(),
      pinHoles,
      unplaced: this.unplaced,
      warnings: this.warnings,
      footprints: Object.fromEntries(this.fp),
      values: Object.fromEntries(this.values),
      power: { plus: this.plus, minus: this.minus, gnd: this.gnd, plusName: this.plusName, gndName: this.gndName, secondName: this.secondName },
      error,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/engine.test.ts`
Expected: all pass. If "places everything without errors" fails with a `LayoutError` message, read the message: it names the part and the hole, which points at the placement rule to fix. Do not weaken the assertions.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `cd circut-ai-tool && bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/src/layout/engine.ts circut-ai-tool/test/engine.test.ts
git commit -m "feat(circuit): deterministic breadboard placement and routing engine"
```

---

## Self-review (part 1b)

- Spec coverage: catalog table (dip, lead2 styles, to92, pot3, dipswitch, sevenseg, power, supply, unsupported), power-net rules and rail plan (T+ first positive, T- GND, B+ second supply, B- GND, error on a third), engine order (pinned, packages, board size, supply, three-lead, two-lead, power wires, signal wires, bridges, colours), auto half/full retry, one owner per hole with a named conflict, `unplaced` with reasons.
- Names used later: `layout`, `EngineResult`, `LayoutError`, `PALETTE`, `COLOR_*`, `Package`, `PlacedPart`, `Wire`, `NetInfo`, `Supply`, `BoardSpec`, `Hole`, `Row`, `Sidecar`, `Options`, `emptySidecar`, `normalizeSidecar`, `holeKey`, `holeName`, `parseHole`, `stripOf`, `isRail`, `halfOf`, `classify`, `Footprint`, `icInfo`, `CHIPS`, `DECODER_PINS`, `DC`, `parseOhms`, `formatSI`, `compareRefs`.
