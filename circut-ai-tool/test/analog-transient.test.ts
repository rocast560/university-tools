import { describe, expect, test } from 'bun:test';
import type { Device } from '../src/sim/analog/dc.ts';
import { createReactiveState, sourceValue, stepTransient, type SourceSpec } from '../src/sim/analog/transient.ts';

const psu = (volts = 5): Device => ({ kind: 'vsource', ref: 'PSU', pos: 'VCC', neg: 'GND', volts });

/** 5 V through 10k into 10uF: tau = 0.1 s. */
const rc = (): Device[] => [psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'C', ohms: 10000 }, { kind: 'capacitor', ref: 'C1', a: 'C', b: 'GND', farads: 10e-6 }];

describe('sourceValue', () => {
  test('a dc source ignores time', () => {
    expect(sourceValue({ wave: 'dc', volts: 5 }, 0)).toBe(5);
    expect(sourceValue({ wave: 'dc', volts: 5 }, 12.5)).toBe(5);
  });

  test('a clock spends half its period high at 50% duty', () => {
    const clk: SourceSpec = { wave: 'clock', hz: 10, duty: 0.5, low: 0, high: 5 };
    expect(sourceValue(clk, 0.01)).toBeCloseTo(5, 6);
    expect(sourceValue(clk, 0.06)).toBeCloseTo(0, 6);
    expect(sourceValue(clk, 0.11)).toBeCloseTo(5, 6);
  });

  test('duty shifts where the clock falls', () => {
    const clk: SourceSpec = { wave: 'clock', hz: 1, duty: 0.25, low: 0, high: 5 };
    expect(sourceValue(clk, 0.2)).toBeCloseTo(5, 6);
    expect(sourceValue(clk, 0.3)).toBeCloseTo(0, 6);
  });
});

describe('stepTransient: RC charging', () => {
  test('matches the backward-Euler closed form exactly', () => {
    // Backward Euler on this circuit gives Vc(n) = 5*(1 - (1/(1+h/tau))^n)
    // in closed form. Asserting against that rather than against the analytic
    // exponential tests the integrator itself, not the step size.
    const devices = rc();
    const state = createReactiveState(devices);
    const h = 0.01;
    for (let i = 0; i < 10; i++) stepTransient(devices, 'GND', state, h);
    const closedForm = 5 * (1 - Math.pow(1 / (1 + h / 0.1), 10));
    expect(state.capV.C1).toBeCloseTo(closedForm, 9);
    expect(closedForm).toBeCloseTo(3.0723, 4);
  });

  test('converges on the analytic exponential as the step shrinks', () => {
    const devices = rc();
    const state = createReactiveState(devices);
    const h = 0.1 / 1000;
    for (let i = 0; i < 1000; i++) stepTransient(devices, 'GND', state, h);
    // One time constant: 5*(1 - 1/e) = 3.1606.
    expect(state.capV.C1).toBeCloseTo(3.1606, 2);
  });

  test('reaches the rail after five time constants', () => {
    const devices = rc();
    const state = createReactiveState(devices);
    for (let i = 0; i < 5000; i++) stepTransient(devices, 'GND', state, 0.1 / 1000);
    expect(state.capV.C1).toBeGreaterThan(4.96);
    expect(state.capV.C1).toBeLessThan(5.001);
  });

  test('a charged capacitor discharges through its resistor', () => {
    const devices: Device[] = [{ kind: 'resistor', ref: 'R1', a: 'C', b: 'GND', ohms: 10000 }, { kind: 'capacitor', ref: 'C1', a: 'C', b: 'GND', farads: 10e-6 }];
    const state = createReactiveState(devices);
    state.capV.C1 = 5;
    for (let i = 0; i < 1000; i++) stepTransient(devices, 'GND', state, 0.1 / 1000);
    // 5/e = 1.839.
    expect(state.capV.C1).toBeCloseTo(1.839, 2);
  });

  test('a bigger capacitor charges more slowly', () => {
    const run = (farads: number) => {
      const devices: Device[] = [psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'C', ohms: 10000 }, { kind: 'capacitor', ref: 'C1', a: 'C', b: 'GND', farads }];
      const state = createReactiveState(devices);
      for (let i = 0; i < 100; i++) stepTransient(devices, 'GND', state, 1e-4);
      return state.capV.C1;
    };
    expect(run(100e-6)).toBeLessThan(run(10e-6));
  });
});

describe('stepTransient: inductors', () => {
  test('current ramps towards V/R with the right time constant', () => {
    // 5 V, 100 ohm, 100 mH: tau = L/R = 1 ms, final current 50 mA.
    const devices: Device[] = [psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'L', ohms: 100 }, { kind: 'inductor', ref: 'L1', a: 'L', b: 'GND', henries: 100e-3 }];
    const state = createReactiveState(devices);
    const h = 1e-3 / 500;
    for (let i = 0; i < 500; i++) stepTransient(devices, 'GND', state, h);
    // At t = tau the current is 50 mA * (1 - 1/e) = 31.6 mA.
    expect(state.indI.L1).toBeGreaterThan(0.029);
    expect(state.indI.L1).toBeLessThan(0.034);
  });

  test('an inductor opposes current at the first instant', () => {
    const devices: Device[] = [psu(), { kind: 'resistor', ref: 'R1', a: 'VCC', b: 'L', ohms: 100 }, { kind: 'inductor', ref: 'L1', a: 'L', b: 'GND', henries: 100e-3 }];
    const state = createReactiveState(devices);
    const out = stepTransient(devices, 'GND', state, 1e-6)!;
    // Almost the whole supply appears across the inductor, not the resistor.
    expect(out.nodes.L).toBeGreaterThan(4.9);
  });
});

describe('stepTransient: time-varying sources', () => {
  test('a clock source swings the node it drives', () => {
    const devices: Device[] = [
      { kind: 'vsource', ref: 'CLK', pos: 'OUT', neg: 'GND', volts: 0, source: { wave: 'clock', hz: 10, duty: 0.5, low: 0, high: 5 } },
      { kind: 'resistor', ref: 'R1', a: 'OUT', b: 'GND', ohms: 1000 },
    ];
    const state = createReactiveState(devices);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const out = stepTransient(devices, 'GND', state, 1e-3)!;
      seen.add(Math.round(out.nodes.OUT));
    }
    expect([...seen].sort()).toEqual([0, 5]);
  });

  test('an RC fed from a clock never quite reaches either rail', () => {
    const devices: Device[] = [
      { kind: 'vsource', ref: 'CLK', pos: 'IN', neg: 'GND', volts: 0, source: { wave: 'clock', hz: 100, duty: 0.5, low: 0, high: 5 } },
      { kind: 'resistor', ref: 'R1', a: 'IN', b: 'C', ohms: 10000 },
      { kind: 'capacitor', ref: 'C1', a: 'C', b: 'GND', farads: 1e-6 },
    ];
    const state = createReactiveState(devices);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2000; i++) {
      stepTransient(devices, 'GND', state, 1e-5);
      if (i > 1000) {
        min = Math.min(min, state.capV.C1);
        max = Math.max(max, state.capV.C1);
      }
    }
    expect(max).toBeLessThan(4.9);
    expect(min).toBeGreaterThan(0.1);
    expect(max - min).toBeGreaterThan(0.5);
  });
});
