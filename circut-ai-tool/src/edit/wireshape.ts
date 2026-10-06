// Hand edits to a square-cornered jumper, as pure functions on its plan (SVG
// units, from hole a to hole b). The 3D editor drives them from handles:
//
// - a segment handle drags one run sideways; its neighbours stretch. The
//   run out of a hole cannot leave its hole, so it gets a jog half a pitch
//   out and the rest of it moves (the "auto-jog" of JointJS and draw.io);
// - a bend handle moves one coordinate of each of its two runs, so the path
//   stays square;
// - a double-click adds a small Z to a run, or takes a bend out.
//
// What these functions guarantee, and what they do not: a result is square,
// simplified (no repeated, doubled-back or straight-through points), keeps
// both end holes exactly and leaves and enters each with a vertical stub.
// They do NOT check chip bodies, crossings or shared lines with other wires,
// or the board's bounds, and moveSegment/moveBend expect coordinates already
// snapped with snapAcross. The editor must validate every edited plan through
// planToPath plus shapePlan (route3d.ts) before accepting or saving it.
//
// Every result is simplified (no repeated or straight-through points). Runs
// across the board snap to corridor lanes and runs down it to the lines
// between columns, so a wire is never left lying along a row or column of
// holes by hand.

import { P, X0 } from '../render/geometry.ts';
import { GAPS, LANE, ROW_YS, simplify, type Point } from '../render/route3d.ts';

export interface Handle {
  kind: 'segment' | 'bend';
  /** segment: the run from plan[index] to plan[index + 1]; bend: plan[index]. */
  index: number;
  at: Point;
  /** segment: whether the run lies across the board (it then drags up and down). */
  horizontal: boolean;
}

const isH = (plan: Point[], i: number) => Math.abs(plan[i][1] - plan[i + 1][1]) < 0.01;
const runLength = (plan: Point[], i: number) => Math.abs(plan[i][0] - plan[i + 1][0]) + Math.abs(plan[i][1] - plan[i + 1][1]);

/** A segment handle on every run longer than about two pitches, and a bend handle on every corner. */
export function handles(plan: Point[]): Handle[] {
  const out: Handle[] = [];
  for (let i = 0; i + 1 < plan.length; i++) {
    if (runLength(plan, i) <= 2 * P - 0.01) continue;
    out.push({ kind: 'segment', index: i, at: [(plan[i][0] + plan[i + 1][0]) / 2, (plan[i][1] + plan[i + 1][1]) / 2], horizontal: isH(plan, i) });
  }
  for (let k = 1; k + 1 < plan.length; k++) out.push({ kind: 'bend', index: k, at: [plan[k][0], plan[k][1]], horizontal: false });
  return out;
}

const LANE_YS: number[] = (() => {
  const out: number[] = [];
  for (let y = GAPS[0].y; y <= GAPS[GAPS.length - 1].y + 0.01; y += LANE) if (!ROW_YS.has(y)) out.push(y);
  return out;
})();

/**
 * The nearest line a hand-moved run may lie on: a corridor lane for a run
 * across the board (never a row of holes), the line between two columns for
 * a run down it (never a column of holes).
 */
export function snapAcross(horizontal: boolean, v: number, cols: number): number {
  if (horizontal) return LANE_YS.reduce((best, y) => (Math.abs(y - v) < Math.abs(best - v) ? y : best), LANE_YS[0]);
  // Between columns of a board `cols` wide, no further out than half a pitch beyond the first and last.
  const k = Math.min(cols - 1, Math.max(-1, Math.round((v - X0) / P - 0.5)));
  return X0 + (k + 0.5) * P;
}

/** Move run i so it lies on `to` across itself, without simplifying (moveBend does two in a row). */
function shift(plan: Point[], i: number, to: number): Point[] {
  const across = isH(plan, i) ? 1 : 0;
  const along = 1 - across;
  const out = plan.map((p) => [p[0], p[1]] as Point);
  const n = out.length;
  const jog = (hole: Point, toward: Point): Point => {
    const p: Point = [hole[0], hole[1]];
    p[along] += Math.sign(toward[along] - hole[along]) * LANE;
    return p;
  };
  if (n === 2) {
    // Hole to hole in one run: jog out of both ends.
    const [a, b] = [out[0], out[1]];
    const [ja, jb] = [jog(a, b), jog(b, a)];
    const [ma, mb] = [[...ja] as Point, [...jb] as Point];
    ma[across] = to;
    mb[across] = to;
    return [a, ja, ma, mb, jb, b];
  }
  if (i === 0) {
    const ja = jog(out[0], out[1]);
    const m: Point = [...ja] as Point;
    m[across] = to;
    out[1][across] = to;
    return [out[0], ja, m, ...out.slice(1)];
  }
  if (i === n - 2) {
    const jb = jog(out[n - 1], out[n - 2]);
    const m: Point = [...jb] as Point;
    m[across] = to;
    out[n - 2][across] = to;
    return [...out.slice(0, n - 1), m, jb, out[n - 1]];
  }
  out[i][across] = to;
  out[i + 1][across] = to;
  return out;
}

