// OpenChemLib wrappers: SMILES in, 2D SVG and 3D coordinates out.
//
// Everything here is synchronous and CPU bound. Conformer generation costs
// between 1 ms (water) and about a second (sugars with several stereo
// centres), which is why the library precomputes its 3D structures and the
// resolver caches what it generates at runtime.

import * as OCL from 'openchemlib';
import { hillFormula } from './formula.ts';
import type { Counts } from './formula.ts';

// The conformer generator needs OCL's static tables. Reading them relative
// to the module is a one time cost of a few milliseconds.
OCL.Resources.registerFromNodejs();

export interface Atom3D {
  symbol: string;
  x: number;
  y: number;
  z: number;
  charge: number;
}

export interface Bond3D {
  /** Zero based atom indices. */
  a: number;
  b: number;
  /** 1, 2, 3; aromatic bonds are reported as 1 or 2 by the Kekulé form. */
  order: number;
}

export interface Structure3D {
  atoms: Atom3D[];
  bonds: Bond3D[];
}

/** Parse a SMILES string; null when OCL rejects it. */
export function parseSmiles(smiles: string): OCL.Molecule | null {
  try {
    const mol = OCL.Molecule.fromSmiles(smiles.trim());
    return mol.getAllAtoms() > 0 ? mol : null;
  } catch {
    return null;
  }
}

export function isValidSmiles(smiles: string): boolean {
  return parseSmiles(smiles) !== null;
}

/** Heavy atom count of a parsed molecule (hydrogens excluded). */
function heavyAtoms(mol: OCL.Molecule): number {
  let n = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) if (mol.getAtomicNo(i) !== 1) n++;
  return n;
}

export interface SvgOptions {
  width?: number;
  height?: number;
  /** 'auto' draws hydrogens for molecules with at most 3 heavy atoms. */
  hydrogens?: boolean | 'auto';
  /** Colour for bonds and carbon labels. Default 'currentColor'. */
  foreground?: string;
  id?: string;
}

/**
 * 2D depiction as an SVG string. OCL colours heteroatom labels by CPK and
 * draws bonds in black; the black is replaced with `foreground` so the
 * image follows the page theme when inlined.
 */
export function smilesToSvg(smiles: string, options: SvgOptions = {}): string | null {
  const mol = parseSmiles(smiles);
  if (!mol) return null;
  const { width = 480, height = 360, hydrogens = 'auto', foreground = 'currentColor', id = 'mol' } = options;
  const explicit = hydrogens === true || (hydrogens === 'auto' && heavyAtoms(mol) <= 3);
  if (explicit) mol.addImplicitHydrogens();
  const svg = mol.toSVG(width, height, id, {
    autoCrop: true,
    autoCropMargin: 10,
    suppressChiralText: true,
    suppressCIPParity: true,
    suppressESR: true,
    fontWeight: 'normal',
  });
  return svg
    .replace(/rgb\(0,0,0\)/g, foreground)
    .replace(/[ \t]*<(?:circle|line) id="[^"]*" class="event"[^>]*\/>\r?\n?/g, '');
}

/**
 * Generate 3D coordinates with hydrogens and return a V2000 molfile. Null
 * when the SMILES is invalid or the generator gives up (very large or
 * unusual molecules). Disconnected fragments (salts) are placed apart.
 */
export function smilesToMolfile3D(smiles: string, seed = 42): string | null {
  const mol = parseSmiles(smiles);
  if (!mol) return null;
  mol.addImplicitHydrogens();
  try {
    const generator = new OCL.ConformerGenerator(seed);
    const conformer = generator.getOneConformerAsMolecule(mol);
    if (!conformer) return null;
    return conformer.toMolfile();
  } catch {
    return null;
  }
}

/** Read atoms and bonds from a molfile or the first record of an SDF. */
export function molfileToStructure(molfile: string): Structure3D | null {
  try {
    const first = molfile.split(/\$\$\$\$/)[0];
    const mol = OCL.Molecule.fromMolfile(first);
    const atoms: Atom3D[] = [];
    for (let i = 0; i < mol.getAllAtoms(); i++) {
      atoms.push({
        symbol: mol.getAtomLabel(i),
        x: mol.getAtomX(i),
        y: mol.getAtomY(i),
        z: mol.getAtomZ(i),
        charge: mol.getAtomCharge(i),
      });
    }
    const bonds: Bond3D[] = [];
    for (let i = 0; i < mol.getAllBonds(); i++) {
      bonds.push({ a: mol.getBondAtom(0, i), b: mol.getBondAtom(1, i), order: mol.getBondOrder(i) });
    }
    return atoms.length ? { atoms, bonds } : null;
  } catch {
    return null;
  }
}

