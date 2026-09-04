// The lookup pipeline: a free text query in, a fully described compound
// with its 2D picture and 3D structure out.
//
// Order of attempts (first hit wins):
//   1. CID ('cid:962' or digits only)      library, then PubChem
//   2. CAS number ('64-17-5')              library, then PubChem
//   3. name or alias                       library
//   4. formula (any spelling)              library, ranked, others as alternatives
//   5. SMILES that is clearly SMILES       OpenChemLib, matched back to the library by structure
//   6. formula                             PubChem (only for plausible formulas)
//   7. name                                PubChem
//   8. anything OpenChemLib parses         treated as SMILES
// Crystal lattices (rock salt, bcc iron, diamond) are attached when the
// hit has one, and can answer a query on their own ('perovskite').

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as OCL from 'openchemlib';
import { composition, formatFormulaHtml, formatFormulaUnicode, looksLikeFormula, molarMass, parseFormula, type Counts } from './formula.ts';
import { buildLattice, findLattice, type LatticeSpec } from './lattice.ts';
import { library as defaultLibrary, Library } from './library.ts';
import { SDF_DIR } from './paths.ts';
import { findCas, pubchem as defaultPubchem, PubChem, PubChemUnavailable, type PubChemCompound } from './pubchem.ts';
import { parseSmiles, smilesCharge, smilesToFormula, smilesToMolfile3D, smilesToSvg, structureToMolfile } from './structure.ts';
import type { Compound, LibraryEntry, Resolved } from './types.ts';

export interface ResolveDeps {
  library?: Library;
  pubchem?: PubChem;
  sdfDir?: string;
  /** Set false to answer from the library only (tests, offline). */
  allowPubchem?: boolean;
}

export interface LatticeInfo {
  name: string;
  formula: string;
  type: string;
  title: string;
  note: string;
  a: number;
  c?: number;
  atomsPerCell: number;
  coordination: number;
  packingFactor?: number;
}

export type ResolveResult =
  | { ok: true; resolved: Resolved & { lattice?: LatticeInfo } }
  | { ok: false; error: string; suggestions: Array<{ id: string; name: string; formula: string }>; pubchemDown?: boolean };

const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

function sdfCache(): Map<string, Promise<string | null>> {
  return new Map();
}
const sdfFiles = sdfCache();

async function librarySdf(entry: LibraryEntry, dir: string): Promise<string | null> {
  if (entry.sdfSource === 'none') return null;
  const key = path.join(dir, `${entry.id}.sdf`);
  let pending = sdfFiles.get(key);
  if (!pending) {
    pending = readFile(key, 'utf8').catch(() => null);
    sdfFiles.set(key, pending);
  }
  return pending;
}

function compoundFromEntry(e: LibraryEntry): Compound {
  return {
    id: e.id,
    name: e.name,
    formula: e.formula,
    formulaHtml: formatFormulaHtml(e.formula),
    formulaUnicode: formatFormulaUnicode(e.formula),
    hill: e.hill,
    molarMass: e.molarMass,
    charge: e.charge,
    smiles: e.smiles,
    iupac: e.iupac,
    aliases: e.aliases,
    category: e.category,
    tags: e.tags,
    note: e.note,
    kind: e.kind,
    cid: e.cid || null,
    cas: e.cas ?? null,
    source: 'library',
    pubchemUrl: e.cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${e.cid}` : null,
  };
}

function displayFormula(pubchemFormula: string): string {
  // PubChem writes ions as 'C2H3O2-' and 'NH4+'; keep as is, it is already Hill order.
  return pubchemFormula;
}

function compoundFromPubchem(p: PubChemCompound, cas: string | undefined, note: string | null): Compound {
  let hill = p.formula;
  let mass = p.weight;
  try {
    const parsed = parseFormula(p.formula, { lenient: false });
    hill = parsed.hill;
    mass = molarMass(parsed.counts);
  } catch {
    // keep PubChem's values
  }
  const name = p.title || p.iupac || p.formula;
  return {
    id: `cid-${p.cid}`,
    name,
    formula: displayFormula(p.formula),
    formulaHtml: formatFormulaHtml(p.formula),
    formulaUnicode: formatFormulaUnicode(p.formula),
    hill,
    molarMass: Math.round(mass * 1000) / 1000,
    charge: p.smiles ? smilesCharge(p.smiles) : 0,
    smiles: p.smiles,
    iupac: p.iupac,
    aliases: [],
    category: 'PubChem',
    tags: [],
    note: note ?? '',
    kind: p.smiles.includes('.') ? 'ionic' : 'molecule',
    cid: p.cid,
    cas: cas ?? null,
    source: 'pubchem',
    pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${p.cid}`,
  };
}

