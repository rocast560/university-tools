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
