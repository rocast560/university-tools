// Translate a part's holes by a pointer delta in SVG units, snapping to the grid.

import type { BoardSpec, Hole, Row } from '../src/layout/types.ts';
import { isRail } from '../src/layout/board.ts';
import { P, placeAt, ROWY, tierAtY, tierCols, tierOf, X0 } from '../src/render/index.ts';

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
  // Worked in drawn coordinates, so a part can be dragged from one stacked
  // board to the other; on a single board this is the plain column shift.
  const tc = tierCols(board);
  const out: Record<string, Hole> = {};
  for (const [pin, h] of Object.entries(holes)) {
    const [x, y] = placeAt(board, h);
    const at = tierAtY(board, y + dy);
    const tier = columnsOnly ? tierOf(board, h.col) : at.tier;
    const local = Math.round((x + dx - X0) / P) + 1;
    if (local < 1 || local > tc) return null;
    const col = local + tier * tc;
    const row = columnsOnly || isRail(h.row) ? h.row : nearestRow(columnsOnly ? ROWY[h.row] : at.y);
    if (isRail(row) && col % board.railGapEvery === 0) return null;
    out[pin] = { col, row };
  }
  return out;
}
