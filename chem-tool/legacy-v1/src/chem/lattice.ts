// Idealised crystal structures for materials classes: the unit cell types
// from Callister (SC, BCC, FCC, HCP, diamond cubic, rock salt, CsCl, zinc
// blende, fluorite, perovskite, graphite) with measured lattice constants.
//
// A cluster is `repeat` cells along each axis including the far boundary,
// so a single FCC cell shows all 14 atoms a textbook draws. Bonds are only
// generated for covalent networks; metals and ionic solids are spheres.

import type { Atom3D, Bond3D, Structure3D } from './structure.ts';

export type LatticeType =
  | 'sc'
  | 'bcc'
  | 'fcc'
  | 'hcp'
  | 'diamond'
  | 'rocksalt'
  | 'cscl'
  | 'zincblende'
  | 'fluorite'
  | 'perovskite'
  | 'graphite';

export interface LatticeSpec {
  /** Display name, e.g. 'Sodium chloride (rock salt)'. */
  name: string;
  formula: string;
  type: LatticeType;
  /** Lattice constant a in angstrom. */
  a: number;
  /** c axis for hexagonal cells. */
  c?: number;
  /** Element per basis site role: metals one entry, AB compounds two, perovskite three (A, B, O). */
  elements: string[];
  note: string;
  aliases?: string[];
}

type Vec = [number, number, number];

interface CellDefinition {
  title: string;
  /** Fractional positions per role index. */
  sites: Array<{ role: number; positions: Vec[] }>;
  hexagonal?: boolean;
  covalent?: boolean;
  coordination: number;
  packingFactor?: number;
  atomsPerCell: number;
}

const CORNERS: Vec[] = [[0, 0, 0]];
const FCC: Vec[] = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];
const TETRAHEDRAL_HALF: Vec[] = [[0.25, 0.25, 0.25], [0.75, 0.75, 0.25], [0.75, 0.25, 0.75], [0.25, 0.75, 0.75]];
const TETRAHEDRAL_ALL: Vec[] = [
  ...TETRAHEDRAL_HALF,
  [0.75, 0.75, 0.75], [0.25, 0.25, 0.75], [0.25, 0.75, 0.25], [0.75, 0.25, 0.25],
];
const OCTAHEDRAL: Vec[] = [[0.5, 0.5, 0.5], [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5]];

const CELLS: Record<LatticeType, CellDefinition> = {
  sc: { title: 'Simple cubic', sites: [{ role: 0, positions: CORNERS }], coordination: 6, packingFactor: 0.52, atomsPerCell: 1 },
  bcc: { title: 'Body centred cubic', sites: [{ role: 0, positions: [[0, 0, 0], [0.5, 0.5, 0.5]] }], coordination: 8, packingFactor: 0.68, atomsPerCell: 2 },
  fcc: { title: 'Face centred cubic', sites: [{ role: 0, positions: FCC }], coordination: 12, packingFactor: 0.74, atomsPerCell: 4 },
  hcp: {
    title: 'Hexagonal close packed',
    sites: [{ role: 0, positions: [[0, 0, 0], [1 / 3, 2 / 3, 0.5]] }],
    hexagonal: true,
    coordination: 12,
    packingFactor: 0.74,
    atomsPerCell: 2,
  },
  diamond: {
    title: 'Diamond cubic',
    sites: [{ role: 0, positions: [...FCC, ...TETRAHEDRAL_HALF] }],
    covalent: true,
    coordination: 4,
    packingFactor: 0.34,
    atomsPerCell: 8,
  },
  rocksalt: { title: 'Rock salt (NaCl)', sites: [{ role: 0, positions: FCC }, { role: 1, positions: OCTAHEDRAL }], coordination: 6, atomsPerCell: 8 },
  cscl: { title: 'Caesium chloride', sites: [{ role: 0, positions: CORNERS }, { role: 1, positions: [[0.5, 0.5, 0.5]] }], coordination: 8, atomsPerCell: 2 },
  zincblende: {
    title: 'Zinc blende (sphalerite)',
    sites: [{ role: 0, positions: FCC }, { role: 1, positions: TETRAHEDRAL_HALF }],
    covalent: true,
    coordination: 4,
    atomsPerCell: 8,
  },
  fluorite: { title: 'Fluorite (CaF2)', sites: [{ role: 0, positions: FCC }, { role: 1, positions: TETRAHEDRAL_ALL }], coordination: 8, atomsPerCell: 12 },
  perovskite: {
    title: 'Perovskite (ABO3)',
    sites: [
      { role: 0, positions: CORNERS },
      { role: 1, positions: [[0.5, 0.5, 0.5]] },
      { role: 2, positions: [[0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]] },
    ],
    coordination: 6,
    atomsPerCell: 5,
  },
  graphite: {
    title: 'Graphite (AB layers)',
    sites: [{ role: 0, positions: [[0, 0, 0], [1 / 3, 2 / 3, 0], [0, 0, 0.5], [2 / 3, 1 / 3, 0.5]] }],
    hexagonal: true,
    covalent: true,
    coordination: 3,
    atomsPerCell: 4,
  },
};

