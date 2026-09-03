// Breadboard geometry: rows, strips, rails, and who owns which hole.

import type { BoardSpec, Hole, Row } from './types.ts';

export const TOP_ROWS: Row[] = ['a', 'b', 'c', 'd', 'e'];
export const BOT_ROWS: Row[] = ['f', 'g', 'h', 'i', 'j'];
export const RAILS: Row[] = ['T+', 'T-', 'B+', 'B-'];
/** Outer row first: legs that continue to a rail. */
export const PART_ROWS: Record<'T' | 'B', Row[]> = { T: ['a', 'b', 'c', 'd'], B: ['j', 'i', 'h', 'g'] };
/** Legs between two strips. */
export const MID_ROWS: Record<'T' | 'B', Row[]> = { T: ['b', 'c', 'd', 'a'], B: ['i', 'h', 'g', 'j'] };
/** Inner row first: jumper wires. */
export const WIRE_ROWS: Record<'T' | 'B', Row[]> = { T: ['d', 'c', 'b', 'a'], B: ['g', 'h', 'i', 'j'] };

export class LayoutError extends Error {}

export const hole = (col: number, row: Row): Hole => ({ col, row });
export const isRail = (row: Row): boolean => row.length === 2;
export const halfOf = (row: Row): 'T' | 'B' => (isRail(row) ? (row[0] as 'T' | 'B') : TOP_ROWS.includes(row) ? 'T' : 'B');
export const stripOf = (h: Hole): string => (isRail(h.row) ? h.row : `${halfOf(h.row)}${h.col}`);
export const stripCol = (strip: string): number => Number(strip.slice(1));
export const stripHalf = (strip: string): 'T' | 'B' => strip[0] as 'T' | 'B';
export const holeKey = (h: Hole): string => `${h.row}${h.col}`;
export const sameHole = (a: Hole, b: Hole): boolean => a.col === b.col && a.row === b.row;

export function parseHole(s: string): Hole {
  const m = /^([a-j]|[TB][+-])(\d+)$/.exec(s.trim());
  if (!m) throw new LayoutError(`bad hole "${s}" (use a1..j63 for the strips, or T+3, B-10 for the rails)`);
  return { col: Number(m[2]), row: m[1] as Row };
}

export function holeName(h: Hole): string {
  return isRail(h.row) ? `${h.row[0] === 'T' ? 'top' : 'bottom'} ${h.row[1]} rail, column ${h.col}` : `${h.row}${h.col}`;
}

export class Board {
  constructor(
    public cols: number,
    public kind: 'half' | 'full',
    public splitCol: number | null,
    public railGapEvery: number,
  ) {}

  railExists(col: number): boolean {
    return col >= 1 && col <= this.cols && col % this.railGapEvery !== 0;
  }

  inBounds(h: Hole): boolean {
    return isRail(h.row) ? this.railExists(h.col) : h.col >= 1 && h.col <= this.cols;
  }

  /** Electrical node of a rail hole; split boards have a left and a right segment. */
  railNode(row: Row, col: number): string {
    if (!this.splitCol) return row;
    return col > this.splitCol ? `${row}R` : `${row}L`;
  }

  spec(): BoardSpec {
    return { cols: this.cols, kind: this.kind, splitCol: this.splitCol, railGapEvery: this.railGapEvery };
  }
}

export class Occupancy {
  private used = new Map<string, string>();

  isFree(h: Hole): boolean {
    return !this.used.has(holeKey(h));
  }

  owner(h: Hole): string | undefined {
    return this.used.get(holeKey(h));
  }

  claim(h: Hole, owner: string): Hole {
    const k = holeKey(h);
    const prev = this.used.get(k);
    if (prev !== undefined) throw new LayoutError(`hole ${holeName(h)} needed by ${owner} is already used by ${prev}`);
    this.used.set(k, owner);
    return h;
  }

  entries(): [string, string][] {
    return [...this.used.entries()];
  }
}
