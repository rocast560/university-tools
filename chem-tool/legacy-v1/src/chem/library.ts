// The curated library: loads data/library.json once and answers name,
// alias, formula, CAS and CID lookups from in memory indexes. Search is a
// ranked prefix and substring match for the autocomplete box.

import { readFileSync } from 'node:fs';
import { LIBRARY_FILE } from './paths.ts';
import { parseFormula } from './formula.ts';
import type { LibraryEntry, LibraryFile } from './types.ts';

/** 'Iron(III) chloride' -> 'ironiiichloride'; 'R-134a' -> 'r134a'. */
export function normaliseName(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface SearchHit {
  entry: LibraryEntry;
  matchedOn: 'name' | 'alias' | 'formula' | 'category';
  matchedText: string;
  score: number;
}

export class Library {
  readonly entries: LibraryEntry[];
  private readonly byId = new Map<string, LibraryEntry>();
  private readonly byName = new Map<string, LibraryEntry[]>();
  private readonly byHill = new Map<string, LibraryEntry[]>();
  private readonly byCas = new Map<string, LibraryEntry>();
  private readonly byCid = new Map<number, LibraryEntry>();
  private readonly nameList: Array<{ text: string; norm: string; entry: LibraryEntry; kind: 'name' | 'alias' }> = [];

  constructor(entries: LibraryEntry[]) {
    this.entries = [...entries].sort((a, b) => a.rank - b.rank);
    for (const e of this.entries) {
      this.byId.set(e.id, e);
      const push = (map: Map<string, LibraryEntry[]>, key: string) => {
        const list = map.get(key);
        if (list) {
          if (!list.includes(e)) list.push(e);
        } else map.set(key, [e]);
      };
      push(this.byName, normaliseName(e.name));
      this.nameList.push({ text: e.name, norm: normaliseName(e.name), entry: e, kind: 'name' });
      for (const alias of e.aliases) {
        push(this.byName, normaliseName(alias));
        this.nameList.push({ text: alias, norm: normaliseName(alias), entry: e, kind: 'alias' });
      }
      push(this.byHill, e.hill);
      if (e.cas) this.byCas.set(e.cas, e);
      if (e.cid) this.byCid.set(e.cid, e);
    }
  }

  static load(file = LIBRARY_FILE): Library {
    const json = JSON.parse(readFileSync(file, 'utf8')) as LibraryFile;
    return new Library(json.entries);
  }

  get size(): number {
    return this.entries.length;
  }

  get(id: string): LibraryEntry | undefined {
    return this.byId.get(id);
  }

  /** Exact (normalised) name or alias match, best ranked first. */
  findByName(query: string): LibraryEntry[] {
    return this.byName.get(normaliseName(query)) ?? [];
  }

  /** All entries with this Hill formula, best ranked first. */
  findByHill(hill: string): LibraryEntry[] {
    return this.byHill.get(hill) ?? [];
  }

  /** Parse a formula string and look it up; [] if it is not a formula. */
  findByFormula(query: string): LibraryEntry[] {
    try {
      return this.findByHill(parseFormula(query).hill);
    } catch {
      return [];
    }
  }

  findByCas(cas: string): LibraryEntry | undefined {
    return this.byCas.get(cas.trim());
  }

  findByCid(cid: number): LibraryEntry | undefined {
    return this.byCid.get(cid);
  }

  categories(): Array<{ category: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of this.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return [...counts.entries()].map(([category, count]) => ({ category, count }));
  }

  byCategory(category: string): LibraryEntry[] {
    const key = normaliseName(category);
    return this.entries.filter((e) => normaliseName(e.category) === key || e.tags.some((t) => normaliseName(t) === key));
  }

  /**
   * Autocomplete: exact name, then name prefix, then alias prefix, then
   * substring, then formula prefix. One hit per entry.
   */
  search(query: string, limit = 10): SearchHit[] {
    const q = normaliseName(query);
    if (!q) return [];
    const hits = new Map<string, SearchHit>();
    const consider = (entry: LibraryEntry, matchedOn: SearchHit['matchedOn'], matchedText: string, score: number) => {
      const existing = hits.get(entry.id);
      if (!existing || existing.score < score) hits.set(entry.id, { entry, matchedOn, matchedText, score });
    };
    for (const item of this.nameList) {
      const base = item.kind === 'name' ? 100 : 80;
      if (item.norm === q) consider(item.entry, item.kind, item.text, base + 50);
      else if (item.norm.startsWith(q)) consider(item.entry, item.kind, item.text, base + 20 - Math.min(item.norm.length - q.length, 15));
      else if (q.length >= 3 && item.norm.includes(q)) consider(item.entry, item.kind, item.text, base - 30);
    }
    let hill: string | null = null;
    try {
      hill = parseFormula(query).hill;
    } catch {
      hill = null;
    }
    for (const e of this.entries) {
      const f = normaliseName(e.formula);
      if (hill && e.hill === hill) consider(e, 'formula', e.formula, 140);
      else if (f === q) consider(e, 'formula', e.formula, 130);
      else if (f.startsWith(q) && q.length >= 2) consider(e, 'formula', e.formula, 60 - Math.min(f.length - q.length, 15));
    }
    return [...hits.values()]
      .sort((a, b) => b.score - a.score || a.entry.rank - b.entry.rank)
      .slice(0, limit);
  }

  /** Closest names by edit distance, for "did you mean" on a miss. */
  suggest(query: string, limit = 5): LibraryEntry[] {
    const q = normaliseName(query);
    if (q.length < 3) return [];
    const scored: Array<{ entry: LibraryEntry; d: number }> = [];
    const seen = new Set<string>();
    for (const item of this.nameList) {
      if (Math.abs(item.norm.length - q.length) > 4) continue;
      const d = levenshtein(q, item.norm, 4);
      if (d <= 3 && !seen.has(item.entry.id)) {
        seen.add(item.entry.id);
        scored.push({ entry: item.entry, d });
      }
    }
    return scored.sort((a, b) => a.d - b.d || a.entry.rank - b.entry.rank).slice(0, limit).map((s) => s.entry);
  }
}

/** Levenshtein distance with an early exit above `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

let shared: Library | null = null;

/** The library loaded from data/library.json (cached for the process). */
export function library(): Library {
  if (!shared) shared = Library.load();
  return shared;
}
