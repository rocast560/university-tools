// Do two jumpers clip into each other in 3D? Each routed wire's centre line is
// built exactly as the 3D board draws its tube (centreLine, then fillet), and
// every pair of different wires is measured capsule to capsule: closer than
// one wire diameter and the two tubes overlap.
//
// Pure, so a test can hold the router to it on whole real boards.

import type { LayoutDoc } from '../pipeline.ts';
import { centreLine, fillet, STUB_R, BEND_R, type V3 } from './centreline.ts';
import { WIRE_R, type WireRoute } from './route3d.ts';
import { WIRE_END_Y } from './altitude.ts';

/** The board top in the 3D scene, as client/board3d-parts.ts has it. */
const TOP = 0;

export interface ClipPair {
  /** Indices into doc.wires, a < b. */
  a: number;
  b: number;
  /** The least distance between the two centre lines. */
  distance: number;
  /** The point on wire a's centre line where that is, in scene axes (x, height, plan y). */
  at: [number, number, number];
}

/**
 * Every wire's centre line as the 3D board draws it, flat at TOP + WIRE_R.
 * (A wire the simple router drew is lifted over bodies by the 3D board too;
 * that is about bodies, not other wires, and is not modelled here.)
 */
export function centreLines(routes: WireRoute[]): V3[][] {
  return routes.map((r) => {
    const raw = centreLine(r.plan, r.lifts, TOP + WIRE_R, WIRE_END_Y);
    return fillet(raw, (i) => (i === 1 || i === raw.length - 2 ? STUB_R : BEND_R));
  });
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** The least distance between segments p1-q1 and p2-q2, and the point on the first (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1: V3, q1: V3, p2: V3, q2: V3): [number, V3] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const c1: V3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: V3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return [Math.hypot(...sub(c1, c2)), c1];
}

/** The least distance between two polylines, and where on the first. */
export function lineDistance(l1: V3[], l2: V3[]): [number, V3] {
  let best: [number, V3] = [Infinity, l1[0]];
  for (let i = 0; i + 1 < l1.length; i++) {
    for (let j = 0; j + 1 < l2.length; j++) {
      const r = segmentDistance(l1[i], l1[i + 1], l2[j], l2[j + 1]);
      if (r[0] < best[0]) best = r;
    }
  }
  return best;
}

/**
 * Pairs of wires whose 3D centre lines come closer than `minGap` (by default
 * one wire diameter: the tubes touch or overlap), closest first. Only square
 * wires have routes; a doc without them has nothing to measure. A hair of
 * tolerance keeps two tubes lying exactly side by side, or a hump exactly one
 * diameter up, from counting.
 */
export function clipPairs(doc: Pick<LayoutDoc, 'routes'>, minGap = 2 * WIRE_R): ClipPair[] {
  const routes = doc.routes;
  if (!routes) return [];
  const lines = centreLines(routes);
  const boxes = lines.map((l) => l.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[2]), Math.max(b[2], p[0]), Math.max(b[3], p[2])], [Infinity, Infinity, -Infinity, -Infinity]));
  const limit = minGap - 0.01;
  const out: ClipPair[] = [];
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const [A, B] = [boxes[a], boxes[b]];
      if (A[0] > B[2] + minGap || B[0] > A[2] + minGap || A[1] > B[3] + minGap || B[1] > A[3] + minGap) continue;
      const [distance, at] = lineDistance(lines[a], lines[b]);
      if (distance < limit) out.push({ a, b, distance, at });
    }
  }
  return out.sort((p, q) => p.distance - q.distance);
}
