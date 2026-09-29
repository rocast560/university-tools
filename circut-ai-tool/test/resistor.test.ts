import { describe, expect, test } from 'bun:test';
import { colourBands } from '../src/parts/resistor.ts';

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
