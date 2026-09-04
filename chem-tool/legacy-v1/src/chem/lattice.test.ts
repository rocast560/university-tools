import { describe, expect, it } from 'vitest';
import { buildLattice, cellEdges, findLattice, LATTICE_MATERIALS } from './lattice.ts';

const by = (formula: string) => LATTICE_MATERIALS.find((m) => m.formula === formula)!;

describe('buildLattice', () => {
  it('draws one cell with the textbook atom counts', () => {
    expect(buildLattice(by('Po'), 1).atoms.length).toBe(8); // simple cubic corners
    expect(buildLattice(by('W'), 1).atoms.length).toBe(9); // bcc
    expect(buildLattice(by('Cu'), 1).atoms.length).toBe(14); // fcc
    expect(buildLattice(by('NaCl'), 1).atoms.length).toBe(27); // rock salt
    expect(buildLattice(by('CsCl'), 1).atoms.length).toBe(9);
    expect(buildLattice(by('CaF2'), 1).atoms.length).toBe(22);
    expect(buildLattice(by('BaTiO3'), 1).atoms.length).toBe(15);
    expect(buildLattice(by('Si'), 1).atoms.length).toBe(18);
    expect(buildLattice(by('GaAs'), 1).atoms.length).toBe(18);
  });

  it('bonds the covalent networks with the right coordination', () => {
    const diamond = buildLattice(by('C'), 1);
    expect(diamond.bonds.length).toBe(16); // 4 interior atoms with 4 bonds each
    const interior = diamond.atoms.findIndex((a) => Math.abs(a.x - 3.567 / 4) < 1e-3);
    const degree = diamond.bonds.filter((b) => b.a === interior || b.b === interior).length;
    expect(degree).toBe(4);
    const metal = buildLattice(by('Cu'), 1);
    expect(metal.bonds.length).toBe(0);
  });

  it('places nearest neighbours at the right distance', () => {
    const nacl = buildLattice(by('NaCl'), 1);
    const na = nacl.atoms.find((a) => a.symbol === 'Na' && a.x === 0 && a.y === 0 && a.z === 0)!;
    const closest = Math.min(
      ...nacl.atoms.filter((a) => a.symbol === 'Cl').map((a) => Math.hypot(a.x - na.x, a.y - na.y, a.z - na.z)),
    );
    expect(closest).toBeCloseTo(2.82, 2);
  });

  it('grows with repeat', () => {
    expect(buildLattice(by('Cu'), 2).atoms.length).toBe(63); // 27 corners + 36 faces
  });

  it('uses hexagonal vectors for hcp and graphite', () => {
    const mg = buildLattice(by('Mg'), 1);
    expect(mg.cell.b[1]).toBeCloseTo((3.209 * Math.sqrt(3)) / 2, 3);
    expect(mg.atoms.length).toBe(9);
    const graphite = buildLattice(by('C') === by('C') ? LATTICE_MATERIALS.find((m) => m.type === 'graphite')! : by('C'), 2);
    expect(graphite.bonds.every((b) => Math.abs(graphite.atoms[b.a].z - graphite.atoms[b.b].z) < 1e-6)).toBe(true);
  });
});

describe('findLattice', () => {
  it('matches formulas, names and aliases', () => {
    expect(findLattice('NaCl')?.type).toBe('rocksalt');
    expect(findLattice('rock salt')?.formula).toBe('NaCl');
    expect(findLattice('iron')?.type).toBe('bcc');
    expect(findLattice('austenite')?.type).toBe('fcc');
    expect(findLattice('fcc')?.formula).toBe('Cu');
    expect(findLattice('diamond')?.type).toBe('diamond');
    expect(findLattice('graphite')?.type).toBe('graphite');
    expect(findLattice('perovskite')?.type).toBe('perovskite');
    expect(findLattice('nothing here')).toBeUndefined();
  });
});

describe('cellEdges', () => {
  it('returns twelve edges', () => {
    const edges = cellEdges({ a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] });
    expect(edges.length).toBe(12);
    expect(edges[0]).toEqual([[0, 0, 0], [1, 0, 0]]);
  });
});
