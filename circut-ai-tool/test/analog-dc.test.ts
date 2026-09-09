import { describe, expect, test } from 'bun:test';
import { solveDC, type Device } from '../src/sim/analog/dc.ts';

const psu = (volts = 5): Device => ({ kind: 'vsource', ref: 'PSU', pos: 'VCC', neg: 'GND', volts });

describe('solveDC', () => {
  test('splits a 5V supply evenly across two equal resistors', () => {
    const r = solveDC([psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'MID', ohms: 1000 }, { kind: 'resistor', ref: 'R2', a: 'MID', b: 'GND', ohms: 1000 }], 'GND')!;
    expect(r.nodes.VCC).toBeCloseTo(5, 9);
    expect(r.nodes.MID).toBeCloseTo(2.5, 9);
    expect(r.nodes.GND).toBeCloseTo(0, 9);
  });

  test('divides in proportion to the resistor values', () => {
    // 1k over 1k+3k of 8V -> 2V at the tap.
    const r = solveDC([{ kind: 'vsource', ref: 'PSU', pos: 'VCC', neg: 'GND', volts: 8 }, { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'MID', ohms: 3000 }, { kind: 'resistor', ref: 'R2', a: 'MID', b: 'GND', ohms: 1000 }], 'GND')!;
    expect(r.nodes.MID).toBeCloseTo(2, 9);
  });

  test('reports supply current flowing out of the positive terminal', () => {
    // 5V across 2k in series -> 2.5 mA delivered.
    const r = solveDC([psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'MID', ohms: 1000 }, { kind: 'resistor', ref: 'R2', a: 'MID', b: 'GND', ohms: 1000 }], 'GND')!;
    expect(r.currents.PSU).toBeCloseTo(0.0025, 9);
  });

  test('two equal resistors in parallel halve the resistance', () => {
    // 5V across 1k || 1k = 500R -> 10 mA.
    const r = solveDC([psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'GND', ohms: 1000 }, { kind: 'resistor', ref: 'R2', a: 'VCC', b: 'GND', ohms: 1000 }], 'GND')!;
    expect(r.currents.PSU).toBeCloseTo(0.01, 9);
  });

  test('an open switch stops the current, a closed one passes it', () => {
    const rig = (closed: boolean) =>
      solveDC([psu(), { kind: 'switch', ref: 'SW1', a: 'VCC', b: 'MID', closed }, { kind: 'resistor', ref: 'R1', a: 'MID', b: 'GND', ohms: 1000 }], 'GND')!;
    const open = rig(false);
    expect(open.nodes.MID).toBeCloseTo(0, 6);
    expect(open.currents.PSU).toBeCloseTo(0, 6);
    const shut = rig(true);
    expect(shut.nodes.MID).toBeCloseTo(5, 3);
    expect(shut.currents.PSU).toBeCloseTo(0.005, 5);
  });

  test('a current source pushes its current through the load', () => {
    // 1 mA into a 2k resistor to ground -> 2 V.
    const r = solveDC([{ kind: 'isource', ref: 'I1', from: 'GND', to: 'OUT', amps: 0.001 }, { kind: 'resistor', ref: 'R1', a: 'OUT', b: 'GND', ohms: 2000 }], 'GND')!;
    expect(r.nodes.OUT).toBeCloseTo(2, 9);
  });

  test('a floating island does not make the system unsolvable', () => {
    // ORPHAN_A/ORPHAN_B touch nothing else: without a gmin leak to ground
    // their block of the matrix is singular and the whole solve fails.
    const r = solveDC([psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'GND', ohms: 1000 }, { kind: 'resistor', ref: 'R9', a: 'ORPHAN_A', b: 'ORPHAN_B', ohms: 1000 }], 'GND');
    expect(r).not.toBeNull();
    expect(r!.nodes.VCC).toBeCloseTo(5, 9);
    expect(r!.nodes.ORPHAN_A).toBeCloseTo(0, 6);
  });
});
