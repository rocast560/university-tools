// Chemical formula text: parse, Hill order, molar mass, composition.
//
// Charge notation: the sign alone means magnitude 1 ("NH4+", "OH-", "C2H3O2-").
// Digits before the sign are the magnitude only when separated by a space, "^" or
// parentheses ("SO4 2-", "Fe^3+", "SO4(2-)"), or when the body is one element symbol
// ("Fe3+", "Ca2+"). "SO42-" therefore parses as S O42 with charge -1; the library
// catches that case by name ("sulfate") before formula parsing is attempted.

import { bySymbol } from './elements';
import type { Composition } from './types';

export type Counts = Record<string, number>;
export interface ParsedFormula { counts: Counts; charge: number }
export class FormulaError extends Error {}

const SUB: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

export function normalizeFormulaText(text: string): string {
  return text
    .trim()
    .replace(/[₀-₉]/g, (c) => SUB[c])
    // A superscript charge ("²⁻", "⁺") is unambiguous: turn it into the "^2-" separator form.
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻]/g, (m) => '^' + [...m].map((c) => SUP[c]).join(''))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUP[c])
    .replace(/[·•*]/g, '.')
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, ' ');
}

function splitCharge(text: string): { body: string; charge: number } {
  const m = /^(.*?)([ ^(]?)(\d*)([+-])\)?$/.exec(text);
  if (!m) return { body: text, charge: 0 };
  const [, body, sep, digits, sign] = m;
  const s = sign === '+' ? 1 : -1;
  if (sep) return { body, charge: s * (digits ? Number(digits) : 1) };
  const singleElement = /^[A-Z][a-z]?$/.test(body);
  if (digits && singleElement) return { body, charge: s * Number(digits) };
  return { body: body + digits, charge: s };
}

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly original: string) {}

  parseGroups(close: string | null): Counts {
    const counts: Counts = {};
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === close) { this.i++; return counts; }
      let inner: Counts;
      if (ch === '(' || ch === '[') {
        this.i++;
        inner = this.parseGroups(ch === '(' ? ')' : ']');
      } else {
        const m = /^[A-Z][a-z]?/.exec(this.s.slice(this.i));
        if (!m || !bySymbol(m[0])) throw new FormulaError(`Unknown element at "${this.s.slice(this.i)}" in "${this.original}"`);
        this.i += m[0].length;
        inner = { [m[0]]: 1 };
      }
      const n = this.readNumber();
      for (const [el, c] of Object.entries(inner)) counts[el] = (counts[el] ?? 0) + c * n;
    }
    if (close) throw new FormulaError(`Missing "${close}" in "${this.original}"`);
    return counts;
  }

  private readNumber(): number {
    const m = /^\d+/.exec(this.s.slice(this.i));
    if (!m) return 1;
    this.i += m[0].length;
    return Number(m[0]);
  }
}

export function parseFormula(text: string): ParsedFormula {
  const norm = normalizeFormulaText(text);
  if (!norm) throw new FormulaError('Empty formula');
  const { body, charge } = splitCharge(norm);
  const counts: Counts = {};
  for (const part of body.replace(/ /g, '').split('.')) {
    if (!part) throw new FormulaError(`Empty fragment in "${text}"`);
    const m = /^(\d*)(.*)$/.exec(part)!;
    const mult = m[1] ? Number(m[1]) : 1;
    const c = new Parser(m[2], text).parseGroups(null);
    for (const [el, n] of Object.entries(c)) counts[el] = (counts[el] ?? 0) + n * mult;
  }
  if (Object.keys(counts).length === 0) throw new FormulaError(`No elements in "${text}"`);
  return { counts, charge };
}

/** Element symbols in Hill order: C, H, then alphabetical; all alphabetical when there is no carbon. */
export function hillOrder(counts: Counts): string[] {
  const syms = Object.keys(counts).filter((s) => counts[s] > 0);
  const hasC = syms.includes('C');
  const rest = syms.filter((s) => !(hasC && (s === 'C' || s === 'H'))).sort();
  return hasC ? ['C', ...(syms.includes('H') ? ['H'] : []), ...rest] : rest;
}

export function hillFormula(counts: Counts, charge = 0): string {
  const body = hillOrder(counts).map((s) => s + (counts[s] === 1 ? '' : counts[s])).join('');
  if (!charge) return body;
  const mag = Math.abs(charge);
  return `${body} ${mag === 1 ? '' : mag}${charge > 0 ? '+' : '-'}`;
}

export function molarMass(counts: Counts): number {
  let total = 0;
  for (const [el, n] of Object.entries(counts)) {
    const e = bySymbol(el);
    if (!e) throw new FormulaError(`Unknown element ${el}`);
    total += e.mass * n;
  }
  return total;
}

export function composition(counts: Counts): Composition[] {
  const total = molarMass(counts);
  return hillOrder(counts).map((el) => ({
    element: el,
    count: counts[el],
    massPercent: Math.round((100 * bySymbol(el)!.mass * counts[el] / total) * 100) / 100,
  }));
}

export function looksLikeFormula(text: string): boolean {
  try { parseFormula(text); return true; } catch { return false; }
}
