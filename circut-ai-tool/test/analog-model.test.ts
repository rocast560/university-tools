import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';
import { buildAnalogModel } from '../src/sim/analog/model.ts';
import { solveDC } from '../src/sim/analog/dc.ts';
import { operatingPoint } from '../src/sim/analog/nonlinear.ts';

const R = (value: string, a: string, b: string) => ({ lib: 'Device', part: 'R', value, pins: { '1': ['1', 'passive', a] as [string, string, string], '2': ['2', 'passive', b] as [string, string, string] } });

describe('buildAnalogModel', () => {
  test('solves a divider laid out on a real breadboard', () => {
    const design = makeDesign({ R1: R('1k', '+5V', '/MID'), R2: R('1k', '/MID', 'GND') });
    const res = layout(design, emptySidecar());
    const model = buildAnalogModel(design, res);
    const out = solveDC(model.devices, model.ground)!;
    expect(out).not.toBeNull();
    // R1.2 and R2.1 share a breadboard strip, so they are one node at 2.5 V.
    expect(model.pinNodes.R1['2']).toBe(model.pinNodes.R2['1']);
    expect(out.nodes[model.pinNodes.R1['2']]).toBeCloseTo(2.5, 6);
    expect(out.nodes[model.pinNodes.R1['1']]).toBeCloseTo(5, 6);
    expect(out.nodes[model.pinNodes.R2['2']]).toBeCloseTo(0, 6);
  });

  test('reads the real resistor values, not just the topology', () => {
    // 3k over 3k+1k of 5V -> 1.25 V at the tap.
    const design = makeDesign({ R1: R('3k', '+5V', '/MID'), R2: R('1k', '/MID', 'GND') });
    const res = layout(design, emptySidecar());
    const model = buildAnalogModel(design, res);
    const out = solveDC(model.devices, model.ground)!;
    expect(out.nodes[model.pinNodes.R1['2']]).toBeCloseTo(1.25, 6);
  });
});

describe('buildAnalogModel switches', () => {
  const design = makeDesign({
    SW1: { lib: 'Switch', part: 'SW_SPST', value: 'SW_SPST', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/MID'] } },
    R1: R('1k', '/MID', 'GND'),
  });
  const res = layout(design, emptySidecar());

  test('an open switch leaves the load at ground', () => {
    const model = buildAnalogModel(design, res, {});
    const out = solveDC(model.devices, model.ground)!;
    expect(out.nodes[model.pinNodes.R1['1']]).toBeCloseTo(0, 6);
  });

  test('closing the switch pulls the load up to the supply', () => {
    const model = buildAnalogModel(design, res, { SW1: true });
    const out = solveDC(model.devices, model.ground)!;
    expect(out.nodes[model.pinNodes.R1['1']]).toBeCloseTo(5, 3);
  });
});

describe('buildAnalogModel on the PL1_1 fixture', () => {
  const design = parseNetlist(readFixture('PL1_1.net'));
  const res = layout(design, emptySidecar());
  const model = buildAnalogModel(design, res);

  test('finds a 5V supply referenced to ground', () => {
    const supply = model.devices.find((d) => d.kind === 'vsource')!;
    expect(supply).toBeDefined();
    expect(supply.kind === 'vsource' && supply.volts).toBe(5);
    expect(supply.kind === 'vsource' && supply.neg).toBe(model.ground);
  });

  test('models all four resistors with their real values', () => {
    const ohms = Object.fromEntries(model.devices.filter((d) => d.kind === 'resistor').map((d) => [d.ref, d.kind === 'resistor' ? d.ohms : 0]));
    expect(ohms).toEqual({ R1: 1000, R2: 1000, R3: 330, R4: 330 });
  });

  test('models both switches and reports the parts it cannot do yet', () => {
    expect(model.devices.filter((d) => d.kind === 'switch').map((d) => d.ref).sort()).toEqual(['SW1', 'SW2']);
    // The 74xx chips arrive in phase 3.
    expect(model.notModelled.sort()).toEqual(['U1 (74LS86)', 'U2 (74LS04)', 'U3 (74LS00)']);
  });

  test('the board as wired solves without a singular matrix', () => {
    const out = operatingPoint(model.devices, model.ground);
    expect(out).not.toBeNull();
    expect(out!.converged).toBe(true);
    // Both LEDs hang off 74xx outputs, which are not modelled until phase 3,
    // so nothing drives them yet and they must read dark rather than NaN.
    expect(Number.isFinite(out!.nodes[model.pinNodes.D1['2']])).toBe(true);
    expect(out!.brightness.D1).toBe(0);
  });
});

describe('buildAnalogModel LEDs', () => {
  test('a 330R and an LED laid out on the board draw a real current', () => {
    const design = makeDesign({
      R3: R('330', '+5V', '/MID'),
      D1: { lib: 'Device', part: 'LED', value: 'LED_Red', pins: { '1': ['K', 'passive', 'GND'], '2': ['A', 'passive', '/MID'] } },
    });
    const res = layout(design, emptySidecar());
    const model = buildAnalogModel(design, res);
    expect(model.notModelled).toEqual([]);
    const out = operatingPoint(model.devices, model.ground)!;
    expect(out.converged).toBe(true);
    expect(out.currents.D1).toBeGreaterThan(0.009);
    expect(out.currents.D1).toBeLessThan(0.011);
    expect(out.brightness.D1).toBeGreaterThan(0.7);
    expect(out.faults).toEqual([]);
  });

  test('the same LED with no series resistor is flagged', () => {
    const design = makeDesign({
      D1: { lib: 'Device', part: 'LED', value: 'LED_Red', pins: { '1': ['K', 'passive', 'GND'], '2': ['A', 'passive', '+5V'] } },
    });
    const res = layout(design, emptySidecar());
    const model = buildAnalogModel(design, res);
    const out = operatingPoint(model.devices, model.ground)!;
    expect(out.faults.some((f) => f.kind === 'led-overcurrent' && f.ref === 'D1')).toBe(true);
    expect(out.faults[0].message).toMatch(/add ~\d+R in series/);
  });

  test('a reversed LED stays dark', () => {
    const design = makeDesign({
      R3: R('330', '+5V', '/MID'),
      D1: { lib: 'Device', part: 'LED', value: 'LED_Red', pins: { '1': ['K', 'passive', '/MID'], '2': ['A', 'passive', 'GND'] } },
    });
    const res = layout(design, emptySidecar());
    const model = buildAnalogModel(design, res);
    const out = operatingPoint(model.devices, model.ground)!;
    expect(out.brightness.D1).toBe(0);
  });
});
