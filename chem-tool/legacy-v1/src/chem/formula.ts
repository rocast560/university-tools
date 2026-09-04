// Chemical formula parsing and formatting. Pure functions, no I/O.
//
// A formula string goes through: unicode normalisation (subscripts,
// superscript charges), removal of a trailing state such as (aq), charge
// extraction, an optional leading coefficient, then hydrate parts split on
// '.', '*' or a middle dot, each parsed by a small recursive descent parser
// over element symbols, counts and bracket groups.
//
// Case recovery: 'h2o' or 'NACL' are not valid formulas, but people type
// them. When the strict parse fails, `lenient` retries with a case
// insensitive segmentation scored by how common each element is and how
// many symbols it needs ('co2' -> C O, 'caco3' -> Ca C O, 'nacl' -> Na Cl).
// caseRecoveryAllowed keeps this from turning 'water' into W At Er.

import { elementBySymbol } from './elements.ts';

/** Element symbol to atom count, in order of first appearance. */
export type Counts = Record<string, number>;

export interface ParsedFormula {
  counts: Counts;
  /** Net charge, 0 for neutral. */
  charge: number;
  /** Leading stoichiometric coefficient ('2H2O' -> 2), 1 when absent. */
  coefficient: number;
  /** Hill order key, e.g. 'C2H6O' or 'ClNa'. Used to match compounds. */
  hill: string;
}

export interface ParseOptions {
  /** Retry with case recovery when the strict parse fails. Default true. */
  lenient?: boolean;
}

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

export class FormulaError extends Error {}

function normaliseUnicode(input: string): string {
  // Superscript digits carry meaning (a charge), so fold them into the
  // caret notation before NFKC turns them into plain digits.
  let s = input.trim();
  s = s.replace(/[₀-₉]/g, (c) => String(SUBSCRIPT_DIGITS.indexOf(c)));
  s = s.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])/g, (_m, digits: string, sign: string) => {
    const d = [...digits].map((c) => String(SUPERSCRIPT_DIGITS.indexOf(c))).join('');
    return '^' + d + (sign === '⁺' ? '+' : '-');
  });
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String(SUPERSCRIPT_DIGITS.indexOf(c)));
  s = s.normalize('NFKC').replace(/[−–]/g, '-');
  return s;
}

function stripState(s: string): string {
  return s.replace(/\s*\((s|l|g|aq|cr|am)\)\s*$/i, '');
}

/**
 * Separate a trailing charge from the body. 'Fe3+' is a 3+ ion (monatomic,
 * so the digit is the charge) while 'NH4+' is ammonium (the digit is a
 * count). A caret ('SO4^2-') or a space ('SO4 2-') makes it explicit.
 */
export function splitCharge(s: string): { body: string; charge: number } {
  const caret = s.match(/^(.*?)\s*\^\s*(\d*)\s*([+-])\s*$/);
  if (caret) {
    const n = caret[2] === '' ? 1 : Number(caret[2]);
    return { body: caret[1], charge: caret[3] === '+' ? n : -n };
  }
  const plain = s.match(/^(.*?)(\s*)(\d*)([+-])\s*$/);
  if (!plain) return { body: s, charge: 0 };
  const [, base, space, digits, sign] = plain;
  const unit = sign === '+' ? 1 : -1;
  if (digits === '') return { body: base, charge: unit };
  if (space !== '' || /^[A-Z][a-z]?$/.test(base)) {
    return { body: base, charge: unit * Number(digits) };
  }
  return { body: base + digits, charge: unit };
}

type CaseMode = 'strict' | 'insensitive';

/**
 * Elements that dominate introductory and engineering chemistry. When a
 * single case string is ambiguous ('caco3' is Ca C O or Ca Co) the
 * segmentation built from these wins; each extra symbol also costs a
 * little, so 'sio2' is Si O rather than S I O.
 */
const COMMON = new Set([
  'H', 'C', 'N', 'O', 'F', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'K', 'Ca',
  'Fe', 'Cu', 'Zn', 'Br', 'I', 'Ag', 'Ba', 'Pb', 'Sn', 'Hg', 'Mn', 'Cr', 'Ni',
  'Li', 'B', 'Ti', 'He', 'Ne', 'Ar', 'Au', 'Pt',
]);
const LOG_COMMON = Math.log(0.9);
const LOG_RARE = Math.log(0.1);

