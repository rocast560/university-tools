import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildSimModel, simulate } from '../src/sim/index.ts';
import { buildAnalogModel } from '../src/sim/analog/model.ts';
import { solveMixed } from '../src/sim/analog/mixed.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const res = layout(design, emptySidecar());
const boolModel = buildSimModel(design, res);

/** PL1_1's inputs are active-low: an open switch leaves the net pulled high. */
const combos: { SW1: boolean; SW2: boolean; a: 0 | 1; b: 0 | 1 }[] = [
  { SW1: false, SW2: false, a: 1, b: 1 },
  { SW1: true, SW2: false, a: 0, b: 1 },
  { SW1: false, SW2: true, a: 1, b: 0 },
  { SW1: true, SW2: true, a: 0, b: 0 },
];

describe('solveMixed on PL1_1', () => {
  test('the supply rails sit where the power supply puts them', () => {
    const model = buildAnalogModel(design, res);
    const out = solveMixed(model)!;
    expect(out.nodes[model.nodeOfNet['+5V']]).toBeCloseTo(5, 3);
    expect(out.nodes[model.nodeOfNet['GND']]).toBeCloseTo(0, 9);
  });

  test('an open switch leaves its input pulled up near the rail', () => {
    // 1k pull-up against three 74LS inputs at 20 uA each.
    const model = buildAnalogModel(design, res, { SW1: false });
    const out = solveMixed(model)!;
    const v = out.nodes[model.nodeOfNet['/A']];
    expect(v).toBeGreaterThan(4.7);
    expect(v).toBeLessThan(5.01);
  });

  test('a closed switch pulls its input down to a solid low', () => {
    const model = buildAnalogModel(design, res, { SW1: true });
    const out = solveMixed(model)!;
    expect(out.nodes[model.nodeOfNet['/A']]).toBeLessThan(0.4);
  });

  test('it agrees with the boolean simulator on every input row', () => {
    // The load-bearing test of the whole engine. A wrong pinout, threshold,
    // polarity or Thevenin sign shows up here and nowhere else.
    for (const c of combos) {
      const levels = { '/A': c.a, '/B': c.b } as Record<string, 0 | 1>;
      const want = simulate(boolModel, levels);
      const model = buildAnalogModel(design, res, { SW1: c.SW1, SW2: c.SW2 });
      const got = solveMixed(model)!;
      expect(got.converged).toBe(true);
      for (const net of ['/Y1', '/Y2']) {
        expect({ net, combo: c, level: got.levels[model.nodeOfNet[net]] }).toEqual({ net, combo: c, level: want.nets[net] });
      }
      for (const ref of ['D1', 'D2']) {
        expect({ ref, combo: c, lit: (got.brightness[ref] ?? 0) > 0 }).toEqual({ ref, combo: c, lit: want.leds[ref] });
      }
    }
  });

  test('a lit LED draws a real, sane current', () => {
    // A = 1, B = 0 -> XOR high -> D1 on through R3 (330R) from a 74LS output.
    const model = buildAnalogModel(design, res, { SW1: false, SW2: true });
    const out = solveMixed(model)!;
    const lit = ['D1', 'D2'].find((r) => (out.brightness[r] ?? 0) > 0)!;
    expect(lit).toBeDefined();
    expect(out.currents[lit]).toBeGreaterThan(0.002);
    expect(out.currents[lit]).toBeLessThan(0.02);
    expect(out.brightness[lit]).toBeGreaterThan(0.3);
  });

  test('a dark LED carries essentially nothing', () => {
    // Both inputs equal, so both XOR outputs are low and neither LED is lit.
    const model = buildAnalogModel(design, res, { SW1: true, SW2: true });
    const out = solveMixed(model)!;
    for (const ref of ['D1', 'D2']) {
      expect(out.brightness[ref]).toBe(0);
      expect(out.currents[ref]).toBeLessThan(5e-4);
    }
  });

  test('every 74xx chip is modelled now, so nothing is left over', () => {
    const model = buildAnalogModel(design, res);
    expect(model.notModelled).toEqual([]);
  });

  test('it raises no overcurrent fault on a correctly built board', () => {
    for (const c of combos) {
      const model = buildAnalogModel(design, res, { SW1: c.SW1, SW2: c.SW2 });
      expect(solveMixed(model)!.faults.filter((f) => f.level === 'error')).toEqual([]);
    }
  });
});
