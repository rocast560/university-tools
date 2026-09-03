import { describe, expect, test } from 'vitest';
import type { PubChemCompound } from './pubchem';
import { PubChemUnavailable } from './pubchem';
import { ResolveError, createResolver } from './resolve';

const ibuprofen: PubChemCompound = { cid: 3672, formula: 'C13H18O2', weight: 206.28, smiles: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O', connectivitySmiles: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O', iupac: '2-[4-(2-methylpropyl)phenyl]propanoic acid', title: 'Ibuprofen' };

function stub(byName: Record<string, PubChemCompound[]> = {}, byFormula: Record<string, PubChemCompound[]> = {}) {
  return {
    calls: [] as string[],
    async byName(n: string) { this.calls.push('name:' + n); return byName[n.toLowerCase()] ?? []; },
    async byFormula(f: string) { this.calls.push('formula:' + f); return byFormula[f] ?? []; },
  };
}

describe('resolve', () => {
  test('library by name and by formula, with isomers as alternatives', async () => {
    const pc = stub();
    const r = createResolver({ pubchem: pc });
    const water = await r.resolve('water');
    expect(water.species.name).toBe('Water');
    expect(water.species.source).toBe('library');
    expect(water.species.displayFormula).toBe('H2O');
    const eth = await r.resolve('C2H6O');
    expect(eth.species.name).toBe('Ethanol');
    expect(eth.alternatives.map((a) => a.name)).toEqual(['Dimethyl ether']);
    expect(pc.calls).toEqual([]);
  });
  test('SMILES input', async () => {
    const r = createResolver({ pubchem: stub() });
    const res = await r.resolve('CC(C)C');
    expect(res.species.source).toBe('smiles');
    expect(res.species.formula).toBe('C4H10');
    expect(res.species.name).toBe('C4H10');
  });
  test('PubChem by name, then by formula', async () => {
    const pc = stub({ 'ibuprofen': [ibuprofen] }, { 'C13H18O2': [ibuprofen] });
    const r = createResolver({ pubchem: pc });
    const byName = await r.resolve('ibuprofen');
    expect(byName.species.source).toBe('pubchem');
    expect(byName.species.cid).toBe(3672);
    expect(byName.species.iupacName).toBe('2-[4-(2-methylpropyl)phenyl]propanoic acid');
    const byFormula = await r.resolve('C13H18O2');
    expect(byFormula.species.name).toBe('Ibuprofen');
    expect(pc.calls).toEqual(['name:ibuprofen', 'name:C13H18O2', 'formula:C13H18O2']);
  });
  test('unknown query fails with suggestions', async () => {
    const r = createResolver({ pubchem: stub() });
    const err = await r.resolve('watre').catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).suggestions).toContain('Water');
  });
  test('PubChem disabled or unreachable is reported', async () => {
    const off = createResolver({ pubchem: null });
    await expect(off.resolve('ibuprofen')).rejects.toThrow(/PubChem is disabled/);
    const down = createResolver({ pubchem: { async byName() { throw new PubChemUnavailable('timeout'); }, async byFormula() { return []; } } });
    const err = await down.resolve('ibuprofen').catch((e) => e);
    expect(err.message).toMatch(/unreachable/);
    expect(err.reason).toBe('timeout');
  });
  test('results are cached per normalised query', async () => {
    const pc = stub({ 'ibuprofen': [ibuprofen] });
    const r = createResolver({ pubchem: pc });
    const first = await r.resolve('Ibuprofen');
    const second = await r.resolve('ibuprofen ');
    expect(pc.calls).toEqual(['name:Ibuprofen']);
    expect(second.species.smiles).toBe(first.species.smiles);
    expect(second.species.id).not.toBe(first.species.id);
  });
});
