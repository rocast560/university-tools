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
