// Chemical equation balancer.
//
// Each species is a column, each element (plus one row for charge) is a
// row; reactants count positive and products negative. Balancing is then
// finding a positive integer vector in the null space of that matrix, which
// exact rational Gaussian elimination gives directly. When the null space
// has more than one dimension (two independent reactions written as one)
// every free variable is set to 1, which yields the conventional answer for
// the textbook cases and a clear error otherwise.

import { formatFormulaUnicode, parseFormula, type ParsedFormula } from './formula.ts';

export interface Species {
  formula: string;
  parsed: ParsedFormula;
  coefficient: number;
}

export interface BalancedEquation {
  reactants: Species[];
  products: Species[];
  coefficients: number[];
  /** 'C3H8 + 5 O2 → 3 CO2 + 4 H2O' with unicode subscripts. */
  equation: string;
  /** Plain ASCII version of `equation`. */
  ascii: string;
}

export class BalanceError extends Error {}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

/** Exact fraction with a positive denominator. */
class Frac {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d === 0n) throw new Error('zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(x: number): Frac {
    return new Frac(BigInt(x));
  }
  add(o: Frac): Frac {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac): Frac {
    return new Frac(this.n * o.n, this.d * o.d);
  }
  div(o: Frac): Frac {
    return new Frac(this.n * o.d, this.d * o.n);
  }
  isZero(): boolean {
    return this.n === 0n;
  }
}

/** Split one side of an equation into species strings. */
function splitSide(side: string): string[] {
  // A '+' separates species when what follows is a formula start; a '+'
  // that ends a token ('NH4+') is a charge and stays attached.
  return side
    .split(/\s*\+\s*(?=[A-Za-z0-9(\[])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseSpecies(text: string): Species {
  if (/^e(\^?-|⁻)?$/.test(text)) {
    return { formula: 'e-', parsed: { counts: {}, charge: -1, coefficient: 1, hill: '' }, coefficient: 0 };
  }
  try {
    const parsed = parseFormula(text);
    return { formula: text, parsed, coefficient: 0 };
  } catch {
    throw new BalanceError(`Cannot read "${text}" as a formula`);
  }
}

/** Parse 'A + B -> C + D' (also '=', '→', '⟶', '-->'). */
export function parseEquation(input: string): { reactants: Species[]; products: Species[] } {
  const sides = input.trim().split(/\s*(?:-->|->|→|⟶|⇌|=>|=)\s*/);
  if (sides.length !== 2) throw new BalanceError('Write the equation as "reactants -> products"');
  const reactants = splitSide(sides[0]).map(parseSpecies);
  const products = splitSide(sides[1]).map(parseSpecies);
  if (reactants.length === 0 || products.length === 0) throw new BalanceError('Both sides need at least one species');
  return { reactants, products };
}

/** Smallest positive integer null vector of the composition matrix. */
function solve(columns: Map<string, number>[], charges: number[]): number[] {
  const elements = [...new Set(columns.flatMap((c) => [...c.keys()]))];
  const rows = elements.map((el) => columns.map((c) => Frac.of(c.get(el) ?? 0)));
  if (charges.some((q) => q !== 0)) rows.push(charges.map((q) => Frac.of(q)));
  const n = columns.length;

  // Reduced row echelon form.
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < n && r < rows.length; c++) {
    let p = -1;
    for (let i = r; i < rows.length; i++) if (!rows[i][c].isZero()) { p = i; break; }
    if (p === -1) continue;
    [rows[r], rows[p]] = [rows[p], rows[r]];
    const pivot = rows[r][c];
    rows[r] = rows[r].map((v) => v.div(pivot));
    for (let i = 0; i < rows.length; i++) {
      if (i === r || rows[i][c].isZero()) continue;
      const f = rows[i][c];
      rows[i] = rows[i].map((v, j) => v.sub(f.mul(rows[r][j])));
    }
    pivots.push(c);
    r++;
  }
  const free = [...Array(n).keys()].filter((c) => !pivots.includes(c));
  if (free.length === 0) throw new BalanceError('This equation cannot be balanced (no non-trivial solution)');

  // Every free variable = 1; pivot variables follow from their rows.
  const x: Frac[] = Array.from({ length: n }, () => Frac.of(0));
  for (const c of free) x[c] = Frac.of(1);
  pivots.forEach((c, i) => {
    let value = Frac.of(0);
    for (const f of free) value = value.sub(rows[i][f].mul(x[f]));
    x[c] = value;
  });

  let denominator = 1n;
  for (const v of x) denominator = lcm(denominator, v.d);
  const ints = x.map((v) => (v.n * denominator) / v.d);
  let g = 0n;
  for (const v of ints) g = gcd(g, v);
  const result = ints.map((v) => Number(v / (g || 1n)));
  if (result.some((v) => v <= 0)) {
    throw new BalanceError(
      free.length > 1
        ? 'The equation mixes independent reactions; balance them separately'
        : 'This equation cannot be balanced with positive coefficients',
    );
  }
  return result;
}

function formatSide(species: Species[], unicode: boolean): string {
  return species
    .map((s) => {
      const f = unicode ? formatFormulaUnicode(s.formula) : s.formula;
      return (s.coefficient === 1 ? '' : s.coefficient + ' ') + f;
    })
    .join(' + ');
}

export function balanceEquation(input: string): BalancedEquation {
  const { reactants, products } = parseEquation(input);
  const all = [...reactants, ...products];
  const columns = all.map((s, i) => {
    const sign = i < reactants.length ? 1 : -1;
    return new Map(Object.entries(s.parsed.counts).map(([el, n]) => [el, sign * n]));
  });
  const charges = all.map((s, i) => (i < reactants.length ? 1 : -1) * s.parsed.charge);
  const coefficients = solve(columns, charges);
  all.forEach((s, i) => (s.coefficient = coefficients[i]));
  return {
    reactants,
    products,
    coefficients,
    equation: `${formatSide(reactants, true)} → ${formatSide(products, true)}`,
    ascii: `${formatSide(reactants, false)} -> ${formatSide(products, false)}`,
  };
}
