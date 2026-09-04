// Symbol placement math, taken from KiCad's SCH_SYMBOL::SetOrientation.
//
// Library symbols use y-up coordinates; the schematic uses y-down. The
// default orientation matrix (1, 0, 0, -1) flips y. Rotations and mirrors
// are composed onto it exactly the way KiCad does, so pin positions computed
// here match the positions KiCad uses for connectivity.

import type { Point } from './schematic.ts';
import { round4 } from '../sexpr.ts';

export interface Matrix {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const ORIENT_0: Matrix = { x1: 1, y1: 0, x2: 0, y2: -1 };
const ROTATE_CCW: Matrix = { x1: 0, y1: 1, x2: -1, y2: 0 };
const ROTATE_CW: Matrix = { x1: 0, y1: -1, x2: 1, y2: 0 };
const MIRROR_X: Matrix = { x1: 1, y1: 0, x2: 0, y2: -1 };
const MIRROR_Y: Matrix = { x1: -1, y1: 0, x2: 0, y2: 1 };

function compose(m: Matrix, t: Matrix): Matrix {
  return {
    x1: m.x1 * t.x1 + m.x2 * t.y1,
    y1: m.y1 * t.x1 + m.y2 * t.y1,
    x2: m.x1 * t.x2 + m.x2 * t.y2,
    y2: m.y1 * t.x2 + m.y2 * t.y2,
  };
}

export function symbolMatrix(rot: number, mirror: 'x' | 'y' | null): Matrix {
  let m = ORIENT_0;
  if (rot === 90) m = compose(m, ROTATE_CCW);
  else if (rot === 180) m = compose(compose(m, ROTATE_CCW), ROTATE_CCW);
  else if (rot === 270) m = compose(m, ROTATE_CW);
  if (mirror === 'x') m = compose(m, MIRROR_X);
  if (mirror === 'y') m = compose(m, MIRROR_Y);
  return m;
}

export function apply(m: Matrix, p: Point): Point {
  return { x: round4(m.x1 * p.x + m.y1 * p.y), y: round4(m.x2 * p.x + m.y2 * p.y) };
}

export interface Placed {
  at: Point;
  rot: number;
  mirror: 'x' | 'y' | null;
}

/** Schematic coordinates of a pin's connection end. */
export function pinPosition(sym: Placed, pin: { at: Point }): Point {
  const d = apply(symbolMatrix(sym.rot, sym.mirror), pin.at);
  return { x: round4(sym.at.x + d.x), y: round4(sym.at.y + d.y) };
}

/** Unit vector from the pin end toward the symbol body, schematic coordinates. */
export function pinBodyDirection(sym: Placed, pin: { angle: number }): Point {
  const rad = (pin.angle * Math.PI) / 180;
  const v = apply(symbolMatrix(sym.rot, sym.mirror), { x: Math.round(Math.cos(rad)), y: Math.round(Math.sin(rad)) });
  return { x: v.x === 0 ? 0 : v.x, y: v.y === 0 ? 0 : v.y };
}
