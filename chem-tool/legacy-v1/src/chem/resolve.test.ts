import { describe, expect, it } from 'vitest';
import { Library } from './library.ts';
import { PubChem, type PubChemCompound } from './pubchem.ts';
import { looksLikeSmiles, Resolver } from './resolve.ts';
import type { LibraryEntry } from './types.ts';

function entry(partial: Partial<LibraryEntry> & Pick<LibraryEntry, 'id' | 'name' | 'formula' | 'hill' | 'rank' | 'smiles'>): LibraryEntry {
  return {
    aliases: [],
    category: 'Test',
    tags: [],
    note: '',
    kind: 'molecule',
    iupac: '',
    cid: 0,
    molarMass: 0,
    charge: 0,
    sdfSource: 'none',
    ...partial,
  };
}

const lib = new Library([
  entry({ id: 'water', name: 'Water', formula: 'H2O', hill: 'H2O', rank: 0, smiles: 'O', cid: 962, molarMass: 18.015, aliases: ['dihydrogen monoxide'] }),
  entry({ id: 'ethanol', name: 'Ethanol', formula: 'C2H5OH', hill: 'C2H6O', rank: 1, smiles: 'CCO', cid: 702, cas: '64-17-5', molarMass: 46.069, aliases: ['ethyl alcohol'] }),
  entry({ id: 'dimethyl-ether', name: 'Dimethyl ether', formula: 'CH3OCH3', hill: 'C2H6O', rank: 2, smiles: 'COC', cid: 8254, molarMass: 46.069 }),
  entry({ id: 'sodium-chloride', name: 'Sodium chloride', formula: 'NaCl', hill: 'ClNa', rank: 3, smiles: '[Na+].[Cl-]', cid: 5234, kind: 'ionic', molarMass: 58.44 }),
  entry({ id: 'iron', name: 'Iron', formula: 'Fe', hill: 'Fe', rank: 4, smiles: '[Fe]', cid: 23925, kind: 'element', molarMass: 55.845 }),
  entry({ id: 'carbon-monoxide', name: 'Carbon monoxide', formula: 'CO', hill: 'CO', rank: 5, smiles: '[C-]#[O+]', cid: 281, molarMass: 28.01 }),
]);

const caffeine: PubChemCompound = {
  cid: 2519,
  formula: 'C8H10N4O2',
  weight: 194.19,
  smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
  connectivitySmiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
  iupac: '1,3,7-trimethylpurine-2,6-dione',
  title: 'Caffeine',
};

class FakePubChem extends PubChem {
  calls: string[] = [];
  private readonly hits: Record<string, PubChemCompound[]>;
  private readonly down: boolean;
  constructor(hits: Record<string, PubChemCompound[]>, down = false) {
    super({ cacheDir: null, minIntervalMs: 0 });
    this.hits = hits;
    this.down = down;
  }
  override async byName(name: string): Promise<PubChemCompound[]> {
    this.calls.push(`name:${name}`);
    if (this.down) throw new (await import('./pubchem.ts')).PubChemUnavailable('offline');
    return this.hits[name.toLowerCase()] ?? [];
  }
  override async byFormula(formula: string): Promise<PubChemCompound[]> {
    this.calls.push(`formula:${formula}`);
    if (this.down) throw new (await import('./pubchem.ts')).PubChemUnavailable('offline');
    return this.hits[formula] ?? [];
  }
  override async byCids(cids: number[]): Promise<PubChemCompound[]> {
    this.calls.push(`cid:${cids.join(',')}`);
    return cids.includes(2519) ? [caffeine] : [];
  }
  override async sdf(): Promise<string | null> {
    return null;
  }
  override async synonyms(): Promise<string[]> {
    return ['caffeine', '58-08-2'];
  }
  override async description(): Promise<string | null> {
    return 'A stimulant.';
  }
}

function make(down = false) {
  const pc = new FakePubChem({ caffeine: [caffeine], C8H10N4O2: [caffeine] }, down);
  return { pc, r: new Resolver({ library: lib, pubchem: pc, sdfDir: 'nowhere' }) };
}

