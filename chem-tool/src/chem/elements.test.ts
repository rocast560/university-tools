import { describe, expect, test } from 'vitest';
import { ELEMENTS, byNumber, bySymbol } from './elements';

describe('elements', () => {
  test('looks up oxygen by symbol', () => {
    const o = bySymbol('O');
    expect(o?.name).toBe('Oxygen');
    expect(o?.mass).toBeCloseTo(15.999, 3);
    expect(o?.valence).toBe(6);
    expect(o?.en).toBeCloseTo(3.44, 2);
    expect(o?.color).toBe('#FF0D0D');
  });
  test('looks up by atomic number', () => {
    expect(byNumber(6)?.symbol).toBe('C');
    expect(byNumber(999)).toBeUndefined();
  });
  test('is case sensitive and rejects unknown symbols', () => {
    expect(bySymbol('CL')).toBeUndefined();
    expect(bySymbol('Cl')?.z).toBe(17);
    expect(bySymbol('Xx')).toBeUndefined();
  });
  test('noble gases have no electronegativity, transition metals have group valence', () => {
    expect(bySymbol('Ne')?.en).toBeNull();
    expect(bySymbol('Fe')?.valence).toBe(8);
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(60);
  });
});
