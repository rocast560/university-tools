import { describe, expect, it } from 'vitest';
import { levenshtein, Library, normaliseName } from './library.ts';
import type { LibraryEntry } from './types.ts';

function entry(partial: Partial<LibraryEntry> & Pick<LibraryEntry, 'id' | 'name' | 'formula' | 'hill' | 'rank'>): LibraryEntry {
  return {
    aliases: [],
    category: 'Test',
    tags: [],
    note: '',
    kind: 'molecule',
    smiles: 'C',
    iupac: '',
    cid: 0,
    molarMass: 0,
    charge: 0,
    sdfSource: 'none',
    ...partial,
  };
}

const lib = new Library([
  entry({ id: 'ethanol', name: 'Ethanol', formula: 'C2H5OH', hill: 'C2H6O', rank: 2, aliases: ['ethyl alcohol', 'grain alcohol', 'EtOH'], cas: '64-17-5', cid: 702, category: 'Alcohols' }),
  entry({ id: 'dimethyl-ether', name: 'Dimethyl ether', formula: 'CH3OCH3', hill: 'C2H6O', rank: 5, aliases: ['DME'], category: 'Ethers' }),
  entry({ id: 'water', name: 'Water', formula: 'H2O', hill: 'H2O', rank: 0, aliases: ['dihydrogen monoxide'], cid: 962, category: 'Simple' }),
  entry({ id: 'iron-iii-chloride', name: 'Iron(III) chloride', formula: 'FeCl3', hill: 'Cl3Fe', rank: 9, aliases: ['ferric chloride'], category: 'Salts', tags: ['Lab'] }),
  entry({ id: 'ethylene', name: 'Ethylene', formula: 'C2H4', hill: 'C2H4', rank: 3, aliases: ['ethene'], category: 'Hydrocarbons' }),
]);

describe('normaliseName', () => {
  it('strips case, spaces and punctuation', () => {
    expect(normaliseName('Iron(III) chloride')).toBe('ironiiichloride');
    expect(normaliseName('R-134a')).toBe('r134a');
    expect(normaliseName('Ethyl  Alcohol')).toBe('ethylalcohol');
  });
});

describe('Library lookups', () => {
  it('finds by name and alias regardless of case and punctuation', () => {
    expect(lib.findByName('ethanol')[0].id).toBe('ethanol');
    expect(lib.findByName('Ethyl alcohol')[0].id).toBe('ethanol');
    expect(lib.findByName('etoh')[0].id).toBe('ethanol');
    expect(lib.findByName('iron (iii) chloride')[0].id).toBe('iron-iii-chloride');
    expect(lib.findByName('nothing')).toEqual([]);
  });

  it('finds by formula in seed rank order, including condensed and lowercase forms', () => {
    expect(lib.findByFormula('C2H6O').map((e) => e.id)).toEqual(['ethanol', 'dimethyl-ether']);
    expect(lib.findByFormula('CH3CH2OH')[0].id).toBe('ethanol');
    expect(lib.findByFormula('h2o')[0].id).toBe('water');
    expect(lib.findByFormula('fecl3')[0].id).toBe('iron-iii-chloride');
    expect(lib.findByFormula('water')).toEqual([]);
  });

  it('finds by CAS and CID', () => {
    expect(lib.findByCas('64-17-5')?.id).toBe('ethanol');
    expect(lib.findByCid(962)?.id).toBe('water');
  });

  it('lists categories and tags', () => {
    expect(lib.categories().map((c) => c.category)).toContain('Salts');
    expect(lib.byCategory('lab').map((e) => e.id)).toEqual(['iron-iii-chloride']);
  });
});

describe('Library.search', () => {
  it('ranks exact names above prefixes above substrings', () => {
    const ids = lib.search('eth').map((h) => h.entry.id);
    expect(ids.slice(0, 2)).toEqual(['ethanol', 'ethylene']); // both prefix matches; the shorter name wins
    expect(lib.search('ethanol')[0].entry.id).toBe('ethanol');
    expect(lib.search('methyl')[0].entry.id).toBe('dimethyl-ether'); // substring
  });
  it('matches formulas', () => {
    expect(lib.search('C2H6O').map((h) => h.entry.id)).toEqual(['ethanol', 'dimethyl-ether']);
    expect(lib.search('FeCl')[0].entry.id).toBe('iron-iii-chloride');
  });
  it('returns one hit per entry with the best reason', () => {
    const hits = lib.search('ethyl');
    expect(new Set(hits.map((h) => h.entry.id)).size).toBe(hits.length);
  });
});

describe('suggest', () => {
  it('offers close names for typos', () => {
    expect(lib.suggest('ethanoll')[0].id).toBe('ethanol');
    expect(lib.suggest('watr')[0].id).toBe('water');
    expect(lib.suggest('zzzzzzzz')).toEqual([]);
  });
  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abcdef', 'xyz', 2)).toBe(3);
  });
});
