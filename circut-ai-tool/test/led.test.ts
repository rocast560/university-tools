import { describe, expect, test } from 'bun:test';
import { ledSpec } from '../src/parts/led.ts';

describe('ledSpec', () => {
  test('defaults to red, matching the colour the board has always drawn', () => {
    expect(ledSpec('LED').key).toBe('red');
  });

  test('reads a colour word out of a KiCad symbol name', () => {
    expect(ledSpec('LED_Blue').key).toBe('blue');
    expect(ledSpec('LED_Green').key).toBe('green');
    expect(ledSpec('LED_Yellow').key).toBe('yellow');
  });

  test('is case insensitive and matches a bare colour', () => {
    expect(ledSpec('green').key).toBe('green');
    expect(ledSpec('WHITE').key).toBe('white');
  });

  test('blue and white need a higher forward voltage than red', () => {
    expect(ledSpec('LED_Red').vf).toBeLessThan(2.4);
    expect(ledSpec('LED_Blue').vf).toBeGreaterThan(2.8);
    expect(ledSpec('LED_White').vf).toBeGreaterThan(2.8);
  });

  test('reads a wavelength', () => {
    expect(ledSpec('LED 660nm').key).toBe('red');
    expect(ledSpec('LED 525 nm').key).toBe('green');
    expect(ledSpec('LED 470nm').key).toBe('blue');
  });

  test('an explicit voltage in the value overrides the colour default', () => {
    expect(ledSpec('LED_Red 2.6V').vf).toBeCloseTo(2.6, 6);
  });

  test('every colour has a sane rated current and a positive glow gain', () => {
    for (const v of ['LED_Red', 'LED_Green', 'LED_Blue', 'LED_White', 'LED_Yellow']) {
      const s = ledSpec(v);
      expect(s.ifRated).toBeGreaterThan(0.005);
      expect(s.ifRated).toBeLessThan(0.05);
      expect(s.gain).toBeGreaterThan(0);
      expect(s.body).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(s.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
