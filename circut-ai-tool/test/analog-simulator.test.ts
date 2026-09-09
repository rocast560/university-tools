import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { buildAnalogModel } from '../src/sim/analog/model.ts';
import { Simulator } from '../src/sim/analog/simulator.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const res = layout(design, emptySidecar());
const fresh = () => new Simulator(buildAnalogModel(design, res));

describe('Simulator on PL1_1', () => {
  test('solves an operating point as soon as it is constructed', () => {
    const s = fresh().state();
    expect(s.converged).toBe(true);
    expect(s.netVolts['+5V']).toBeCloseTo(5, 3);
    expect(s.netVolts.GND).toBeCloseTo(0, 9);
  });

  test('flipping a switch changes the board without rebuilding the model', () => {
    const sim = fresh();
    expect(sim.solveDC().netVolts.A).toBeGreaterThan(4.7);
    sim.setSwitch('SW1', true);
    expect(sim.solveDC().netVolts.A).toBeLessThan(0.4);
    sim.setSwitch('SW1', false);
    expect(sim.solveDC().netVolts.A).toBeGreaterThan(4.7);
  });

  test('an XOR input change lights an LED with a real current', () => {
    const sim = fresh();
    sim.setSwitch('SW1', true);
    const on = sim.solveDC();
    expect(on.leds.D1).toBe(true);
    expect(on.currents.D1).toBeGreaterThan(0.005);
    expect(on.brightness.D1).toBeGreaterThan(0.5);
    sim.setSwitch('SW2', true);
    const off = sim.solveDC();
    expect(off.leds.D1).toBe(false);
    expect(off.brightness.D1).toBe(0);
  });

  test('it reports resistor current and power dissipation', () => {
    const sim = fresh();
    sim.setSwitch('SW1', true);
    const s = sim.solveDC();
    // R3 is the 330R feeding D1: about 8.8 mA and 25 mW.
    expect(s.currents.R3).toBeGreaterThan(0.006);
    expect(s.power.R3).toBeGreaterThan(0.01);
    expect(s.power.R3).toBeLessThan(0.1);
  });

  test('stepping advances the clock and stays converged', () => {
    const sim = fresh();
    const t0 = sim.state().time;
    for (let i = 0; i < 10; i++) sim.step(1 / 60);
    const s = sim.state();
    expect(s.time).toBeGreaterThan(t0);
    expect(s.time).toBeCloseTo(10 / 60, 6);
    expect(s.converged).toBe(true);
  });

  test('a purely resistive board holds the same answer while it runs', () => {
    const sim = fresh();
    sim.setSwitch('SW1', true);
    const before = sim.solveDC().currents.D1;
    for (let i = 0; i < 5; i++) sim.step(1 / 60);
    expect(sim.state().currents.D1).toBeCloseTo(before, 6);
  });

  test('reset returns it to power-up', () => {
    const sim = fresh();
    sim.step(1);
    expect(sim.state().time).toBeGreaterThan(0);
    sim.reset();
    expect(sim.state().time).toBe(0);
  });

  test('a board with no reactive parts needs no sub-stepping', () => {
    // Nothing here varies with time, so one solve per frame is the exact
    // answer rather than a coarse one. Getting this wrong costs an order of
    // magnitude: a fixed 1 ms ceiling made a frame take 17 solves and 34 ms.
    expect(buildAnalogModel(design, res).dtMax).toBe(Infinity);
  });

  test('a capacitor forces a step fine enough to resolve its curve', () => {
    const rc = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/C'] } },
      C1: { lib: 'Device', part: 'C', value: '10u', pins: { '1': ['1', 'passive', '/C'], '2': ['2', 'passive', 'GND'] } },
    });
    const model = buildAnalogModel(rc, layout(rc, emptySidecar()));
    // tau = 10k * 10uF = 0.1 s, and we want about 20 steps across it.
    expect(model.dtMax).toBeGreaterThan(0);
    expect(model.dtMax).toBeLessThan(0.01);
  });

  test('a frame steps fast enough to run in real time', () => {
    const sim = fresh();
    sim.step(1 / 60);
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    const perFrame = (performance.now() - t0) / 30;
    // Measured at ~3 ms. The ceiling is loose enough not to flake on a busy
    // machine and tight enough to catch losing the dtMax shortcut.
    expect(perFrame).toBeLessThan(16);
  });
});
