// Shared record shapes for the library file, the resolver and the API.

export type Kind = 'molecule' | 'ionic' | 'element' | 'network';

export interface LibraryEntry {
  /** URL safe slug, unique: 'acetic-acid'. */
  id: string;
  name: string;
  /** Conventional display formula: 'CH3COOH'. */
  formula: string;
  /** Hill order key used for matching: 'C2H4O2'. */
  hill: string;
  aliases: string[];
  category: string;
  tags: string[];
  note: string;
  kind: Kind;
  /** Isomeric SMILES from PubChem. */
  smiles: string;
  iupac: string;
  cid: number;
  cas?: string;
  /** Computed from the element table so it agrees with formula_info. */
  molarMass: number;
  charge: number;
  /** Where data/sdf/<id>.sdf came from. */
  sdfSource: 'pubchem3d' | 'ocl' | 'none';
  /** Position in the seed list; lower wins formula collisions. */
  rank: number;
}

export interface LibraryFile {
  generatedAt: string;
  entries: LibraryEntry[];
}

/** A compound as the API returns it (library or PubChem or raw SMILES). */
export interface Compound {
  id: string;
  name: string;
  formula: string;
  formulaHtml: string;
  formulaUnicode: string;
  hill: string;
  molarMass: number;
  charge: number;
  smiles: string;
  iupac: string;
  aliases: string[];
  category: string;
  tags: string[];
  note: string;
  kind: Kind;
  cid: number | null;
  cas: string | null;
  source: 'library' | 'pubchem' | 'smiles' | 'lattice';
  pubchemUrl: string | null;
}

export interface Resolved {
  query: string;
  matchedOn: 'name' | 'formula' | 'smiles' | 'cas' | 'cid' | 'lattice';
  compound: Compound;
  /** Other compounds with the same formula, most common first. */
  alternatives: Compound[];
  svg: string | null;
  /** V2000 molfile with 3D coordinates, or null when none could be made. */
  molfile: string | null;
  structureSource: 'pubchem3d' | 'ocl' | 'lattice' | 'none';
  composition: Array<{ symbol: string; name: string; count: number; mass: number; massPercent: number }>;
  warnings: string[];
}
