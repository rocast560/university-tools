// Translate a part's holes by a pointer delta in SVG units, snapping to the grid.

import type { BoardSpec, Hole, Row } from '../src/layout/types.ts';
import { isRail } from '../src/layout/board.ts';
import { P, ROWY } from '../src/render/index.ts';

const STRIP_ROWS: Row[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

export function nearestRow(y: number): Row {
  let best: Row = 'a';
  let dist = Infinity;
  for (const r of STRIP_ROWS) {
    const d = Math.abs(ROWY[r] - y);
    if (d < dist) {
      dist = d;
      best = r;
    }
  }
  return best;
}

export function shiftHoles(holes: Record<string, Hole>, dx: number, dy: number, board: BoardSpec, columnsOnly: boolean): Record<string, Hole> | null {
  const dCols = Math.round(dx / P);
  const out: Record<string, Hole> = {};
  for (const [pin, h] of Object.entries(holes)) {
    const col = h.col + dCols;
    const row = columnsOnly || isRail(h.row) ? h.row : nearestRow(ROWY[h.row] + dy);
    if (col < 1 || col > board.cols) return null;
    if (isRail(row) && col % board.railGapEvery === 0) return null;
    out[pin] = { col, row };
  }
  return out;
}
