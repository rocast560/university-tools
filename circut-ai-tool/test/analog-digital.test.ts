import { describe, expect, test } from 'bun:test';
import { DRIVE, driveOf, inputLoad, readLevel } from '../src/sim/analog/digital.ts';

describe('readLevel', () => {
  test('a clear high and a clear low read as 1 and 0', () => {
    expect(readLevel(2.5, 5, 'LS', 0)).toBe(1);
    expect(readLevel(0.4, 5, 'LS', 1)).toBe(0);
  });

  test('the indeterminate band holds the previous level', () => {
    // A 74LS input between Vil (0.8) and Vih (2.0) is undefined. Holding the
    // last level is what lets an RS latch settle into the state it is in
    // rather than flapping.
    expect(readLevel(1.5, 5, 'LS', 1)).toBe(1);
    expect(readLevel(1.5, 5, 'LS', 0)).toBe(0);
  });

  test('an open TTL input floats high, matching the boolean simulator', () => {
    // src/sim/index.ts uses `L[net] ?? 1` with the comment "an open TTL input
    // reads high". A pin left truly floating settles near Vcc through the
    // input's own leakage, so the two engines must agree.
    expect(readLevel(5, 5, 'LS', 0)).toBe(1);
  });

  test('CMOS thresholds scale with the supply', () => {
    // HC switches at 0.3/0.7 of Vcc, so the same 3.0 V is a solid high on a
    // 3.3 V rail (Vih 2.31) but still inside the undefined band on a 5 V one
    // (Vih 3.5), where it holds the previous level. A fixed TTL threshold
    // would call both of them high and get 3.3 V logic wrong.
    expect(readLevel(3.0, 3.3, 'HC', 0)).toBe(1);
    expect(readLevel(3.0, 5, 'HC', 0)).toBe(0);
    expect(readLevel(1.0, 5, 'HC', 1)).toBe(0);
    expect(readLevel(4.0, 5, 'HC', 0)).toBe(1);
  });
});

describe('driveOf', () => {
  test('a low output sits near ground behind a small resistance', () => {
    const d = driveOf(0, 'LS', 5);
    expect(d.volts).toBeCloseTo(DRIVE.LS.vol, 6);
    expect(d.rout).toBeCloseTo(DRIVE.LS.rol, 6);
    // Sinking 8 mA must stay inside the 0.5 V Vol spec.
    expect(d.volts + d.rout * 0.008).toBeLessThan(0.5);
  });

  test('a high output sits well above the 2.7V spec at rated load', () => {
    const d = driveOf(1, 'LS', 5);
    expect(d.volts - d.rout * 0.0004).toBeGreaterThan(2.7);
  });

  test('a CMOS output pulls all the way to its supply rails', () => {
    expect(driveOf(1, 'HC', 5).volts).toBeCloseTo(5, 6);
    expect(driveOf(1, 'HC', 3.3).volts).toBeCloseTo(3.3, 6);
    expect(driveOf(0, 'HC', 5).volts).toBeCloseTo(0, 6);
  });
});

describe('inputLoad', () => {
  test('an LS input pulled to ground sources its datasheet Iil back out', () => {
    // 5 V across the input resistance is the 0.4 mA an LS input pushes into
    // whatever is holding it low. This is why TTL needs a stiff pull-down.
    expect(5 / inputLoad('LS').ohmsToVcc).toBeCloseTo(0.4e-3, 6);
  });

  test('an LS input sitting at the rail carries essentially nothing', () => {
    expect((5 - 5) / inputLoad('LS').ohmsToVcc).toBeCloseTo(0, 9);
  });

  test('a floating LS input drifts up to the rail and reads high', () => {
    // Nothing else touches the node, so it sits at Vcc. The boolean simulator
    // says the same thing with `L[net] ?? 1`, and the two must agree.
    expect(readLevel(5, 5, 'LS', 0)).toBe(1);
  });

  test('a CMOS input is effectively open', () => {
    expect(5 / inputLoad('HC').ohmsToVcc).toBeLessThan(1e-6);
  });

  test('three LS loads against a 1k pull-up still read as a solid high', () => {
    const g = 3 / inputLoad('LS').ohmsToVcc + 1 / 1000;
    // Everything pulls to the same 5 V rail, so the node sits at the rail.
    expect((5 * g) / g).toBeCloseTo(5, 9);
  });
});