/** Molecular formula (Hill order) and molar mass as OCL computes them. */
export function smilesToFormula(smiles: string): { hill: string; counts: Counts; weight: number } | null {
  const mol = parseSmiles(smiles);
  if (!mol) return null;
  mol.addImplicitHydrogens();
  const counts: Counts = {};
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    const sym = mol.getAtomLabel(i);
    counts[sym] = (counts[sym] ?? 0) + 1;
  }
  return { hill: hillFormula(counts), counts, weight: mol.getMolecularFormula().relativeWeight };
}

/** Total charge of a SMILES (sum of atom charges). */
export function smilesCharge(smiles: string): number {
  const mol = parseSmiles(smiles);
  if (!mol) return 0;
  let q = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) q += mol.getAtomCharge(i);
  return q;
}

/** XYZ text: count, comment, then one 'Symbol x y z' line per atom. */
export function structureToXyz(structure: Structure3D, comment = ''): string {
  const lines = [String(structure.atoms.length), comment.replace(/\r?\n/g, ' ')];
  for (const a of structure.atoms) {
    lines.push(`${a.symbol} ${a.x.toFixed(4)} ${a.y.toFixed(4)} ${a.z.toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}

/** Minimal PDB (HETATM + CONECT) for viewers that want explicit bonds. */
export function structureToPdb(structure: Structure3D, name = 'MOL'): string {
  const out: string[] = [`COMPND    ${name}`];
  structure.atoms.forEach((a, i) => {
    const serial = String(i + 1).padStart(5);
    const label = (a.symbol + String(i + 1)).slice(0, 4).padEnd(4);
    const x = a.x.toFixed(3).padStart(8);
    const y = a.y.toFixed(3).padStart(8);
    const z = a.z.toFixed(3).padStart(8);
    const sym = a.symbol.toUpperCase().padStart(2);
    out.push(`HETATM${serial} ${label} UNL     1    ${x}${y}${z}  1.00  0.00          ${sym}`);
  });
  const neighbours = new Map<number, number[]>();
  for (const b of structure.bonds) {
    (neighbours.get(b.a) ?? neighbours.set(b.a, []).get(b.a)!).push(b.b);
    (neighbours.get(b.b) ?? neighbours.set(b.b, []).get(b.b)!).push(b.a);
  }
  for (const [i, list] of [...neighbours.entries()].sort((p, q) => p[0] - q[0])) {
    out.push('CONECT' + String(i + 1).padStart(5) + list.map((j) => String(j + 1).padStart(5)).join(''));
  }
  out.push('END');
  return out.join('\n') + '\n';
}

/** Build a V2000 molfile from explicit atoms and bonds (used for lattices). */
export function structureToMolfile(structure: Structure3D, name = 'structure'): string {
  const lines = [name, '  ChemTool 3D', ''];
  const n = structure.atoms.length;
  const m = structure.bonds.length;
  lines.push(`${String(n).padStart(3)}${String(m).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`);
  for (const a of structure.atoms) {
    lines.push(
      `${a.x.toFixed(4).padStart(10)}${a.y.toFixed(4).padStart(10)}${a.z.toFixed(4).padStart(10)} ${a.symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`,
    );
  }
  for (const b of structure.bonds) {
    lines.push(`${String(b.a + 1).padStart(3)}${String(b.b + 1).padStart(3)}${String(b.order).padStart(3)}  0  0  0  0`);
  }
  const charged = structure.atoms.map((a, i) => [i + 1, a.charge] as const).filter(([, q]) => q !== 0);
  for (let i = 0; i < charged.length; i += 8) {
    const chunk = charged.slice(i, i + 8);
    lines.push(`M  CHG${String(chunk.length).padStart(3)}` + chunk.map(([idx, q]) => `${String(idx).padStart(4)}${String(q).padStart(4)}`).join(''));
  }
  lines.push('M  END');
  return lines.join('\n') + '\n';
}
