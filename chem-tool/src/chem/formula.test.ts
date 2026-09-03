import { describe, expect, test } from 'vitest';
import { FormulaError, composition, hillFormula, looksLikeFormula, molarMass, parseFormula } from './formula';

describe('parseFormula', () => {
  test('simple and nested groups', () => {
    expect(parseFormula('H2O')).toEqual({ counts: { H: 2, O: 1 }, charge: 0 });
    expect(parseFormula('Ca(OH)2').counts).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseFormula('CH3COOH').counts).toEqual({ C: 2, H: 4, O: 2 });
    expect(parseFormula('K4[Fe(CN)6]').counts).toEqual({ K: 4, Fe: 1, C: 6, N: 6 });
  });
  test('hydrates and unicode', () => {
    expect(parseFormula('CuSO4·5H2O').counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(parseFormula('CuSO4.5H2O').counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(parseFormula('H₂O').counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula('SO₄²⁻')).toEqual({ counts: { S: 1, O: 4 }, charge: -2 });
  });
  test('charge notation', () => {
    expect(parseFormula('NH4+').charge).toBe(1);
    expect(parseFormula('NH4+').counts).toEqual({ N: 1, H: 4 });
    expect(parseFormula('OH-').charge).toBe(-1);
    expect(parseFormula('C2H3O2-')).toEqual({ counts: { C: 2, H: 3, O: 2 }, charge: -1 });
    expect(parseFormula('SO4 2-')).toEqual({ counts: { S: 1, O: 4 }, charge: -2 });
    expect(parseFormula('SO4^2-').charge).toBe(-2);
    expect(parseFormula('SO4(2-)').charge).toBe(-2);
    expect(parseFormula('Fe3+')).toEqual({ counts: { Fe: 1 }, charge: 3 });
    expect(parseFormula('Ca2+').charge).toBe(2);
  });
  test('rejects garbage', () => {
    expect(() => parseFormula('Xy2')).toThrow(FormulaError);
    expect(() => parseFormula('H2O)')).toThrow(FormulaError);
    expect(() => parseFormula('(H2O')).toThrow(FormulaError);
    expect(() => parseFormula('')).toThrow(FormulaError);
    expect(() => parseFormula('water')).toThrow(FormulaError);
  });
});

describe('hillFormula', () => {
  test('carbon first, hydrogen second, then alphabetical', () => {
    expect(hillFormula({ C: 2, H: 4, O: 2 })).toBe('C2H4O2');
    expect(hillFormula({ O: 1, H: 2 })).toBe('H2O');
    expect(hillFormula({ Na: 1, Cl: 1 })).toBe('ClNa');
    expect(hillFormula({ S: 1, O: 4 }, -2)).toBe('O4S 2-');
    expect(hillFormula({ N: 1, H: 4 }, 1)).toBe('H4N +');
    expect(hillFormula({ Fe: 1 }, 3)).toBe('Fe 3+');
  });
});

describe('molarMass and composition', () => {
  test('known masses', () => {
    expect(molarMass({ H: 2, O: 1 })).toBeCloseTo(18.015, 2);
    expect(molarMass({ C: 6, H: 12, O: 6 })).toBeCloseTo(180.156, 2);
    expect(molarMass(parseFormula('CuSO4·5H2O').counts)).toBeCloseTo(249.68, 1);
  });
  test('mass percent in Hill order', () => {
    const c = composition({ H: 2, O: 1 });
    expect(c.map((x) => x.element)).toEqual(['H', 'O']);
    expect(c[0].massPercent).toBeCloseTo(11.19, 2);
    expect(c[1].massPercent).toBeCloseTo(88.81, 2);
  });
});

test('looksLikeFormula', () => {
  expect(looksLikeFormula('NaCl')).toBe(true);
  expect(looksLikeFormula('SO4 2-')).toBe(true);
  expect(looksLikeFormula('water')).toBe(false);
  expect(looksLikeFormula('acetic acid')).toBe(false);
});
