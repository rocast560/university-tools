// Builds immutable Species records: the one place that turns a molecule into everything the
// workspace, the window and the MCP tools need.

import type * as OCL from 'openchemlib';
import { composition, hillFormula, molarMass } from './formula';
import {
  canonicalSmiles, countsOf, extractAtomsBonds, molfile2D, molfile3D, parseMolfile, parseSmiles,
  reorderHeavyFirst, to3D, toSvg, totalCharge,
} from './structure';
import type { Geometry, Source, Species } from './types';

export class SpeciesError extends Error {}

export interface SpeciesSeed {
  name: string;
  smiles?: string;
  molfile?: string;
  /** Precomputed 3D molfile (library entries); skips conformer generation. */
  molfile3d?: string;
  source: Source;
  displayFormula?: string;
  iupacName?: string;
  cid?: number;
  cas?: string;
  description?: string;
  category?: string;
  id?: string;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function buildSpecies(seed: SpeciesSeed): Species {
  const mol = seed.molfile ? parseMolfile(seed.molfile) : seed.smiles ? parseSmiles(seed.smiles) : null;
  if (!mol) throw new SpeciesError(`Cannot parse the structure of "${seed.name}"`);
  return speciesFromMolecule(mol, seed);
}

export function speciesFromMolecule(mol: OCL.Molecule, seed: SpeciesSeed): Species {
  let mol3d: OCL.Molecule;
  let geometry: Geometry;
  const pre = seed.molfile3d ? parseMolfile(seed.molfile3d) : null;
  if (pre) {
    mol3d = reorderHeavyFirst(pre);
    geometry = 'conformer';
  } else {
    ({ mol: mol3d, geometry } = to3D(mol));
  }
  const { atoms, bonds } = extractAtomsBonds(mol3d);
  const counts = countsOf(mol3d);
  const charge = totalCharge(mol3d);
  const formula = hillFormula(counts, charge);
  return {
    id: seed.id ?? newId(),
    name: seed.name,
    iupacName: seed.iupacName,
    formula,
    displayFormula: seed.displayFormula ?? formula,
    charge,
    source: seed.source,
    cid: seed.cid,
    cas: seed.cas,
    description: seed.description,
    category: seed.category,
    smiles: canonicalSmiles(mol3d),
    molfile2d: molfile2D(mol3d),
    molfile3d: molfile3D(mol3d),
    geometry,
    atoms,
    bonds,
    info: { molarMass: Math.round(molarMass(counts) * 1000) / 1000, composition: composition(counts) },
    svg2d: toSvg(mol3d),
    svg2dNumbered: toSvg(mol3d, { numbered: true }),
  };
}
