import { describe, expect, test } from 'vitest';
import { SEED } from '../../data/seed';
import { hillFormula, parseFormula } from './formula';
import { LIBRARY, categories, findByFormula, findByName, normalizeName, search, suggestions } from './library';
import { countsOf, parseSmiles, totalCharge } from './structure';

describe('seed integrity', () => {
  test('every SMILES matches its formula text, names are unique', () => {
    const names = new Set<string>();
    for (const e of SEED) {
      const mol = parseSmiles(e.smiles);
      expect(mol, `${e.name}: SMILES does not parse`).not.toBeNull();
      const fromSmiles = hillFormula(countsOf(mol!), totalCharge(mol!));
      const p = parseFormula(e.formula);
      expect(fromSmiles, `${e.name}: formula ${e.formula} vs SMILES ${e.smiles}`).toBe(hillFormula(p.counts, p.charge));
      expect(names.has(normalizeName(e.name)), `duplicate name ${e.name}`).toBe(false);
      names.add(normalizeName(e.name));
    }
    expect(SEED.length).toBeGreaterThanOrEqual(60);
  });
});

describe('lookups', () => {
  test('by name, alias, formula text, any case', () => {
    expect(findByName('water')?.name).toBe('Water');
    expect(findByName('Dihydrogen Monoxide')?.name).toBe('Water');
    expect(findByName('h2o')?.name).toBe('Water');
    expect(findByName('NaCl')?.name).toBe('Sodium chloride');
    expect(findByName('table salt')?.name).toBe('Sodium chloride');
    expect(findByName('nothing here')).toBeUndefined();
  });
  test('by Hill formula returns isomers in seed order', () => {
    expect(findByFormula('C2H6O').map((e) => e.name)).toEqual(['Ethanol', 'Dimethyl ether']);
    expect(findByFormula('O4S 2-')[0].name).toBe('Sulfate');
    expect(findByFormula('Zz')).toEqual([]);
  });
  test('search ranks exact, prefix, then substring', () => {
    const hits = search('acet').map((e) => e.name);
    expect(hits[0]).toBe('Acetic acid');
    expect(hits).toContain('Acetone');
    expect(search('xyz')).toEqual([]);
    expect(search('a', 3)).toHaveLength(3);
  });
  test('suggestions tolerate typos', () => {
    expect(suggestions('watr')).toContain('Water');
    expect(suggestions('ethanl')).toContain('Ethanol');
  });
  test('categories and derived fields', () => {
    expect(categories()).toContain('Acids');
    expect(LIBRARY.find((e) => e.name === 'Sulfate')?.charge).toBe(-2);
  });
});