function compoundFromSmiles(smiles: string): Compound | null {
  const f = smilesToFormula(smiles);
  if (!f) return null;
  return {
    id: 'smiles',
    name: 'Custom structure',
    formula: f.hill,
    formulaHtml: formatFormulaHtml(f.hill),
    formulaUnicode: formatFormulaUnicode(f.hill),
    hill: f.hill,
    molarMass: Math.round(molarMass(f.counts) * 1000) / 1000,
    charge: smilesCharge(smiles),
    smiles,
    iupac: '',
    aliases: [],
    category: 'Custom',
    tags: [],
    note: 'Structure drawn from the SMILES you entered.',
    kind: smiles.includes('.') ? 'ionic' : 'molecule',
    cid: null,
    cas: null,
    source: 'smiles',
    pubchemUrl: null,
  };
}

function compoundFromLattice(spec: LatticeSpec, base?: LibraryEntry): Compound {
  const parsed = parseFormula(spec.formula, { lenient: false });
  const fromEntry = base ? compoundFromEntry(base) : null;
  return {
    id: fromEntry?.id ?? `lattice-${spec.type}-${spec.formula.toLowerCase()}`,
    name: spec.name,
    formula: spec.formula,
    formulaHtml: formatFormulaHtml(spec.formula),
    formulaUnicode: formatFormulaUnicode(spec.formula),
    hill: parsed.hill,
    molarMass: fromEntry?.molarMass ?? Math.round(molarMass(parsed.counts) * 1000) / 1000,
    charge: 0,
    smiles: fromEntry?.smiles ?? '',
    iupac: fromEntry?.iupac ?? '',
    aliases: [...new Set([...(spec.aliases ?? []), ...(fromEntry?.aliases ?? [])])],
    category: fromEntry?.category ?? 'Materials & semiconductors',
    tags: fromEntry?.tags ?? [],
    note: spec.note,
    kind: base?.kind ?? (spec.elements.length === 1 ? 'element' : 'ionic'),
    cid: fromEntry?.cid ?? null,
    cas: fromEntry?.cas ?? null,
    source: fromEntry ? 'library' : 'lattice',
    pubchemUrl: fromEntry?.pubchemUrl ?? null,
  };
}

function latticeInfo(spec: LatticeSpec): LatticeInfo {
  const cluster = buildLattice(spec, 1);
  return {
    name: spec.name,
    formula: spec.formula,
    type: spec.type,
    title: cluster.title,
    note: spec.note,
    a: spec.a,
    c: spec.c,
    atomsPerCell: cluster.atomsPerCell,
    coordination: cluster.coordination,
    packingFactor: cluster.packingFactor,
  };
}

function countsOf(compound: Compound): Counts {
  try {
    return parseFormula(compound.formula, { lenient: false }).counts;
  } catch {
    return smilesToFormula(compound.smiles)?.counts ?? {};
  }
}

