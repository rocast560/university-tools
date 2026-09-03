// Query pipeline: library by name, library by formula, SMILES, PubChem by name, PubChem by formula.

import { hillFormula, looksLikeFormula, parseFormula } from './formula';
import { findByFormula, findByName, normalizeName, suggestions, type LibraryEntry } from './library';
import type { PubChem, PubChemCompound } from './pubchem';
import { PubChemUnavailable } from './pubchem';
import { buildSpecies, newId } from './species';
import { parseSmiles } from './structure';
import type { Species } from './types';

export interface Alternative { name: string; formula: string; smiles: string }
export interface ResolveResult { species: Species; alternatives: Alternative[]; note?: string }

export class ResolveError extends Error {
  constructor(message: string, public readonly suggestions: string[] = [], public readonly reason?: string) { super(message); }
}

export interface Resolver { resolve(query: string): Promise<ResolveResult> }
export type PubChemLike = Pick<PubChem, 'byName' | 'byFormula'>;

export function speciesFromEntry(entry: LibraryEntry): Species {
  return buildSpecies({ name: entry.name, smiles: entry.smiles, source: 'library', displayFormula: entry.formula, category: entry.category, description: entry.note, cid: entry.cid });
}

function fromCompound(c: PubChemCompound, fallbackName: string): Species {
  return buildSpecies({ name: c.title || fallbackName, smiles: c.smiles || c.connectivitySmiles, source: 'pubchem', iupacName: c.iupac || undefined, cid: c.cid, displayFormula: c.formula || undefined });
}

const altFromEntry = (e: LibraryEntry): Alternative => ({ name: e.name, formula: e.formula, smiles: e.smiles });
const altFromCompound = (c: PubChemCompound): Alternative => ({ name: c.title, formula: c.formula, smiles: c.smiles || c.connectivitySmiles });

export function createResolver(deps: { pubchem?: PubChemLike | null }): Resolver {
  const pubchem = deps.pubchem ?? null;
  const cache = new Map<string, ResolveResult>();

  async function resolveUncached(q: string): Promise<ResolveResult> {
    const entry = findByName(q);
    if (entry) {
      const isomers = findByFormula(entry.hill).filter((e) => e !== entry);
      return { species: speciesFromEntry(entry), alternatives: isomers.map(altFromEntry) };
    }
    let hillBody: string | undefined;
    const isFormula = looksLikeFormula(q);
    if (isFormula) {
      const p = parseFormula(q);
      const hill = hillFormula(p.counts, p.charge);
      hillBody = hillFormula(p.counts);
      const hits = findByFormula(hill);
      if (hits.length) return { species: speciesFromEntry(hits[0]), alternatives: hits.slice(1).map(altFromEntry) };
    }
    if (!/^[a-z ]+$/.test(q) && !/\s/.test(q)) {
      const mol = parseSmiles(q);
      if (mol) {
        const species = buildSpecies({ name: '', smiles: q, source: 'smiles' });
        return { species: { ...species, name: species.formula }, alternatives: [], note: 'Interpreted as SMILES' };
      }
    }
    if (!pubchem) throw new ResolveError(`No match for "${q}" in the library and PubChem is disabled`, suggestions(q));
    try {
      const byName = await pubchem.byName(q);
      if (byName[0]) return { species: fromCompound(byName[0], q), alternatives: byName.slice(1, 6).map(altFromCompound) };
      if (hillBody) {
        const byFormula = await pubchem.byFormula(hillBody);
        if (byFormula[0]) return { species: fromCompound(byFormula[0], q), alternatives: byFormula.slice(1, 6).map(altFromCompound) };
      }
    } catch (err) {
      if (err instanceof PubChemUnavailable) throw new ResolveError(`No library match for "${q}" and PubChem is unreachable`, suggestions(q), err.message);
      throw err;
    }
    throw new ResolveError(`No chemical found for "${q}"`, suggestions(q));
  }

  // Species ids address a species within a scene, so every caller must get its own. Minting on
  // return (not only on a cache hit) keeps cached and fresh resolves indistinguishable.
  const withOwnId = (r: ResolveResult): ResolveResult => ({ ...r, species: { ...r.species, id: newId() } });

  return {
    async resolve(query: string): Promise<ResolveResult> {
      const q = query.trim();
      if (!q) throw new ResolveError('Empty query');
      const key = normalizeName(q);
      const hit = cache.get(key);
      if (hit) return withOwnId(hit);
      const result = await resolveUncached(q);
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return withOwnId(result);
    },
  };
}
