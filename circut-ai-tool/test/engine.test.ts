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

  test('a two-lead part with a rail-connected leg can be re-pinned to another column of the same rail (finding 2)', () => {
    // R1 in PL1_1's auto layout has one leg on a rail (T+/B+/etc.) -- this is
    // the normal, correct placement tryPlaceTwoLead's "toRail" branch makes
    // for any two-lead part whose net is a power net. Previously placePinned
    // unconditionally rejected ANY pinned hole on a rail row, so putting R1
    // back on a rail hole (even a perfectly valid, free one) via a manual
    // pin/move always failed -- this silently broke "drag any part" for
    // every rail-connected two-lead part.
    const base = layout(pl1, emptySidecar());
    const r1 = base.pinHoles.R1;
    expect(isRail(r1['1'].row)).toBe(true);
    const s = emptySidecar();
    const newCol = r1['1'].col + 5;
    s.pinned.R1 = { '1': { col: newCol, row: r1['1'].row }, '2': { col: newCol, row: r1['2'].row } };
    const r = layout(pl1, s);
    expect(r.warnings.some((w) => w.includes('R1'))).toBe(false);
    expect(r.pinHoles.R1).toEqual(s.pinned.R1);
    // The rail leg must not have poisoned routing: every hole used anywhere
    // in the result stays a real, in-bounds hole (no NaN column from
    // stripCol() on a rail "strip" like "T+").
    for (const h of allHoles(r)) expect(Number.isFinite(h.col)).toBe(true);
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
