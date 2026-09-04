import { describe, expect, it } from 'vitest';
import {
  composition,
  formatFormulaHtml,
  formatFormulaUnicode,
  hillFormula,
  looksLikeFormula,
  molarMass,
  parseFormula,
} from './formula.ts';

describe('parseFormula', () => {
  it('counts simple formulas', () => {
    expect(parseFormula('H2O').counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula('NaCl').counts).toEqual({ Na: 1, Cl: 1 });
    expect(parseFormula('C6H12O6').counts).toEqual({ C: 6, H: 12, O: 6 });
  });

  it('expands parentheses and brackets', () => {
    expect(parseFormula('Ca(OH)2').counts).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseFormula('Al2(SO4)3').counts).toEqual({ Al: 2, S: 3, O: 12 });
    expect(parseFormula('[Cu(NH3)4]SO4').counts).toEqual({ Cu: 1, N: 4, H: 12, S: 1, O: 4 });
    expect(parseFormula('Mg3(PO4)2').counts).toEqual({ Mg: 3, P: 2, O: 8 });
  });

  it('adds hydrates written with a dot, a middle dot or an asterisk', () => {
    for (const s of ['CuSO4.5H2O', 'CuSO4·5H2O', 'CuSO4*5H2O', 'CuSO4 . 5 H2O']) {
      expect(parseFormula(s).counts, s).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    }
  });

  it('counts condensed structural formulas atom by atom', () => {
    expect(parseFormula('CH3CH2OH').counts).toEqual({ C: 2, H: 6, O: 1 });
    expect(parseFormula('CH3COOH').counts).toEqual({ C: 2, H: 4, O: 2 });
    expect(parseFormula('(CH3)2CO').counts).toEqual({ C: 3, H: 6, O: 1 });
  });

  it('reads unicode subscripts and superscript charges', () => {
    expect(parseFormula('H₂O').counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula('SO₄²⁻')).toMatchObject({ counts: { S: 1, O: 4 }, charge: -2 });
  });

  it('reads ascii charges and states', () => {
    expect(parseFormula('NH4+')).toMatchObject({ counts: { N: 1, H: 4 }, charge: 1 });
    expect(parseFormula('SO4^2-')).toMatchObject({ charge: -2 });
    expect(parseFormula('Fe3+')).toMatchObject({ counts: { Fe: 1 }, charge: 3 });
    expect(parseFormula('CO2(g)').counts).toEqual({ C: 1, O: 2 });
    expect(parseFormula('NaCl (aq)').counts).toEqual({ Na: 1, Cl: 1 });
  });

  it('keeps a leading coefficient separate', () => {
    expect(parseFormula('2H2O')).toMatchObject({ coefficient: 2, counts: { H: 2, O: 1 } });
  });

  it('recovers common lowercase spellings', () => {
    expect(parseFormula('h2o').counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula('co2').counts).toEqual({ C: 1, O: 2 });
    expect(parseFormula('nacl').counts).toEqual({ Na: 1, Cl: 1 });
    expect(parseFormula('NACL').counts).toEqual({ Na: 1, Cl: 1 });
    expect(parseFormula('h2so4').counts).toEqual({ H: 2, S: 1, O: 4 });
  });

  it('rejects things that are not formulas', () => {
    expect(() => parseFormula('water')).toThrow();
    expect(() => parseFormula('Xx2')).toThrow();
    expect(() => parseFormula('H2O)')).toThrow();
    expect(() => parseFormula('')).toThrow();
  });
});

describe('hillFormula', () => {
  it('puts carbon then hydrogen first when carbon is present', () => {
    expect(hillFormula({ H: 4, O: 2, C: 2 })).toBe('C2H4O2');
    expect(hillFormula({ Cl: 1, C: 1, H: 3 })).toBe('CH3Cl');
  });
  it('is alphabetical without carbon', () => {
    expect(hillFormula({ Na: 1, Cl: 1 })).toBe('ClNa');
    expect(hillFormula({ H: 2, O: 1 })).toBe('H2O');
    expect(hillFormula({ S: 1, H: 2, O: 4 })).toBe('H2O4S');
  });
});

describe('molarMass and composition', () => {
  it('matches textbook values', () => {
    expect(molarMass({ H: 2, O: 1 })).toBeCloseTo(18.015, 2);
    expect(molarMass({ C: 6, H: 12, O: 6 })).toBeCloseTo(180.16, 1);
    expect(molarMass({ Na: 1, Cl: 1 })).toBeCloseTo(58.44, 2);
  });
  it('gives mass percent that sums to 100', () => {
    const c = composition({ H: 2, O: 1 });
    const total = c.reduce((s, x) => s + x.massPercent, 0);
    expect(total).toBeCloseTo(100, 6);
    expect(c.find((x) => x.symbol === 'O')!.massPercent).toBeCloseTo(88.8, 1);
  });
});

describe('formatting', () => {
  it('renders subscripts as html and unicode', () => {
    expect(formatFormulaHtml('H2O')).toBe('H<sub>2</sub>O');
    expect(formatFormulaHtml('Ca(OH)2')).toBe('Ca(OH)<sub>2</sub>');
    expect(formatFormulaHtml('SO4^2-')).toBe('SO<sub>4</sub><sup>2−</sup>');
    expect(formatFormulaUnicode('C6H12O6')).toBe('C₆H₁₂O₆');
    expect(formatFormulaUnicode('NH4+')).toBe('NH₄⁺');
  });
});

describe('looksLikeFormula', () => {
  it('accepts formula shaped strings and rejects names', () => {
    expect(looksLikeFormula('H2O')).toBe(true);
    expect(looksLikeFormula('CH3COOH')).toBe(true);
    expect(looksLikeFormula('nacl')).toBe(true);
    expect(looksLikeFormula('water')).toBe(false);
    expect(looksLikeFormula('sulfuric acid')).toBe(false);
    expect(looksLikeFormula('C=O')).toBe(false);
  });
});