export const LATTICE_MATERIALS: LatticeSpec[] = [
  // Metals
  { name: 'Iron (alpha, ferrite)', formula: 'Fe', type: 'bcc', a: 2.866, elements: ['Fe'], note: 'Room temperature iron is BCC; it becomes FCC austenite above 912 °C.', aliases: ['ferrite', 'alpha iron', 'bcc iron', 'iron'] },
  { name: 'Iron (gamma, austenite)', formula: 'Fe', type: 'fcc', a: 3.647, elements: ['Fe'], note: 'FCC iron, stable between 912 and 1394 °C; the phase that dissolves carbon in steel making.', aliases: ['austenite', 'gamma iron', 'fcc iron'] },
  { name: 'Copper', formula: 'Cu', type: 'fcc', a: 3.615, elements: ['Cu'], note: 'FCC; the standard example of a ductile close packed metal.', aliases: ['copper', 'fcc'] },
  { name: 'Aluminium', formula: 'Al', type: 'fcc', a: 4.05, elements: ['Al'], note: 'FCC, 12 nearest neighbours, packing factor 0.74.', aliases: ['aluminum', 'aluminium'] },
  { name: 'Nickel', formula: 'Ni', type: 'fcc', a: 3.524, elements: ['Ni'], note: 'FCC.', aliases: ['nickel'] },
  { name: 'Silver', formula: 'Ag', type: 'fcc', a: 4.086, elements: ['Ag'], note: 'FCC.', aliases: ['silver'] },
  { name: 'Gold', formula: 'Au', type: 'fcc', a: 4.078, elements: ['Au'], note: 'FCC.', aliases: ['gold'] },
  { name: 'Lead', formula: 'Pb', type: 'fcc', a: 4.95, elements: ['Pb'], note: 'FCC.', aliases: ['lead'] },
  { name: 'Platinum', formula: 'Pt', type: 'fcc', a: 3.924, elements: ['Pt'], note: 'FCC.', aliases: ['platinum'] },
  { name: 'Tungsten', formula: 'W', type: 'bcc', a: 3.165, elements: ['W'], note: 'BCC, 8 nearest neighbours, packing factor 0.68.', aliases: ['tungsten', 'bcc'] },
  { name: 'Chromium', formula: 'Cr', type: 'bcc', a: 2.885, elements: ['Cr'], note: 'BCC.', aliases: ['chromium'] },
  { name: 'Molybdenum', formula: 'Mo', type: 'bcc', a: 3.147, elements: ['Mo'], note: 'BCC.', aliases: ['molybdenum'] },
  { name: 'Vanadium', formula: 'V', type: 'bcc', a: 3.03, elements: ['V'], note: 'BCC.', aliases: ['vanadium'] },
  { name: 'Sodium', formula: 'Na', type: 'bcc', a: 4.291, elements: ['Na'], note: 'BCC alkali metal.', aliases: ['sodium'] },
  { name: 'Potassium', formula: 'K', type: 'bcc', a: 5.328, elements: ['K'], note: 'BCC alkali metal.', aliases: ['potassium'] },
  { name: 'Lithium', formula: 'Li', type: 'bcc', a: 3.49, elements: ['Li'], note: 'BCC alkali metal.', aliases: ['lithium'] },
  { name: 'Magnesium', formula: 'Mg', type: 'hcp', a: 3.209, c: 5.211, elements: ['Mg'], note: 'HCP, c/a = 1.624, close to the ideal 1.633.', aliases: ['magnesium', 'hcp'] },
  { name: 'Zinc', formula: 'Zn', type: 'hcp', a: 2.665, c: 4.947, elements: ['Zn'], note: 'HCP with a stretched c axis (c/a = 1.86).', aliases: ['zinc'] },
  { name: 'Titanium (alpha)', formula: 'Ti', type: 'hcp', a: 2.951, c: 4.684, elements: ['Ti'], note: 'HCP below 882 °C, BCC above.', aliases: ['titanium'] },
  { name: 'Cobalt', formula: 'Co', type: 'hcp', a: 2.507, c: 4.069, elements: ['Co'], note: 'HCP at room temperature.', aliases: ['cobalt'] },
  { name: 'Polonium', formula: 'Po', type: 'sc', a: 3.359, elements: ['Po'], note: 'The only element that is simple cubic at room temperature.', aliases: ['polonium', 'simple cubic', 'sc'] },
  // Covalent networks
  { name: 'Diamond', formula: 'C', type: 'diamond', a: 3.567, elements: ['C'], note: 'Every carbon is sp3 bonded to four neighbours; hardest natural material.', aliases: ['diamond', 'diamond cubic'] },
  { name: 'Silicon', formula: 'Si', type: 'diamond', a: 5.431, elements: ['Si'], note: 'Diamond cubic; the semiconductor lattice.', aliases: ['silicon'] },
  { name: 'Germanium', formula: 'Ge', type: 'diamond', a: 5.658, elements: ['Ge'], note: 'Diamond cubic.', aliases: ['germanium'] },
  { name: 'Graphite', formula: 'C', type: 'graphite', a: 2.461, c: 6.708, elements: ['C'], note: 'sp2 layers 3.35 Å apart held by van der Waals forces, which is why it lubricates and conducts.', aliases: ['graphite', 'graphene'] },
  { name: 'Silicon carbide (3C)', formula: 'SiC', type: 'zincblende', a: 4.36, elements: ['Si', 'C'], note: 'Cubic beta SiC, zinc blende structure.', aliases: ['silicon carbide', 'carborundum', 'sic'] },
  { name: 'Gallium arsenide', formula: 'GaAs', type: 'zincblende', a: 5.653, elements: ['Ga', 'As'], note: 'Zinc blende; the direct band gap III-V semiconductor.', aliases: ['gallium arsenide', 'gaas'] },
  { name: 'Zinc sulfide (sphalerite)', formula: 'ZnS', type: 'zincblende', a: 5.41, elements: ['Zn', 'S'], note: 'The zinc blende prototype.', aliases: ['zinc sulfide', 'sphalerite', 'zinc blende', 'zns'] },
  { name: 'Cadmium telluride', formula: 'CdTe', type: 'zincblende', a: 6.48, elements: ['Cd', 'Te'], note: 'Zinc blende; thin film solar cells.', aliases: ['cadmium telluride', 'cdte'] },
  // Ionic
  { name: 'Sodium chloride (rock salt)', formula: 'NaCl', type: 'rocksalt', a: 5.64, elements: ['Na', 'Cl'], note: 'Two interpenetrating FCC lattices; each ion has 6 neighbours of the other kind.', aliases: ['sodium chloride', 'rock salt', 'halite', 'table salt', 'nacl', 'salt'] },
  { name: 'Potassium chloride', formula: 'KCl', type: 'rocksalt', a: 6.29, elements: ['K', 'Cl'], note: 'Rock salt structure.', aliases: ['potassium chloride', 'kcl', 'sylvite'] },
  { name: 'Magnesium oxide', formula: 'MgO', type: 'rocksalt', a: 4.212, elements: ['Mg', 'O'], note: 'Rock salt structure; refractory ceramic.', aliases: ['magnesium oxide', 'periclase', 'magnesia', 'mgo'] },
  { name: 'Calcium oxide', formula: 'CaO', type: 'rocksalt', a: 4.81, elements: ['Ca', 'O'], note: 'Rock salt structure; quicklime.', aliases: ['calcium oxide', 'quicklime', 'lime', 'cao'] },
  { name: 'Lithium fluoride', formula: 'LiF', type: 'rocksalt', a: 4.03, elements: ['Li', 'F'], note: 'Rock salt structure.', aliases: ['lithium fluoride', 'lif'] },
  { name: 'Lead sulfide (galena)', formula: 'PbS', type: 'rocksalt', a: 5.936, elements: ['Pb', 'S'], note: 'Rock salt structure.', aliases: ['lead sulfide', 'galena', 'pbs'] },
  { name: 'Caesium chloride', formula: 'CsCl', type: 'cscl', a: 4.123, elements: ['Cs', 'Cl'], note: 'Simple cubic of each ion, offset by half the body diagonal; coordination 8.', aliases: ['cesium chloride', 'caesium chloride', 'cscl'] },
  { name: 'Calcium fluoride (fluorite)', formula: 'CaF2', type: 'fluorite', a: 5.463, elements: ['Ca', 'F'], note: 'Ca in FCC, F in every tetrahedral hole; Ca has 8 neighbours, F has 4.', aliases: ['calcium fluoride', 'fluorite', 'fluorspar', 'caf2'] },
  { name: 'Zirconia (cubic)', formula: 'ZrO2', type: 'fluorite', a: 5.09, elements: ['Zr', 'O'], note: 'Yttria stabilised zirconia keeps this fluorite structure to room temperature.', aliases: ['zirconia', 'zirconium dioxide', 'zirconium oxide', 'zro2', 'ysz'] },
  { name: 'Uranium dioxide', formula: 'UO2', type: 'fluorite', a: 5.47, elements: ['U', 'O'], note: 'Fluorite structure; nuclear fuel pellets.', aliases: ['uranium dioxide', 'uo2'] },
  { name: 'Barium titanate', formula: 'BaTiO3', type: 'perovskite', a: 4.01, elements: ['Ba', 'Ti', 'O'], note: 'Cubic perovskite above 120 °C; the ferroelectric ceramic in capacitors.', aliases: ['barium titanate', 'batio3', 'perovskite'] },
  { name: 'Calcium titanate', formula: 'CaTiO3', type: 'perovskite', a: 3.84, elements: ['Ca', 'Ti', 'O'], note: 'The mineral perovskite itself, shown as the ideal cubic cell.', aliases: ['calcium titanate', 'catio3'] },
  { name: 'Strontium titanate', formula: 'SrTiO3', type: 'perovskite', a: 3.905, elements: ['Sr', 'Ti', 'O'], note: 'Cubic perovskite at room temperature; common substrate for oxide films.', aliases: ['strontium titanate', 'srtio3'] },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Match a query against formulas, names and aliases. */
export function findLattice(query: string): LatticeSpec | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return (
    LATTICE_MATERIALS.find((m) => norm(m.formula) === q && !m.aliases?.includes('austenite')) ??
    LATTICE_MATERIALS.find((m) => norm(m.name) === q) ??
    LATTICE_MATERIALS.find((m) => m.aliases?.some((a) => norm(a) === q))
  );
}

