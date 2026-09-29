// How far each jumper bows out of the straight line between its two holes.
//
// Straight wires are honest and unreadable. Two links along the same row lie
// exactly on top of each other, and a crossing is just an X you cannot follow
// back to either end. Bowing every wire, and bowing wires that share a
// corridor by different amounts, gives each one its own lane so the eye can
// trace it from hole to hole.
//
// Pure, and a function of the wire list alone: the same board always draws the
// same arcs, which is what the flat SVG's byte-for-byte contract needs.

import { pt, ROWY } from './geometry.ts';
import type { Wire } from '../layout/types.ts';

/** The control point of a wire's quadratic, in SVG units. */
export type Control = [number, number];

/** Even a one-hole hop gets a visible bend. */
const BASE_MIN = 5;
/** How much of its own length a wire arcs by. */
const BASE_RATE = 0.09;
/**
 * Ceiling on the bow. A quadratic deviates by half its control offset, so 28
 * puts the apex 14 units out: most of a hole pitch, and never a whole row.
 */
const BASE_MAX = 28;
/** Ideal separation between two wires sharing a corridor. */
const LANE_GAP = 14;
/** However many share it, the fan spans no more than this. */
const FAN_SPAN = 48;
/** Below this the normal is too horizontal to say which way is "outward". */
const OUTWARD_MIN = 0.2;
/** The centre channel: arcs bow away from it, not over the chips. */
const CHANNEL_Y = (ROWY.e + ROWY.f) / 2;
/** Buckets that decide whether two wires run along the same line. */
const ANGLE_STEP = Math.PI / 30;
const OFFSET_STEP = 9;

interface Geometry {
  mx: number;
  my: number;
  /** Unit normal the wire bows along. */
  nx: number;
  ny: number;
  /** Bow before any fanning. */
  base: number;
  /** Wires sharing this key run along the same line, so they must fan apart. */
  corridor: string;
  /** Position along that line, so the fan is ordered rather than arbitrary. */
  along: number;
}

function geometry(w: Wire): Geometry {
  const [ax, ay] = pt(w.a);
  const [bx, by] = pt(w.b);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Canonical direction: left to right, and top to bottom when vertical, so
  // that swapping a wire's two ends cannot flip which way it bows.
  const flip = dx < 0 || (dx === 0 && dy < 0);
  const ux = (flip ? -dx : dx) / len;
  const uy = (flip ? -dy : dy) / len;
  let nx = uy;
  let ny = -ux;
  // Bow away from the centre channel where the normal has a say in it, so a
  // long run along a row lifts towards the edge of the board rather than over
  // the chips. A vertical wire's normal is horizontal and keeps the canonical
  // side.
  const my = (ay + by) / 2;
  if (Math.abs(ny) > OUTWARD_MIN && (my - CHANNEL_Y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return {
    mx: (ax + bx) / 2,
    my,
    nx,
    ny,
    base: Math.min(BASE_MAX, BASE_MIN + len * BASE_RATE),
    // Two wires share a corridor when their infinite lines nearly coincide:
    // same heading, same perpendicular distance from the origin.
    corridor: `${Math.round(Math.atan2(uy, ux) / ANGLE_STEP)}:${Math.round((ax * uy - ay * ux) / OFFSET_STEP)}`,
    along: ax * ux + ay * uy,
  };
}

/** Where each wire's quadratic control point goes, in the order given. */
export function wireControls(wires: Wire[]): Control[] {
  const geo = wires.map(geometry);
  const bows = geo.map((g) => g.base);
  const corridors = new Map<string, number[]>();
  geo.forEach((g, i) => corridors.set(g.corridor, [...(corridors.get(g.corridor) ?? []), i]));
  for (const members of corridors.values()) {
    if (members.length < 2) continue;
    const gap = Math.min(LANE_GAP, FAN_SPAN / (members.length - 1));
    // Order by where each wire sits along the shared line, so neighbours in
    // the fan are neighbours on the board.
    const order = [...members].sort((i, j) => geo[i].along - geo[j].along || i - j);
    order.forEach((i, lane) => {
      bows[i] = geo[i].base + (lane - (order.length - 1) / 2) * gap;
    });
  }
  return geo.map((g, i) => [g.mx + g.nx * bows[i], g.my + g.ny * bows[i]]);
}
