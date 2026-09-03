// Indexes over the seed: normalised names and aliases, formula text, Hill formula.

import { SEED, type SeedEntry } from '../../data/seed';
import { hillFormula, parseFormula } from './formula';

export interface LibraryEntry extends SeedEntry { hill: string; charge: number; keys: string[] }

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, ' ').trim();
}

const compact = (s: string) => normalizeName(s).replace(/[\s·.]/g, '');

export const LIBRARY: LibraryEntry[] = SEED.map((e) => {
  const p = parseFormula(e.formula);
  const hill = hillFormula(p.counts, p.charge);
  const keys = [normalizeName(e.name), ...(e.aliases ?? []).map(normalizeName), compact(e.formula), compact(hill)];
  return { ...e, hill, charge: p.charge, keys: [...new Set(keys)] };
});

const BY_KEY = new Map<string, LibraryEntry>();
const BY_HILL = new Map<string, LibraryEntry[]>();
for (const entry of LIBRARY) {
  for (const k of entry.keys) if (!BY_KEY.has(k)) BY_KEY.set(k, entry);
  BY_HILL.set(entry.hill, [...(BY_HILL.get(entry.hill) ?? []), entry]);
}

export function findByName(query: string): LibraryEntry | undefined {
  const n = normalizeName(query);
  return BY_KEY.get(n) ?? BY_KEY.get(compact(query));
}

export function findByFormula(hill: string): LibraryEntry[] {
  return BY_HILL.get(hill) ?? [];
}

function rank(entry: LibraryEntry, q: string): number {
  const name = entry.keys[0];
  if (entry.keys.includes(q)) return 0;
  if (name.startsWith(q)) return 1;
  if (entry.keys.some((k) => k.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (entry.keys.some((k) => k.includes(q))) return 4;
  return -1;
}

export function search(query: string, limit = 20): LibraryEntry[] {
  const q = normalizeName(query);
  if (!q) return [];
  return LIBRARY
    .map((entry, i) => ({ entry, i, r: rank(entry, q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.entry);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest entry names for a query that matched nothing. */
export function suggestions(query: string, limit = 5): string[] {
  const q = normalizeName(query);
  const scored = LIBRARY.map((e) => ({ name: e.name, d: Math.min(...e.keys.map((k) => levenshtein(q, k))) }));
  return scored.filter((s) => s.d <= Math.max(2, Math.floor(q.length / 3))).sort((a, b) => a.d - b.d).slice(0, limit).map((s) => s.name);
}

export function categories(): string[] {
  return [...new Set(LIBRARY.map((e) => e.category))];
}
