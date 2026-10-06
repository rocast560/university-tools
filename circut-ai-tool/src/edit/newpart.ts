// Parts that are not in the schematic yet: their pins and breadboard
// footprint, worked out from the library symbol. Pure, so the tray's choices
// are testable without a browser.

import type { LibSymbol } from '../kicad/schematic.ts';
import type { Component, DesignPin } from '../netlist.ts';
import type { Footprint } from '../parts/catalog.ts';
import type { BoardSpec, Hole, Row } from '../layout/types.ts';
import { P, ROWY, tierAtY, tierCols, tierOf, X0 } from '../render/geometry.ts';
import { inBoard, ROW_ORDER } from './placement.ts';

/** Every pin of every unit, unconnected: what classify() needs to pick a footprint. */
export function componentFromSymbol(lib: LibSymbol, value: string, ref = 'NEW?'): Component {
  const libName = lib.id.includes(':') ? lib.id.slice(0, lib.id.indexOf(':')) : '';
  const pins = new Map<string, DesignPin>();
  for (const list of lib.units.values()) for (const p of list) if (!pins.has(p.number)) pins.set(p.number, { num: p.number, name: p.name, type: p.type, net: '' });
  return { ref, value, lib: libName, part: lib.name, pins };
}

/** Columns between a two-lead part's legs, by style, when it is dropped flat along a row. */
export const LEAD_SPAN: Record<string, number> = { R: 4, D: 4, Z: 4, L: 4, LED: 1, C: 1, Cpol: 1, SW: 2, BTN: 2, X: 2 };

/** The hole under a point in plan (SVG) units, on whichever stacked board it falls; null off the board. */
export function holeNear(board: BoardSpec, [x, y]: [number, number]): Hole | null {
  const { tier, y: yl } = tierAtY(board, y);
  let row: Row = ROW_ORDER[0];
  for (const r of ROW_ORDER) if (Math.abs(ROWY[r] - yl) < Math.abs(ROWY[row] - yl)) row = r;
  if (Math.abs(ROWY[row] - yl) > P) return null;
  const local = Math.round((x - X0) / P) + 1;
  if (local < 1 || local > tierCols(board)) return null;
  const h = { col: local + tier * tierCols(board), row };
  return inBoard(h, board) ? h : null;
}

/** Where each leg goes when a part with footprint `fp` is dropped with its first leg at `at`; null when it cannot sit there. */
export function defaultHoles(fp: Footprint, pins: string[], at: Hole, board: BoardSpec): Record<string, Hole> | null {
  const out: Record<string, Hole> = {};
  const sameBoard = (c0: number, c1: number) => tierOf(board, c0) === tierOf(board, c1);
  switch (fp.kind) {
    case 'lead2': {
      const span = LEAD_SPAN[fp.style] ?? 3;
      if (!sameBoard(at.col, at.col + span)) return null;
      out[pins[0]] = { ...at };
      out[pins[1]] = { col: at.col + span, row: at.row };
      break;
    }
    case 'dip':
    case 'dipswitch': {
      if (at.row !== 'e' && at.row !== 'f') return null;
      // A dipswitch's pins come as pairs (1, 14, 2, 13, ...); lay out in pin order.
      const order = [...pins].sort((a, b) => Number(a) - Number(b));
      const n = order.length / 2;
      if (!Number.isInteger(n) || n < 1 || !sameBoard(at.col, at.col + n - 1)) return null;
      for (let i = 0; i < n; i++) out[order[i]] = { col: at.col + i, row: 'f' };
      for (let i = 0; i < n; i++) out[order[n + i]] = { col: at.col + n - 1 - i, row: 'e' };
      break;
    }
    case 'to92':
    case 'pot3': {
      if (!sameBoard(at.col, at.col + 2)) return null;
      pins.forEach((p, i) => (out[p] = { col: at.col + i, row: at.row }));
      break;
    }
    default:
      return null;
  }
  return Object.values(out).every((h) => inBoard(h, board)) ? out : null;
}
