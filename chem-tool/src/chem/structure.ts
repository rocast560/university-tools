// OpenChemLib wrappers. Everything here is synchronous and CPU bound. 3D generation costs
// 1 ms (water) to about 1 s (sugars with stereocentres).

import * as OCL from 'openchemlib';
import { bySymbol } from './elements';
import type { Counts } from './formula';
import type { Atom, Bond, Geometry } from './types';

let registered = false;
/** The conformer generator needs OCL's static tables; register them once. */
export function ensureResources(): void {
  if (!registered) { OCL.Resources.registerFromNodejs(); registered = true; }
}

/** True when parens/brackets are unbalanced; OpenChemLib's fromSmiles silently drops
 *  unmatched ones (e.g. "C(" parses as a bare carbon) instead of throwing. */
function hasUnbalancedGroups(smiles: string): boolean {
  let parens = 0;
  let brackets = 0;
  for (const ch of smiles) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (parens < 0 || brackets < 0) return true;
  }
  return parens !== 0 || brackets !== 0;
}

export function parseSmiles(smiles: string): OCL.Molecule | null {
  const trimmed = smiles.trim();
  if (hasUnbalancedGroups(trimmed)) return null;
  try {
    const mol = OCL.Molecule.fromSmiles(trimmed);
    return mol.getAllAtoms() > 0 ? mol : null;
  } catch { return null; }
}

export function parseMolfile(molfile: string): OCL.Molecule | null {
  try {
    const mol = OCL.Molecule.fromMolfile(molfile.split(/\$\$\$\$/)[0]);
    return mol.getAllAtoms() > 0 ? mol : null;
  } catch { return null; }
}

export function heavyAtomCount(mol: OCL.Molecule): number {
  let n = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) if (mol.getAtomicNo(i) !== 1) n++;
  return n;
}

/** Copy without explicit hydrogens. A hydrogen-only molecule (H2) keeps them. */
export function heavyCopy(mol: OCL.Molecule): OCL.Molecule {
  const c = mol.getCompactCopy();
  if (heavyAtomCount(c) > 0) c.removeExplicitHydrogens();
  return c;
}

export interface SvgOptions { width?: number; height?: number; numbered?: boolean; hydrogens?: boolean | 'auto' }

/**
 * Skeletal 2D drawing. Black is replaced by currentColor so the SVG follows the page theme.
 * `numbered` labels every heavy atom "C1", "O3" (1-based, heavy-first order).
 */
export function toSvg(source: OCL.Molecule, opts: SvgOptions = {}): string {
  const { width = 480, height = 360, numbered = false, hydrogens = 'auto' } = opts;
  const mol = heavyCopy(source);
  if (numbered) {
    for (let i = 0; i < mol.getAllAtoms(); i++) mol.setAtomCustomLabel(i, `${mol.getAtomLabel(i)}${i + 1}`);
  } else if (hydrogens === true || (hydrogens === 'auto' && heavyAtomCount(mol) <= 3)) {
    mol.addImplicitHydrogens();
  }
  const svg = mol.toSVG(width, height, 'mol', {
    autoCrop: true, autoCropMargin: 12, suppressChiralText: true, suppressCIPParity: true, suppressESR: true, fontWeight: 'normal',
  });
  return svg
    .replace(/rgb\(0,0,0\)/g, 'currentColor')
    .replace(/[ \t]*<(?:circle|line) id="[^"]*" class="event"[^>]*\/>\r?\n?/g, '');
}

/** New molecule with heavy atoms first, hydrogens after; coordinates, charges and bond orders copied. */
export function reorderHeavyFirst(mol: OCL.Molecule): OCL.Molecule {
  const n = mol.getAllAtoms();
  const order = [...Array(n).keys()].sort((a, b) => Number(mol.getAtomicNo(a) === 1) - Number(mol.getAtomicNo(b) === 1) || a - b);
  const map = new Map(order.map((old, i) => [old, i]));
  const out = new OCL.Molecule(n, mol.getAllBonds());
  for (const old of order) {
    const a = out.addAtom(mol.getAtomicNo(old));
    out.setAtomX(a, mol.getAtomX(old)); out.setAtomY(a, mol.getAtomY(old)); out.setAtomZ(a, mol.getAtomZ(old));
    out.setAtomCharge(a, mol.getAtomCharge(old));
  }
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const nb = out.addBond(map.get(mol.getBondAtom(0, b))!, map.get(mol.getBondAtom(1, b))!);
    out.setBondOrder(nb, mol.getBondOrder(b));
  }
  return out;
}

function tryConformer(mol: OCL.Molecule, seed: number): OCL.Molecule | null {
  try { return new OCL.ConformerGenerator(seed).getOneConformerAsMolecule(mol) ?? null; } catch { return null; }
}

// Unit vectors for ideal geometries by number of neighbours (VSEPR without lone pairs).
const STAR: Record<number, [number, number, number][]> = {
  1: [[1, 0, 0]],
  2: [[1, 0, 0], [-1, 0, 0]],
  3: [[1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0]],
  4: [[0.577, 0.577, 0.577], [-0.577, -0.577, 0.577], [-0.577, 0.577, -0.577], [0.577, -0.577, -0.577]],
  5: [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0]],
  6: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
};

