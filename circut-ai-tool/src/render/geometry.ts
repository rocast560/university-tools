// Where everything sits on the board, in SVG units.
//
// Separate from the renderer so a skin can paint at these coordinates without
// pulling in the whole drawing layer, and so client/drag.ts can snap to them.

import type { BoardSpec, Hole, Row } from '../layout/types.ts';

/** Hole pitch: 0.1 inch. */
export const P = 18;
/** X of column 1. */
export const X0 = 40;
export const ROWY: Record<Row, number> = { 'T+': 30, 'T-': 48, a: 84, b: 102, c: 120, d: 138, e: 156, f: 192, g: 210, h: 228, i: 246, j: 264, 'B-': 300, 'B+': 318 };
export const HEIGHT = 350;

export function pt(h: Hole): [number, number] {
  return [X0 + (h.col - 1) * P, ROWY[h.row]];
}

export function svgSize(board: BoardSpec): { width: number; height: number; viewBox: string } {
  const xr = X0 + (board.cols - 1) * P;
  const width = xr + 140;
  // The negative origin leaves room for the supply leads and their labels,
  // which are drawn in the margin outside the board itself.
  return { width, height: HEIGHT, viewBox: `-100 0 ${width} ${HEIGHT}` };
}