/** Split a run of letters into element symbols under the given case mode. */
function segmentLetters(run: string, mode: CaseMode): string[] | null {
  if (mode === 'strict') {
    const out: string[] = [];
    let i = 0;
    while (i < run.length) {
      const c = run[i];
      if (c < 'A' || c > 'Z') return null;
      const next = run[i + 1];
      const two = next !== undefined && next >= 'a' && next <= 'z' ? c + next : null;
      if (two !== null) {
        if (!elementBySymbol(two)) return null;
        out.push(two);
        i += 2;
      } else {
        if (!elementBySymbol(c)) return null;
        out.push(c);
        i += 1;
      }
    }
    return out;
  }
  // Case insensitive: enumerate every segmentation, keep the best scored.
  const cap = (t: string) => t[0].toUpperCase() + t.slice(1).toLowerCase();
  let best: { symbols: string[]; score: number } | null = null;
  const rec = (i: number, acc: string[], score: number): void => {
    if (i === run.length) {
      if (!best || score > best.score) best = { symbols: [...acc], score };
      return;
    }
    for (const len of [2, 1]) {
      if (i + len > run.length) continue;
      const sym = cap(run.slice(i, i + len));
      if (!elementBySymbol(sym)) continue;
      acc.push(sym);
      rec(i + len, acc, score + (COMMON.has(sym) ? LOG_COMMON : LOG_RARE));
      acc.pop();
    }
  };
  rec(0, [], 0);
  return best ? (best as { symbols: string[] }).symbols : null;
}

function addCounts(into: Counts, from: Counts, factor: number): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v * factor;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Parse one hydrate part ('CuSO4' or 'H2O') into counts. Throws on error. */
function parsePart(s: string, mode: CaseMode): Counts {
  let pos = 0;
  const readNumber = (): number => {
    const m = s.slice(pos).match(/^\d+/);
    if (!m) return 1;
    pos += m[0].length;
    return Number(m[0]);
  };
  const parseGroup = (closer: string | null): Counts => {
    const counts: Counts = {};
    while (pos < s.length) {
      const c = s[pos];
      if (c === ' ') {
        pos++;
        continue;
      }
      if (closer !== null && c === closer) {
        pos++;
        return counts;
      }
      if (c in OPEN) {
        pos++;
        const inner = parseGroup(OPEN[c]);
        addCounts(counts, inner, readNumber());
        continue;
      }
      if (/[A-Za-z]/.test(c)) {
        const run = s.slice(pos).match(/^[A-Za-z]+/)![0];
        pos += run.length;
        // A digit binds to the last symbol of the run only.
        const symbols = segmentLetters(run, mode);
        if (!symbols) throw new FormulaError(`Unknown element in "${run}"`);
        const last = symbols.pop()!;
        for (const sym of symbols) counts[sym] = (counts[sym] ?? 0) + 1;
        counts[last] = (counts[last] ?? 0) + readNumber();
        continue;
      }
      throw new FormulaError(`Unexpected "${c}" in formula`);
    }
    if (closer !== null) throw new FormulaError(`Missing "${closer}"`);
    return counts;
  };
  const counts = parseGroup(null);
  if (Object.keys(counts).length === 0) throw new FormulaError('Empty formula');
  return counts;
}

/**
 * Digits bind to the preceding symbol, so a letter run like 'CH3' is
 * segmented letter by letter and the count applies to the last symbol.
 * Runs are therefore split so a digit always follows at most one symbol
 * group: we pre-split the string at every letter/digit boundary.
 */
function parseWithMode(body: string, mode: CaseMode): Counts {
  const total: Counts = {};
  const parts = body.split(/\s*[.·•⋅*]\s*/);
  for (const raw of parts) {
    let part = raw.trim();
    if (part === '') throw new FormulaError('Empty hydrate part');
    let factor = 1;
    const lead = part.match(/^(\d+)\s*/);
    if (lead) {
      factor = Number(lead[1]);
      part = part.slice(lead[0].length);
    }
    addCounts(total, parsePart(part, mode), factor);
  }
  return total;
}

/**
 * Case recovery is only safe for strings that cannot be an English word:
 * single case, and either short ('nacl', 'koh') or carrying a digit
 * ('caco3'). 'water' and 'iron' stay names.
 */
function caseRecoveryAllowed(body: string): boolean {
  const letters = body.replace(/[^A-Za-z]/g, '');
  const singleCase = letters === letters.toLowerCase() || letters === letters.toUpperCase();
  return singleCase && (/\d/.test(body) || letters.length <= 4);
}

