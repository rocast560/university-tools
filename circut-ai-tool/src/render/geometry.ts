// Where everything sits on the board, in SVG units.
//
// Separate from the renderer so a skin can paint at these coordinates without
// pulling in the whole drawing layer, and so client/drag.ts can snap to them.

import type { BoardSpec, Hole, Package, Row } from '../layout/types.ts';
import { L3_BOARD } from '../parts/lab3.ts';

/** Hole pitch: 0.1 inch. */
export const P = 18;
/** X of column 1. */
export const X0 = 40;
export const ROWY: Record<Row, number> = { 'T+': 30, 'T-': 48, a: 84, b: 102, c: 120, d: 138, e: 156, f: 192, g: 210, h: 228, i: 246, j: 264, 'B-': 300, 'B+': 318 };
export const HEIGHT = 350;

export function pt(h: Hole): [number, number] {
  return [X0 + (h.col - 1) * P, ROWY[h.row]];
}

/**
 * The L3 board's outline in SVG units, given its header row and pin 1 column.
 * The body runs outward from the header: up from row a, down from row j.
 */
export function moduleRect(pkg: Package): { x1: number; y1: number; x2: number; y2: number; dir: -1 | 1 } {
  const row: Row = pkg.row ?? 'a';
  const dir: -1 | 1 = row === 'j' ? 1 : -1;
  const x1 = pt({ col: pkg.col0, row })[0] - L3_BOARD.endMargin * P;
  const x2 = pt({ col: pkg.col0 + pkg.pins - 1, row })[0] + L3_BOARD.endMargin * P;
  const near = ROWY[row] - dir * L3_BOARD.inset * P;
  const far = ROWY[row] + dir * L3_BOARD.depth * P;
  return { x1, y1: Math.min(near, far), x2, y2: Math.max(near, far), dir };
}

/** How far the drawing has to grow above and below the breadboard for boards that hang off its edge. */
export function overhang(packages: Package[]): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  for (const pkg of packages) {
    if (pkg.kind !== 'module') continue;
    const r = moduleRect(pkg);
    top = Math.max(top, 8 - r.y1);
    bottom = Math.max(bottom, r.y2 + 8 - HEIGHT);
  }
  return { top: Math.ceil(top), bottom: Math.ceil(bottom) };
}

export function svgSize(board: BoardSpec, packages: Package[] = []): { width: number; height: number; viewBox: string } {
  const xr = X0 + (board.cols - 1) * P;
  const width = xr + 140;
  const over = overhang(packages);
  const height = HEIGHT + over.top + over.bottom;
  // The negative origin leaves room for the supply leads and their labels,
  // which are drawn in the margin outside the board itself, and for anything
  // that hangs off the top or bottom edge.
  return { width, height, viewBox: `-100 ${-over.top} ${width} ${height}` };
}
