import { describe, expect, test } from 'vitest';
import {
  canonicalSmiles, countsOf, extractAtomsBonds, heavyAtomCount, molfile2D, molfile3D,
  parseMolfile, parseSmiles, to3D, toSvg, totalCharge,
} from './structure';

describe('parsing', () => {
  test('valid and invalid SMILES', () => {
    expect(parseSmiles('CCO')?.getAllAtoms()).toBe(3);
    expect(parseSmiles('C(')).toBeNull();
    expect(parseSmiles('')).toBeNull();
  });
  test('molfile round trip', () => {
    const mol = parseSmiles('CC(=O)O')!;
    const back = parseMolfile(molfile2D(mol));
    expect(back?.getAllAtoms()).toBe(4);
    expect(parseMolfile('garbage')).toBeNull();
  });
});

describe('toSvg', () => {
  test('draws water with hydrogens and ethanol without', () => {
    const water = toSvg(parseSmiles('O')!);
    expect(water).toContain('<svg');
    expect(water).toMatch(/>H/);
    expect(water).toContain('currentColor');
    expect(water).not.toContain('class="event"');
    const ethanol = toSvg(parseSmiles('CCO')!);
    expect(ethanol).toContain('<svg');
  });
  test('numbered drawing labels heavy atoms C1, C2, O3', () => {
    const svg = toSvg(parseSmiles('CCO')!, { numbered: true });
    expect(svg).toContain('C1');
    expect(svg).toContain('C2');
    expect(svg).toContain('O3');
  });
});

describe('to3D', () => {
  test('acetic acid: 8 atoms, heavy first, real z coordinates', () => {
    const { mol, geometry } = to3D(parseSmiles('CC(=O)O')!);
    expect(geometry).toBe('conformer');
    const { atoms, bonds } = extractAtomsBonds(mol);
    expect(atoms).toHaveLength(8);
    expect(atoms.slice(0, 4).map((a) => a.element)).toEqual(['C', 'C', 'O', 'O']);
    expect(atoms.slice(4).every((a) => a.element === 'H')).toBe(true);
    expect(atoms[0].index).toBe(1);
    expect(atoms.some((a) => Math.abs(a.z) > 0.1)).toBe(true);
    expect(bonds).toHaveLength(7);
    expect(bonds.every((b) => b.a >= 1 && b.b <= 8)).toBe(true);
  });
  test('salt fragments are laid out apart', () => {
    const { mol } = to3D(parseSmiles('[Na+].[Cl-]')!);
    const { atoms } = extractAtomsBonds(mol);
    expect(atoms.map((a) => a.charge)).toEqual([1, -1]);
    const d = Math.hypot(atoms[0].x - atoms[1].x, atoms[0].y - atoms[1].y, atoms[0].z - atoms[1].z);
    expect(d).toBeGreaterThan(2);
  });
  test('permanganate falls back to ideal star geometry', () => {
    const { mol, geometry } = to3D(parseSmiles('[O-][Mn](=O)(=O)=O')!);
    expect(geometry).toBe('star');
    const { atoms, bonds } = extractAtomsBonds(mol);
    expect(atoms).toHaveLength(5);
    expect(bonds).toHaveLength(4);
    const mn = atoms.find((a) => a.element === 'Mn')!;
    for (const o of atoms.filter((a) => a.element === 'O')) {
      expect(Math.hypot(o.x - mn.x, o.y - mn.y, o.z - mn.z)).toBeCloseTo(1.39 + 0.66, 1);
    }
  });
  test('benzene bonds are flagged aromatic with Kekulé orders', () => {
    const { bonds } = extractAtomsBonds(to3D(parseSmiles('c1ccccc1')!).mol);
    const ring = bonds.filter((b) => b.aromatic);
    expect(ring).toHaveLength(6);
    expect(ring.filter((b) => b.order === 2)).toHaveLength(3);
  });
});

describe('counts, charge, smiles', () => {
  test('ethanol counts include implicit hydrogens', () => {
    expect(countsOf(parseSmiles('CCO')!)).toEqual({ C: 2, H: 6, O: 1 });
  });
  test('sulfate charge and canonical smiles', () => {
    const mol = parseSmiles('[O-]S(=O)(=O)[O-]')!;
    expect(totalCharge(mol)).toBe(-2);
    expect(canonicalSmiles(to3D(mol).mol)).toBe(canonicalSmiles(mol));
    expect(heavyAtomCount(to3D(mol).mol)).toBe(5);
  });
  test('molfile3D keeps 3D coordinates', () => {
    const mol3d = to3D(parseSmiles('C')!).mol;
    const back = parseMolfile(molfile3D(mol3d))!;
    expect(back.getAllAtoms()).toBe(5);
    expect(Math.abs(back.getAtomZ(1)) + Math.abs(back.getAtomZ(2))).toBeGreaterThan(0.1);
  });
});