describe('Resolver with the library', () => {
  it('resolves names, aliases, formulas and condensed formulas', async () => {
    const { r } = make();
    for (const [q, id, on] of [
      ['water', 'water', 'name'],
      ['Dihydrogen Monoxide', 'water', 'name'],
      ['H2O', 'water', 'formula'],
      ['h2o', 'water', 'formula'],
      ['CH3CH2OH', 'ethanol', 'formula'],
      ['nacl', 'sodium-chloride', 'formula'],
      ['64-17-5', 'ethanol', 'cas'],
      ['962', 'water', 'cid'],
      ['cid:962', 'water', 'cid'],
    ] as const) {
      const res = await r.resolve(q);
      expect(res.ok, q).toBe(true);
      if (res.ok) {
        expect(res.resolved.compound.id, q).toBe(id);
        expect(res.resolved.matchedOn, q).toBe(on);
      }
    }
  });

  it('lists isomers as alternatives, most common first', async () => {
    const { r } = make();
    const res = await r.resolve('C2H6O');
    expect(res.ok && res.resolved.compound.id).toBe('ethanol');
    expect(res.ok && res.resolved.alternatives.map((a) => a.id)).toEqual(['dimethyl-ether']);
  });

  it('produces a picture, a 3D structure and a composition', async () => {
    const { r } = make();
    const res = await r.resolve('ethanol');
    if (!res.ok) throw new Error(res.error);
    expect(res.resolved.svg).toContain('<svg');
    expect(res.resolved.molfile).toContain('V2000');
    expect(res.resolved.structureSource).toBe('ocl');
    expect(res.resolved.composition.map((c) => c.symbol)).toEqual(['C', 'H', 'O']);
    expect(res.resolved.compound.formulaHtml).toBe('C<sub>2</sub>H<sub>5</sub>OH');
  });

  it('prefers the library formula reading over a SMILES reading for CO', async () => {
    const { r } = make();
    const res = await r.resolve('CO');
    expect(res.ok && res.resolved.compound.id).toBe('carbon-monoxide');
  });

  it('maps a SMILES back to the library entry with the same structure', async () => {
    const { r } = make();
    const res = await r.resolve('OCC');
    expect(res.ok && res.resolved.compound.id).toBe('ethanol');
    expect(res.ok && res.resolved.matchedOn).toBe('smiles');
    const ring = await r.resolve('c1ccccc1');
    expect(ring.ok && ring.resolved.compound.source).toBe('smiles');
    expect(ring.ok && ring.resolved.compound.hill).toBe('C6H6');
  });

  it('uses a lattice for solid elements and attaches lattice info to salts', async () => {
    const { r } = make();
    const fe = await r.resolve('iron');
    if (!fe.ok) throw new Error(fe.error);
    expect(fe.resolved.structureSource).toBe('lattice');
    expect(fe.resolved.lattice?.type).toBe('bcc');
    expect(fe.resolved.molfile).toContain('Fe');
    const salt = await r.resolve('NaCl');
    if (!salt.ok) throw new Error(salt.error);
    expect(salt.resolved.structureSource).toBe('ocl');
    expect(salt.resolved.lattice?.type).toBe('rocksalt');
    expect(salt.resolved.warnings.join(' ')).toMatch(/formula unit/);
    const rs = await r.resolve('rock salt');
    expect(rs.ok && rs.resolved.matchedOn).toBe('lattice');
    expect(rs.ok && rs.resolved.compound.formula).toBe('NaCl');
  });
});

describe('Resolver with PubChem', () => {
  it('falls back to PubChem by name and by formula', async () => {
    const { r, pc } = make();
    const byName = await r.resolve('caffeine');
    if (!byName.ok) throw new Error(byName.error);
    expect(byName.resolved.compound.source).toBe('pubchem');
    expect(byName.resolved.compound.cas).toBe('58-08-2');
    expect(byName.resolved.compound.note).toBe('A stimulant.');
    expect(byName.resolved.molfile).toContain('V2000');
    const byFormula = await r.resolve('C8H10N4O2');
    expect(byFormula.ok && byFormula.resolved.compound.cid).toBe(2519);
    expect(pc.calls).toContain('formula:C8H10N4O2');
  });

  it('reports a miss with suggestions', async () => {
    const { r } = make();
    const res = await r.resolve('ethanoll');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.suggestions[0].id).toBe('ethanol');
  });

  it('explains when PubChem is down but still serves the library', async () => {
    const { r } = make(true);
    const res = await r.resolve('caffeine');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.pubchemDown).toBe(true);
    const local = await r.resolve('water');
    expect(local.ok).toBe(true);
  });

  it('does not send SMILES shaped strings to PubChem as formulas', async () => {
    const { r, pc } = make();
    const res = await r.resolve('C1CCCCC1');
    expect(res.ok && res.resolved.compound.hill).toBe('C6H12');
    expect(pc.calls.some((c) => c.startsWith('formula:C6'))).toBe(false);
  });
});

describe('looksLikeSmiles', () => {
  it('spots SMILES markers', () => {
    expect(looksLikeSmiles('C=O')).toBe(true);
    expect(looksLikeSmiles('c1ccccc1')).toBe(true);
    expect(looksLikeSmiles('[Na+].[Cl-]')).toBe(true);
    expect(looksLikeSmiles('CC(=O)O')).toBe(true);
    expect(looksLikeSmiles('H2O')).toBe(false);
    expect(looksLikeSmiles('Ca(OH)2')).toBe(false);
    expect(looksLikeSmiles('acetic acid')).toBe(false);
  });
});
