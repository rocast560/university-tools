import { describe, expect, test } from 'bun:test';
import { colourBands, resistorBands } from '../src/parts/resistor.ts';

const names = (value: string) => colourBands(value)?.map((b) => b.name) ?? null;

describe('colourBands', () => {
  test('reads the standard four-band code off the value', () => {
    expect(names('1k')).toEqual(['brown', 'black', 'red', 'gold']);
    expect(names('330')).toEqual(['orange', 'orange', 'brown', 'gold']);
    expect(names('4k7')).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect(names('2.2k')).toEqual(['red', 'red', 'red', 'gold']);
    expect(names('1M')).toEqual(['brown', 'black', 'green', 'gold']);
  });

  test('uses the gold and silver multipliers below ten ohms', () => {
    expect(names('10')).toEqual(['brown', 'black', 'black', 'gold']);
    expect(names('4.7')).toEqual(['yellow', 'violet', 'gold', 'gold']);
    expect(names('0.47')).toEqual(['yellow', 'violet', 'silver', 'gold']);
  });

  test('a value that rounds up to three digits shifts rather than overflowing', () => {
    // 997 rounds to 100 x 10^1, which must become 10 x 10^2, not band "100".
    expect(names('997')).toEqual(['brown', 'black', 'red', 'gold']);
  });

  test('gives nothing for a value that is not a resistance', () => {
    for (const v of ['', 'oops', '100n', '0']) expect(colourBands(v)).toBeNull();
  });

  test('every band carries a colour a renderer can paint', () => {
    for (const b of colourBands('4k7')!) expect(b.hex).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('resistorBands', () => {
  const five = (value: string) => resistorBands(value, 'metal')?.map((b) => b.name) ?? null;

  test('metal film reads the five-band 1% code: three digits, multiplier, brown tolerance', () => {
    expect(five('1k')).toEqual(['brown', 'black', 'black', 'brown', 'brown']);
    expect(five('330')).toEqual(['orange', 'orange', 'black', 'black', 'brown']);
    expect(five('4k7')).toEqual(['yellow', 'violet', 'black', 'brown', 'brown']);
    expect(five('10')).toEqual(['brown', 'black', 'black', 'gold', 'brown']);
    expect(five('4.7')).toEqual(['yellow', 'violet', 'black', 'silver', 'brown']);
  });

  test('carbon film keeps the four-band code', () => {
    expect(resistorBands('1k', 'carbon')).toEqual(colourBands('1k'));
  });

  test('gives nothing for a value that is not a resistance', () => {
    expect(resistorBands('oops', 'metal')).toBeNull();
  });
});