export interface LatticeCluster extends Structure3D {
  spec: LatticeSpec;
  title: string;
  repeat: number;
  /** Cell vectors in angstrom. */
  cell: { a: Vec; b: Vec; c: Vec };
  atomsPerCell: number;
  coordination: number;
  packingFactor?: number;
}

function cellVectors(spec: LatticeSpec, def: CellDefinition): { a: Vec; b: Vec; c: Vec } {
  if (def.hexagonal) {
    const a = spec.a;
    const c = spec.c ?? a * 1.633;
    return { a: [a, 0, 0], b: [-a / 2, (a * Math.sqrt(3)) / 2, 0], c: [0, 0, c] };
  }
  return { a: [spec.a, 0, 0], b: [0, spec.a, 0], c: [0, 0, spec.a] };
}

/** Build an atom cluster of `repeat` cells per axis (boundary included). */
export function buildLattice(spec: LatticeSpec, repeat = 2): LatticeCluster {
  const def = CELLS[spec.type];
  const cell = cellVectors(spec, def);
  const atoms: Atom3D[] = [];
  const seen = new Set<string>();
  const eps = 1e-6;
  for (const site of def.sites) {
    const symbol = spec.elements[site.role] ?? spec.elements[0];
    for (const [fx, fy, fz] of site.positions) {
      for (let i = 0; i <= repeat; i++) {
        for (let j = 0; j <= repeat; j++) {
          for (let k = 0; k <= repeat; k++) {
            const u = fx + i;
            const v = fy + j;
            const w = fz + k;
            if (u > repeat + eps || v > repeat + eps || w > repeat + eps) continue;
            const x = u * cell.a[0] + v * cell.b[0] + w * cell.c[0];
            const y = u * cell.a[1] + v * cell.b[1] + w * cell.c[1];
            const z = u * cell.a[2] + v * cell.b[2] + w * cell.c[2];
            const key = `${symbol}:${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            atoms.push({ symbol, x, y, z, charge: 0 });
          }
        }
      }
    }
  }
  const bonds: Bond3D[] = def.covalent ? nearestNeighbourBonds(atoms, def.title === 'Graphite (AB layers)') : [];
  return {
    spec,
    title: def.title,
    repeat,
    cell,
    atoms,
    bonds,
    atomsPerCell: def.atomsPerCell,
    coordination: def.coordination,
    packingFactor: def.packingFactor,
  };
}

/** Bond every pair closer than 1.15 times the shortest distance. */
function nearestNeighbourBonds(atoms: Atom3D[], inPlaneOnly: boolean): Bond3D[] {
  let shortest = Infinity;
  const d2 = (p: Atom3D, q: Atom3D) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      if (inPlaneOnly && Math.abs(atoms[i].z - atoms[j].z) > 1e-3) continue;
      const d = d2(atoms[i], atoms[j]);
      if (d > 1e-6 && d < shortest) shortest = d;
    }
  }
  const cutoff = shortest * 1.15 ** 2;
  const bonds: Bond3D[] = [];
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      if (inPlaneOnly && Math.abs(atoms[i].z - atoms[j].z) > 1e-3) continue;
      if (d2(atoms[i], atoms[j]) <= cutoff) bonds.push({ a: i, b: j, order: 1 });
    }
  }
  return bonds;
}

/** The 12 edges of one unit cell at the origin, for drawing the cell outline. */
export function cellEdges(cell: { a: Vec; b: Vec; c: Vec }, repeat = 1): Array<[Vec, Vec]> {
  const add = (...vs: Vec[]): Vec => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
  const scale = (v: Vec, k: number): Vec => [v[0] * k, v[1] * k, v[2] * k];
  const a = scale(cell.a, repeat);
  const b = scale(cell.b, repeat);
  const c = scale(cell.c, repeat);
  const o: Vec = [0, 0, 0];
  const corners: Vec[] = [o, a, b, c, add(a, b), add(a, c), add(b, c), add(a, b, c)];
  const pairs: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4], [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7],
  ];
  return pairs.map(([i, j]) => [corners[i], corners[j]]);
}