/** Clear SMILES markers that a formula never has. */
export function looksLikeSmiles(q: string): boolean {
  if (/[=#@/\\%]/.test(q)) return true;
  if (/\[[A-Za-z][^\]]*\]/.test(q)) return true; // bracket atom
  if (/\(/.test(q) && !looksLikeFormula(q)) return true;
  if (/(^|[^A-Za-z])[cnosp]\d?[cnosp(]/.test(q)) return true; // aromatic runs
  return false;
}

/** Formulas worth sending to PubChem: real compounds, not 'C6' from a SMILES. */
function plausibleFormula(counts: Counts): boolean {
  const symbols = Object.keys(counts);
  if (symbols.length >= 2) return true;
  const [sym] = symbols;
  const n = counts[sym];
  if (n === 1) return true;
  if (['H', 'N', 'O', 'F', 'Cl', 'Br', 'I'].includes(sym)) return n <= 3;
  if (sym === 'P' || sym === 'S') return n === 4 || n === 8 || n === 6 || n === 2;
  if (sym === 'C') return n === 60 || n === 70 || n === 2;
  return false;
}

export class Resolver {
  private readonly lib: Library;
  private readonly pc: PubChem;
  private readonly sdfDir: string;
  private readonly allowPubchem: boolean;
  private readonly memo = new Map<string, ResolveResult>();

  constructor(deps: ResolveDeps = {}) {
    this.lib = deps.library ?? defaultLibrary();
    this.pc = deps.pubchem ?? defaultPubchem;
    this.sdfDir = deps.sdfDir ?? SDF_DIR;
    this.allowPubchem = deps.allowPubchem ?? true;
  }

  async resolve(rawQuery: string): Promise<ResolveResult> {
    const query = rawQuery.trim().replace(/\s+/g, ' ');
    if (!query) return { ok: false, error: 'Empty query', suggestions: [] };
    const key = query.toLowerCase();
    const cached = this.memo.get(key);
    if (cached) return cached;
    const result = await this.resolveUncached(query);
    if (result.ok || !result.pubchemDown) {
      if (this.memo.size > 2000) this.memo.delete(this.memo.keys().next().value!);
      this.memo.set(key, result);
    }
    return result;
  }

  private async resolveUncached(query: string): Promise<ResolveResult> {
    // 1. CID
    const cidMatch = query.match(/^(?:cid:?\s*)?(\d{1,9})$/i);
    if (cidMatch) {
      const cid = Number(cidMatch[1]);
      const entry = this.lib.findByCid(cid);
      if (entry) return this.fromLibrary(query, entry, 'cid');
      return this.fromPubchem(query, 'cid', () => this.pc.byCids([cid]));
    }
    // 2. CAS
    if (CAS_RE.test(query)) {
      const entry = this.lib.findByCas(query);
      if (entry) return this.fromLibrary(query, entry, 'cas');
      return this.fromPubchem(query, 'cas', () => this.pc.byName(query));
    }
    // 3. Library by name
    const byName = this.lib.findByName(query);
    if (byName.length) return this.fromLibrary(query, byName[0], 'name');
    // 4. Library by formula
    const byFormula = this.lib.findByFormula(query);
    if (byFormula.length) return this.fromLibrary(query, byFormula[0], 'formula', byFormula.slice(1));
    // Lattice only names ('rock salt', 'bcc', 'perovskite')
    const lattice = findLattice(query);
    if (lattice) return this.fromLattice(query, lattice);
    // 5. Obvious SMILES
    if (looksLikeSmiles(query) && parseSmiles(query)) return this.fromSmiles(query);
    // 6. PubChem by formula
    let parsedFormula: Counts | null = null;
    try {
      parsedFormula = looksLikeFormula(query) ? parseFormula(query).counts : null;
    } catch {
      parsedFormula = null;
    }
    if (parsedFormula && plausibleFormula(parsedFormula)) {
      const hill = parseFormula(query).hill;
      const viaFormula = await this.fromPubchem(query, 'formula', () => this.pc.byFormula(hill, 8));
      if (viaFormula.ok || viaFormula.pubchemDown) return viaFormula;
    }
    // 7. PubChem by name
    if (!parsedFormula || !plausibleFormula(parsedFormula) || /\s/.test(query)) {
      const viaName = await this.fromPubchem(query, 'name', () => this.pc.byName(query));
      if (viaName.ok || viaName.pubchemDown) return viaName;
    }
    // 8. Anything OpenChemLib accepts
    if (parseSmiles(query) && /^[A-Za-z0-9@+\-\[\]()=#\\/%.]+$/.test(query)) {
      const viaSmiles = await this.fromSmiles(query);
      if (viaSmiles.ok) return viaSmiles;
    }
    return this.notFound(query);
  }

  private notFound(query: string): ResolveResult {
    const suggestions = this.lib.suggest(query).map((e) => ({ id: e.id, name: e.name, formula: e.formula }));
    return {
      ok: false,
      error: `No chemical found for "${query}"`,
      suggestions,
    };
  }

  private async fromLibrary(
    query: string,
    entry: LibraryEntry,
    matchedOn: Resolved['matchedOn'],
    others: LibraryEntry[] = [],
  ): Promise<ResolveResult> {
    const compound = compoundFromEntry(entry);
    const warnings: string[] = [];
    const alternatives = (others.length ? others : this.lib.findByHill(entry.hill).filter((e) => e.id !== entry.id)).map(compoundFromEntry);
    const lattice = findLattice(entry.formula) ?? findLattice(entry.name);
    let molfile: string | null = null;
    let structureSource: Resolved['structureSource'] = 'none';
    const useLattice = lattice && (entry.kind === 'network' || entry.kind === 'element') && !entry.smiles.includes('.') && countsOf(compound)[Object.keys(countsOf(compound))[0]] === 1;
    if (useLattice && lattice) {
      const cluster = buildLattice(lattice, 2);
      molfile = structureToMolfile(cluster, lattice.name);
      structureSource = 'lattice';
      warnings.push(`Solid: showing a ${cluster.title.toLowerCase()} cluster of 2×2×2 unit cells (a = ${lattice.a} Å).`);
    } else {
      molfile = await librarySdf(entry, this.sdfDir);
      structureSource = molfile ? entry.sdfSource : 'none';
      if (!molfile && entry.smiles) {
        molfile = smilesToMolfile3D(entry.smiles);
        structureSource = molfile ? 'ocl' : 'none';
      }
    }
    if (entry.kind === 'ionic') warnings.push('Ionic compound: the 3D view shows one formula unit; the solid is a lattice of these ions.');
    if (structureSource === 'ocl') warnings.push('3D geometry generated by OpenChemLib (PubChem has no conformer for this compound).');
    if (structureSource === 'none') warnings.push('No 3D structure available for this entry.');
    const svg = entry.smiles ? smilesToSvg(entry.smiles) : null;
    const resolved: Resolved & { lattice?: LatticeInfo } = {
      query,
      matchedOn,
      compound,
      alternatives,
      svg,
      molfile,
      structureSource,
      composition: safeComposition(compound),
      warnings,
    };
    if (lattice) resolved.lattice = latticeInfo(lattice);
    return { ok: true, resolved };
  }

  private async fromLattice(query: string, spec: LatticeSpec): Promise<ResolveResult> {
    const base = this.lib.findByFormula(spec.formula)[0];
    const compound = compoundFromLattice(spec, base);
    const cluster = buildLattice(spec, 2);
    const resolved: Resolved & { lattice?: LatticeInfo } = {
      query,
      matchedOn: 'lattice',
      compound,
      alternatives: [],
      svg: compound.smiles ? smilesToSvg(compound.smiles) : null,
      molfile: structureToMolfile(cluster, spec.name),
      structureSource: 'lattice',
      composition: safeComposition(compound),
      warnings: [`Showing a ${cluster.title.toLowerCase()} cluster of 2×2×2 unit cells (a = ${spec.a} Å).`],
      lattice: latticeInfo(spec),
    };
    return { ok: true, resolved };
  }

  private async fromSmiles(smiles: string): Promise<ResolveResult> {
    // Same structure as a library compound? Then answer with that entry.
    const f = smilesToFormula(smiles);
    if (f) {
      const idcode = safeIdCode(smiles);
      for (const candidate of this.lib.findByHill(f.hill)) {
        if (idcode && safeIdCode(candidate.smiles) === idcode) return this.fromLibrary(smiles, candidate, 'smiles');
      }
    }
    const compound = compoundFromSmiles(smiles);
    if (!compound) return this.notFound(smiles);
    const molfile = smilesToMolfile3D(smiles);
    const resolved: Resolved = {
      query: smiles,
      matchedOn: 'smiles',
      compound,
      alternatives: this.lib.findByHill(compound.hill).map(compoundFromEntry),
      svg: smilesToSvg(smiles),
      molfile,
      structureSource: molfile ? 'ocl' : 'none',
      composition: safeComposition(compound),
      warnings: molfile ? ['3D geometry generated by OpenChemLib.'] : ['Could not generate 3D coordinates for this SMILES.'],
    };
    return { ok: true, resolved };
  }

  private async fromPubchem(
    query: string,
    matchedOn: Resolved['matchedOn'],
    fetchHits: () => Promise<PubChemCompound[]>,
  ): Promise<ResolveResult> {
    if (!this.allowPubchem) return this.notFound(query);
    let hits: PubChemCompound[];
    try {
      hits = await fetchHits();
    } catch (err) {
      const down = err instanceof PubChemUnavailable;
      return {
        ok: false,
        error: down ? `Not in the local library, and PubChem could not be reached (${err.message}).` : String(err),
        suggestions: this.lib.suggest(query).map((e) => ({ id: e.id, name: e.name, formula: e.formula })),
        pubchemDown: down,
      };
    }
    hits = hits.filter((h) => h.smiles || h.formula);
    if (hits.length === 0) return this.notFound(query);
    const [main, ...rest] = hits;
    // A PubChem hit that is really a library compound: answer from the library.
    const known = this.lib.findByCid(main.cid);
    if (known) return this.fromLibrary(query, known, matchedOn, []);

    const [cas, note, sdf3d] = await Promise.all([
      this.pc.synonyms(main.cid).then(findCas).catch(() => undefined),
      this.pc.description(main.cid).catch(() => null),
      this.pc.sdf(main.cid, '3d').catch(() => null),
    ]);
    const compound = compoundFromPubchem(main, cas, note);
    let molfile = sdf3d;
    let structureSource: Resolved['structureSource'] = sdf3d ? 'pubchem3d' : 'none';
    const warnings: string[] = [];
    if (!molfile && main.smiles) {
      molfile = smilesToMolfile3D(main.smiles);
      structureSource = molfile ? 'ocl' : 'none';
    }
    if (compound.kind === 'ionic') warnings.push('Ionic or multi-component record: the 3D view shows one formula unit.');
    if (structureSource === 'ocl') warnings.push('3D geometry generated by OpenChemLib (PubChem has no conformer for this compound).');
    if (structureSource === 'none') warnings.push('No 3D structure could be produced for this compound.');
    warnings.push('Not in the local library: data comes from PubChem.');
    const alternatives = rest.map((h) => {
      const lib = this.lib.findByCid(h.cid);
      return lib ? compoundFromEntry(lib) : compoundFromPubchem(h, undefined, null);
    });
    const resolved: Resolved = {
      query,
      matchedOn,
      compound,
      alternatives,
      svg: main.smiles ? smilesToSvg(main.smiles) : null,
      molfile,
      structureSource,
      composition: safeComposition(compound),
      warnings,
    };
    return { ok: true, resolved };
  }
}

function safeComposition(compound: Compound): Resolved['composition'] {
  try {
    return composition(countsOf(compound));
  } catch {
    return [];
  }
}

function safeIdCode(smiles: string): string | null {
  try {
    return OCL.Molecule.fromSmiles(smiles).getIDCode();
  } catch {
    return null;
  }
}

let shared: Resolver | null = null;

export function resolver(): Resolver {
  if (!shared) shared = new Resolver();
  return shared;
}
