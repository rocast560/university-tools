import { describe, expect, it } from 'vitest';
import {
  isValidSmiles,
  molfileToStructure,
  smilesCharge,
  smilesToFormula,
  smilesToMolfile3D,
  smilesToSvg,
  structureToMolfile,
  structureToPdb,
  structureToXyz,
} from './structure.ts';

describe('smilesToSvg', () => {
  it('draws water with explicit hydrogens and theme colours', () => {
    const svg = smilesToSvg('O')!;
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/>H</g) ?? []).length).toBe(2);
    expect(svg).toContain('currentColor');
    expect(svg).not.toContain('rgb(0,0,0)');
    expect(svg).not.toContain('class="event"');
  });
  it('draws larger molecules skeletal', () => {
    const svg = smilesToSvg('CC(=O)Oc1ccccc1C(=O)O')!;
    expect(svg).toContain('<line');
    expect((svg.match(/>H</g) ?? []).length).toBe(1); // only the acid OH
  });
  it('returns null for garbage', () => {
    expect(smilesToSvg('not smiles')).toBeNull();
    expect(isValidSmiles('C1CC')).toBe(false);
  });
});

describe('3D generation', () => {
  it('generates hydrogens and coordinates for benzene', () => {
    const mf = smilesToMolfile3D('c1ccccc1')!;
    const s = molfileToStructure(mf)!;
    expect(s.atoms.length).toBe(12);
    expect(s.bonds.length).toBe(12);
    expect(s.atoms.filter((a) => a.symbol === 'H').length).toBe(6);
    const zs = s.atoms.map((a) => Math.abs(a.z));
    const xs = s.atoms.map((a) => Math.abs(a.x));
    expect(Math.max(...xs, ...zs)).toBeGreaterThan(0.5);
  });
  it('keeps salt ions apart and charged', () => {
    const s = molfileToStructure(smilesToMolfile3D('[Na+].[Cl-]')!)!;
    expect(s.atoms.map((a) => a.charge).sort()).toEqual([-1, 1]);
    const [a, b] = s.atoms;
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(d).toBeGreaterThan(2);
  });
  it('returns null for invalid input', () => {
    expect(smilesToMolfile3D('xyz')).toBeNull();
  });
});

describe('formats', () => {
  const s = molfileToStructure(smilesToMolfile3D('O')!)!;
  it('writes xyz', () => {
    const xyz = structureToXyz(s, 'water');
    const lines = xyz.trim().split('\n');
    expect(lines[0]).toBe('3');
    expect(lines[1]).toBe('water');
    expect(lines[2].split(' ').length).toBe(4);
  });
  it('writes pdb with CONECT records', () => {
    const pdb = structureToPdb(s, 'water');
    expect(pdb).toContain('HETATM');
    expect((pdb.match(/CONECT/g) ?? []).length).toBe(3);
  });
  it('round trips a molfile it wrote itself', () => {
    const back = molfileToStructure(structureToMolfile(s, 'water'))!;
    expect(back.atoms.length).toBe(3);
    expect(back.bonds.length).toBe(2);
    expect(back.atoms[0].x).toBeCloseTo(s.atoms[0].x, 3);
  });
});

describe('formula from smiles', () => {
  it('counts hydrogens and reports Hill order', () => {
    const f = smilesToFormula('CCO')!;
    expect(f.hill).toBe('C2H6O');
    expect(f.weight).toBeCloseTo(46.07, 1);
    expect(smilesCharge('[NH4+]')).toBe(1);
    expect(smilesCharge('[Ca+2].[O-]C([O-])=O')).toBe(0);
  });
});