/** Parse a formula. Throws FormulaError when the string is not a formula. */
export function parseFormula(input: string, options: ParseOptions = {}): ParsedFormula {
  const lenient = options.lenient ?? true;
  let s = stripState(normaliseUnicode(input));
  if (s === '') throw new FormulaError('Empty formula');
  const { body: withCoefficient, charge } = splitCharge(s);
  let coefficient = 1;
  let body = withCoefficient.trim();
  const lead = body.match(/^(\d+)\s+/);
  if (lead) {
    coefficient = Number(lead[1]);
    body = body.slice(lead[0].length);
  } else {
    // '2H2O' with no space: a leading number before an uppercase letter or
    // bracket is a coefficient, never a count.
    const tight = body.match(/^(\d+)(?=[A-Za-z([{])/);
    if (tight) {
      coefficient = Number(tight[1]);
      body = body.slice(tight[0].length);
    }
  }
  const modes: CaseMode[] = lenient && caseRecoveryAllowed(body) ? ['strict', 'insensitive'] : ['strict'];
  let lastError: unknown;
  for (const mode of modes) {
    try {
      const counts = parseWithMode(body, mode);
      return { counts, charge, coefficient, hill: hillFormula(counts) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new FormulaError('Invalid formula');
}

/** Hill system order: C, then H, then the rest alphabetically. No C: all alphabetical. */
export function hillFormula(counts: Counts): string {
  const keys = Object.keys(counts).filter((k) => counts[k] > 0);
  const hasCarbon = keys.includes('C');
  const rest = keys.filter((k) => hasCarbon ? k !== 'C' && k !== 'H' : true).sort();
  const ordered = hasCarbon ? ['C', ...(keys.includes('H') ? ['H'] : []), ...rest] : rest;
  return ordered.map((k) => k + (counts[k] === 1 ? '' : counts[k])).join('');
}

export function molarMass(counts: Counts): number {
  let total = 0;
  for (const [sym, n] of Object.entries(counts)) {
    const el = elementBySymbol(sym);
    if (!el) throw new FormulaError(`Unknown element ${sym}`);
    total += el.mass * n;
  }
  return total;
}

export interface CompositionEntry {
  symbol: string;
  name: string;
  count: number;
  mass: number;
  massPercent: number;
}

/** Mass percent of each element, in Hill order. */
export function composition(counts: Counts): CompositionEntry[] {
  const total = molarMass(counts);
  const order = hillFormula(counts).match(/[A-Z][a-z]?/g) ?? [];
  return order.map((sym) => {
    const el = elementBySymbol(sym)!;
    const mass = el.mass * counts[sym];
    return { symbol: sym, name: el.name, count: counts[sym], mass, massPercent: (mass / total) * 100 };
  });
}

/**
 * A quick shape test used by the resolver to decide whether an unknown
 * query should be sent to PubChem as a formula or as a name.
 */
export function looksLikeFormula(input: string): boolean {
  const s = stripState(normaliseUnicode(input));
  if (!/^[A-Za-z0-9()[\]{}\s.·•⋅*^+-]+$/.test(s) || !/[A-Za-z]/.test(s)) return false;
  try {
    parseFormula(s);
    return true;
  } catch {
    return false;
  }
}

function chargeText(charge: number, minus: string): string {
  if (charge === 0) return '';
  const n = Math.abs(charge);
  return (n === 1 ? '' : String(n)) + (charge > 0 ? '+' : minus);
}

/** 'H2O' -> 'H<sub>2</sub>O'; 'SO4^2-' -> 'SO<sub>4</sub><sup>2−</sup>'. */
export function formatFormulaHtml(formula: string): string {
  const s = normaliseUnicode(formula);
  const { body, charge } = splitCharge(s);
  const html = body
    .replace(/[.*•⋅]/g, '·')
    .replace(/([A-Za-z)\]}])(\d+)/g, '$1<sub>$2</sub>');
  const sup = chargeText(charge, '−');
  return sup ? `${html}<sup>${sup}</sup>` : html;
}

/** 'C6H12O6' -> 'C₆H₁₂O₆'; 'NH4+' -> 'NH₄⁺'. */
export function formatFormulaUnicode(formula: string): string {
  const s = normaliseUnicode(formula);
  const { body, charge } = splitCharge(s);
  const text = body
    .replace(/[.*•⋅]/g, '·')
    .replace(/([A-Za-z)\]}])(\d+)/g, (_m, a: string, d: string) =>
      a + [...d].map((c) => SUBSCRIPT_DIGITS[Number(c)]).join(''));
  const sup = chargeText(charge, '-')
    .replace(/\d/g, (c) => SUPERSCRIPT_DIGITS[Number(c)])
    .replace('+', '⁺')
    .replace('-', '⁻');
  return text + sup;
}
