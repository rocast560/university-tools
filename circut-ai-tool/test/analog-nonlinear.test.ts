import { describe, expect, test } from 'bun:test';
import type { Device } from '../src/sim/analog/dc.ts';
import { diodeFor, operatingPoint } from '../src/sim/analog/nonlinear.ts';

const psu = (volts = 5): Device => ({ kind: 'vsource', ref: 'PSU', pos: 'VCC', neg: 'GND', volts });
const res = (ref: string, a: string, b: string, ohms: number): Device => ({ kind: 'resistor', ref, a, b, ohms });

describe('operatingPoint', () => {
  test('a forward-biased silicon diode drops roughly 0.7 V', () => {
    const d = diodeFor('1N4148');
    const r = operatingPoint([psu(), res('R1', 'VCC', 'A', 1000), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    expect(r.nodes.A).toBeGreaterThan(0.55);
    expect(r.nodes.A).toBeLessThan(0.8);
    // The rest of the 5 V is across the 1k, so ~4.3 mA.
    expect(r.currents.D1).toBeCloseTo((5 - r.nodes.A) / 1000, 6);
  });

  test('a reverse-biased diode blocks', () => {
    const d = diodeFor('1N4148');
    const r = operatingPoint([psu(), res('R1', 'VCC', 'A', 1000), { ...d, ref: 'D1', anode: 'GND', cathode: 'A' }], 'GND')!;
    expect(r.currents.D1).toBeLessThan(1e-6);
    expect(r.nodes.A).toBeCloseTo(5, 3);
  });

  test('a red LED behind 330R from 5V runs near 10 mA and lights up', () => {
    const d = diodeFor('LED_Red');
    const r = operatingPoint([psu(), res('R3', 'VCC', 'A', 330), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    expect(r.currents.D1).toBeGreaterThan(0.008);
    expect(r.currents.D1).toBeLessThan(0.011);
    expect(r.nodes.A).toBeGreaterThan(1.6);
    expect(r.nodes.A).toBeLessThan(2.0);
    expect(r.brightness.D1).toBeGreaterThan(0.5);
  });

  test('a bigger series resistor makes the same LED dimmer', () => {
    const d = diodeFor('LED_Red');
    const dim = operatingPoint([psu(), res('R', 'VCC', 'A', 2200), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    const bright = operatingPoint([psu(), res('R', 'VCC', 'A', 330), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    expect(dim.currents.D1).toBeLessThan(bright.currents.D1);
    expect(dim.brightness.D1).toBeLessThan(bright.brightness.D1);
    expect(dim.brightness.D1).toBeGreaterThan(0);
  });

  test('an LED straight across the supply is flagged as overcurrent', () => {
    const d = diodeFor('LED_Red');
    const r = operatingPoint([psu(), { ...d, ref: 'D2', anode: 'VCC', cathode: 'GND' }], 'GND')!;
    expect(r.currents.D2).toBeGreaterThan(0.02);
    expect(r.faults.some((f) => f.ref === 'D2' && f.kind === 'led-overcurrent')).toBe(true);
  });

  test('a correctly limited LED raises no fault', () => {
    const d = diodeFor('LED_Red');
    const r = operatingPoint([psu(), res('R3', 'VCC', 'A', 330), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    expect(r.faults).toEqual([]);
  });

  test('a blue LED needs more forward voltage than a red one', () => {
    const rig = (value: string) => operatingPoint([psu(), res('R', 'VCC', 'A', 330), { ...diodeFor(value), ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
    expect(rig('LED_Blue').nodes.A).toBeGreaterThan(rig('LED_Red').nodes.A + 0.8);
  });

  test('every colour actually conducts and lights behind 330R', () => {
    // Guards the Shockley exponent clamp. Blue/white/UV run at a much higher
    // n*Vt than the red family, so a clamp tuned for red silently caps their
    // junction below the voltage they need and they read as nearly open.
    for (const value of ['LED_Red', 'LED_Green', 'LED_Yellow', 'LED_Blue', 'LED_White']) {
      const d = diodeFor(value);
      const r = operatingPoint([psu(), res('R', 'VCC', 'A', 330), { ...d, ref: 'D1', anode: 'A', cathode: 'GND' }], 'GND')!;
      expect(r.converged).toBe(true);
      expect(r.currents.D1).toBeGreaterThan(0.002);
      expect(r.brightness.D1).toBeGreaterThan(0.2);
      // The LED must not eat nearly the whole supply.
      expect(r.nodes.A).toBeLessThan(3.6);
      expect(r.iterations).toBeLessThan(30);
    }
  });
});