/** Ideal geometry for a "star": one centre bonded to every other atom (MnO4-, SF6, CH4 ...). */
function starGeometry(mol: OCL.Molecule): OCL.Molecule | null {
  const n = mol.getAllAtoms();
  if (n < 2 || n > 7) return null;
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  let centre = 0;
  for (let i = 1; i < n; i++) if (mol.getConnAtoms(i) > mol.getConnAtoms(centre)) centre = i;
  if (mol.getConnAtoms(centre) !== n - 1) return null;
  for (let i = 0; i < n; i++) if (i !== centre && mol.getConnAtoms(i) !== 1) return null;
  const out = mol.getCompactCopy();
  const rc = bySymbol(mol.getAtomLabel(centre))?.radius ?? 1.2;
  out.setAtomX(centre, 0); out.setAtomY(centre, 0); out.setAtomZ(centre, 0);
  const dirs = STAR[n - 1];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === centre) continue;
    const len = rc + (bySymbol(mol.getAtomLabel(i))?.radius ?? 0.7);
    const [dx, dy, dz] = dirs[k++];
    out.setAtomX(i, dx * len); out.setAtomY(i, dy * len); out.setAtomZ(i, dz * len);
  }
  return out;
}

const RANK: Record<Geometry, number> = { conformer: 0, star: 1, flat: 2 };

function layoutFragments(parts: { mol: OCL.Molecule; geometry: Geometry }[]): { mol: OCL.Molecule; geometry: Geometry } {
  const total = parts.reduce((s, p) => s + p.mol.getAllAtoms(), 0);
  const out = new OCL.Molecule(total, total);
  let cursor = 0;
  let geometry: Geometry = 'conformer';
  for (const { mol, geometry: g } of parts) {
    if (RANK[g] > RANK[geometry]) geometry = g;
    const xs = [...Array(mol.getAllAtoms()).keys()].map((i) => mol.getAtomX(i));
    const offset = cursor - Math.min(...xs);
    const map: number[] = [];
    for (let i = 0; i < mol.getAllAtoms(); i++) {
      const a = out.addAtom(mol.getAtomicNo(i));
      out.setAtomX(a, mol.getAtomX(i) + offset); out.setAtomY(a, mol.getAtomY(i)); out.setAtomZ(a, mol.getAtomZ(i));
      out.setAtomCharge(a, mol.getAtomCharge(i));
      map.push(a);
    }
    for (let b = 0; b < mol.getAllBonds(); b++) {
      const nb = out.addBond(map[mol.getBondAtom(0, b)], map[mol.getBondAtom(1, b)]);
      out.setBondOrder(nb, mol.getBondOrder(b));
    }
    cursor = Math.max(...xs) + offset + 2.5;
  }
  return { mol: reorderHeavyFirst(out), geometry };
}

/**
 * 3D coordinates with explicit hydrogens, heavy atoms first. Disconnected fragments (salts)
 * are generated separately and placed side by side along x, 2.5 Å apart. When the conformer
 * generator gives up (metal centres) an ideal star geometry is used; failing that, 2D
 * coordinates with z = 0.
 */
export function to3D(source: OCL.Molecule, seed = 42): { mol: OCL.Molecule; geometry: Geometry } {
  ensureResources();
  const mol = source.getCompactCopy();
  mol.addImplicitHydrogens();
  const frags = mol.getFragments();
  if (frags.length > 1) return layoutFragments(frags.map((f) => to3D(f, seed)));
  const conf = tryConformer(mol, seed);
  if (conf) return { mol: reorderHeavyFirst(conf), geometry: 'conformer' };
  const star = starGeometry(mol);
  if (star) return { mol: reorderHeavyFirst(star), geometry: 'star' };
  const flat = mol.getCompactCopy();
  flat.inventCoordinates();
  for (let i = 0; i < flat.getAllAtoms(); i++) flat.setAtomZ(i, 0);
  return { mol: reorderHeavyFirst(flat), geometry: 'flat' };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** Atoms and bonds with 1-based indices in the molecule's own order (call on a heavy-first molecule). */
export function extractAtomsBonds(mol: OCL.Molecule): { atoms: Atom[]; bonds: Bond[] } {
  mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const atoms: Atom[] = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    atoms.push({ index: i + 1, element: mol.getAtomLabel(i), x: round(mol.getAtomX(i)), y: round(mol.getAtomY(i)), z: round(mol.getAtomZ(i)), charge: mol.getAtomCharge(i) });
  }
  const bonds: Bond[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    bonds.push({ a: mol.getBondAtom(0, b) + 1, b: mol.getBondAtom(1, b) + 1, order: Math.min(3, Math.max(1, mol.getBondOrder(b))) as 1 | 2 | 3, aromatic: mol.isAromaticBond(b) });
  }
  return { atoms, bonds };
}

/** Element counts including implicit hydrogens. */
export function countsOf(mol: OCL.Molecule): Counts {
  const c = mol.getCompactCopy();
  c.addImplicitHydrogens();
  const counts: Counts = {};
  for (let i = 0; i < c.getAllAtoms(); i++) {
    const sym = c.getAtomLabel(i);
    counts[sym] = (counts[sym] ?? 0) + 1;
  }
  return counts;
}

export function totalCharge(mol: OCL.Molecule): number {
  let q = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) q += mol.getAtomCharge(i);
  return q;
}

export function canonicalSmiles(mol: OCL.Molecule): string {
  return heavyCopy(mol).toIsomericSmiles();
}

export function molfile2D(mol: OCL.Molecule): string {
  const c = heavyCopy(mol);
  c.inventCoordinates();
  return c.toMolfile();
}

export function molfile3D(mol3d: OCL.Molecule): string {
  return mol3d.toMolfile();
}
