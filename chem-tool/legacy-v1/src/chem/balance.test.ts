import { describe, expect, it } from 'vitest';
import { balanceEquation, parseEquation } from './balance.ts';

describe('balanceEquation', () => {
  it('balances simple combustion and synthesis', () => {
    expect(balanceEquation('H2 + O2 -> H2O').coefficients).toEqual([2, 1, 2]);
    expect(balanceEquation('Fe + O2 = Fe2O3').coefficients).toEqual([4, 3, 2]);
    expect(balanceEquation('C3H8 + O2 → CO2 + H2O').coefficients).toEqual([1, 5, 3, 4]);
    expect(balanceEquation('C8H18 + O2 -> CO2 + H2O').coefficients).toEqual([2, 25, 16, 18]);
  });

  it('balances a redox equation with many species', () => {
    expect(balanceEquation('KMnO4 + HCl -> KCl + MnCl2 + H2O + Cl2').coefficients).toEqual([2, 16, 2, 2, 8, 5]);
  });

  it('balances ionic equations using charge', () => {
    expect(balanceEquation('Cu + Ag+ -> Cu2+ + Ag').coefficients).toEqual([1, 2, 1, 2]);
    expect(balanceEquation('Fe3+ + e- -> Fe2+').coefficients).toEqual([1, 1, 1]);
    expect(balanceEquation('MnO4- + H+ + e- -> Mn2+ + H2O').coefficients).toEqual([1, 8, 5, 1, 4]);
  });

  it('formats the result', () => {
    const r = balanceEquation('H2 + O2 -> H2O');
    expect(r.ascii).toBe('2 H2 + O2 -> 2 H2O');
    expect(r.equation).toBe('2 H₂ + O₂ → 2 H₂O');
  });

  it('rejects impossible or malformed equations', () => {
    expect(() => balanceEquation('H2 -> O2')).toThrow(/cannot be balanced/);
    expect(() => balanceEquation('H2 + O2')).toThrow(/reactants -> products/);
    expect(() => balanceEquation('water -> H2O')).toThrow(/Cannot read/);
  });
});

describe('parseEquation', () => {
  it('keeps charges attached and splits on plus', () => {
    const { reactants, products } = parseEquation('NH4+ + OH- -> NH3 + H2O');
    expect(reactants.map((s) => s.formula)).toEqual(['NH4+', 'OH-']);
    expect(products.map((s) => s.formula)).toEqual(['NH3', 'H2O']);
    expect(reactants[0].parsed.charge).toBe(1);
  });
});