/** Drag run i sideways to `to` (a coordinate across the run; snap it first). */
export function moveSegment(plan: Point[], i: number, to: number): Point[] {
  return simplify(shift(plan, i, to));
}

/**
 * Drag the corner plan[k] to `to`: the run before it and the run after it each take one of its coordinates.
 * `to` must already be snapped (snapAcross); like every edit here, the result is only square and simplified,
 * so validate it (planToPath, shapePlan) before use.
 */
export function moveBend(plan: Point[], k: number, to: Point): Point[] {
  // The later run first: a jog it adds at the far end does not move index k - 1.
  const after = shift(plan, k, isH(plan, k) ? to[1] : to[0]);
  return simplify(shift(after, k - 1, isH(after, k - 1) ? to[1] : to[0]));
}

/** The run of a plan nearest a point, for a double-click on the wire. */
export function nearestRun(plan: Point[], p: Point): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < plan.length; i++) {
    const [a, b] = [plan[i], plan[i + 1]];
    const x = Math.min(Math.max(p[0], Math.min(a[0], b[0])), Math.max(a[0], b[0]));
    const y = Math.min(Math.max(p[1], Math.min(a[1], b[1])), Math.max(a[1], b[1]));
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * Put a small Z into run i at the point nearest `at`: one part of the run
 * steps one line over. The part that steps is the one away from a hole, so
 * the ends stay put; a run from hole to hole gets a bump instead.
 */
export function addBendPair(plan: Point[], i: number, at: Point, cols: number): Point[] {
  const h = isH(plan, i);
  const across = h ? 1 : 0;
  const along = 1 - across;
  const [a, b] = [plan[i], plan[i + 1]];
  const lo = Math.min(a[along], b[along]) + LANE;
  const hi = Math.max(a[along], b[along]) - LANE;
  if (hi < lo) return plan;
  // On the half-pitch grid along the run, a lane in from each end.
  const origin = along === 0 ? X0 : GAPS[0].y;
  const mid = Math.min(hi, Math.max(lo, origin + Math.round((at[along] - origin) / LANE) * LANE));
  const c = a[across];
  const next = snapAcross(h, c + LANE + 0.01, cols);
  const pt = (t: number, v: number): Point => (h ? [t, v] : [v, t]);
  const last = plan.length - 2;
  if (plan.length === 2) {
    const [m1, m2] = [mid - LANE, mid + LANE].map((t) => Math.min(hi, Math.max(lo, t)));
    const s = Math.sign(b[along] - a[along]) || 1;
    const [p1, p2] = s > 0 ? [m1, m2] : [m2, m1];
    return simplify([a, pt(p1, c), pt(p1, next), pt(p2, next), pt(p2, c), b]);
  }
  if (i === last) {
    // The part before the Z steps over; the run into hole b stays on its column.
    return simplify([...plan.slice(0, i), pt(a[along], next), pt(mid, next), pt(mid, c), b]);
  }
  return simplify([...plan.slice(0, i + 1), pt(mid, c), pt(mid, next), pt(b[along], next), ...plan.slice(i + 2)]);
}

/**
 * Take the corner plan[k] out by swapping it for the opposite corner of the
 * rectangle its two runs span; with a straight run either side that removes
 * the pair. Null when the result would no longer leave a hole along its
 * column, or nothing changed.
 */
export function removeBend(plan: Point[], k: number): Point[] | null {
  if (k < 1 || k > plan.length - 2) return null;
  const [p, c, q] = [plan[k - 1], plan[k], plan[k + 1]];
  const out = simplify([...plan.slice(0, k), [p[0] + q[0] - c[0], p[1] + q[1] - c[1]], ...plan.slice(k + 1)]);
  const n = out.length;
  if (n === plan.length || Math.abs(out[0][0] - out[1][0]) > 0.01 || Math.abs(out[n - 1][0] - out[n - 2][0]) > 0.01) return null;
  return out;
}
