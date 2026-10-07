// The centre line of a flat jumper, as plain numbers: up out of one hole,
// along the routed plan with a hump at every lift, a fillet at every corner,
// and down into the other. The 3D tubes (client/wiretube-math.ts) and the
// clearance check (clearance.ts) both draw it from here, so what is measured
// is what is drawn.
//
// Pure (no three, no DOM).

import { BEND_R, rise, riseBreaks, STUB_R, type Lift, type Point } from './route3d.ts';

export type V3 = [number, number, number];

// The fillet radii live with the router, which sizes its humps by them.
export { BEND_R, STUB_R };
/** One ring per this much turn in a fillet: 15 degrees, so a 90 degree bend is 6 segments. */
export const ARC_STEP = Math.PI / 12;
/** Turns below this are not filleted. */
const SHALLOW = Math.PI / 4;

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
};
export const dist = (a: V3, b: V3) => len(sub(a, b));

export function pathLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/**
 * The centre line of a jumper in the scene's axes (x, y up, z = plan y): up
 * out of hole a from `endY`, onto the board at `base`, along the plan with a
 * hump at every lift, and back down into hole b.
 */
export function centreLine(plan: Point[], lifts: Lift[], base: number, endY: number): V3[] {
  // Distance along the plan to each corner.
  const at: number[] = [0];
  for (let i = 1; i < plan.length; i++) at.push(at[i - 1] + Math.abs(plan[i][0] - plan[i - 1][0]) + Math.abs(plan[i][1] - plan[i - 1][1]));
  const total = at[at.length - 1];
  const where = (s: number): Point => {
    let i = 1;
    while (i < at.length - 1 && at[i] < s) i++;
    const k = at[i] > at[i - 1] ? (s - at[i - 1]) / (at[i] - at[i - 1]) : 0;
    return [plan[i - 1][0] + (plan[i][0] - plan[i - 1][0]) * k, plan[i - 1][1] + (plan[i][1] - plan[i - 1][1]) * k];
  };
  const keys = new Set<number>(at);
  // Every corner of the hump profile, so the straight lines between samples are rise() exactly.
  for (const s of riseBreaks(lifts)) keys.add(Math.min(total, Math.max(0, s)));
  const out: V3[] = [[plan[0][0], endY, plan[0][1]]];
  for (const s of [...keys].sort((p, q) => p - q)) {
    const [x, z] = where(s);
    out.push([x, base + rise(lifts, s), z]);
  }
  out.push([plan[plan.length - 1][0], endY, plan[plan.length - 1][1]]);
  return dropCollinear(out);
}

/** Drop repeated points and points that do not turn the line (|u.v| above 0.9999); the ends stay. */
export function dropCollinear(pts: V3[]): V3[] {
  const out: V3[] = [];
  for (const p of pts) {
    if (out.length && dist(out[out.length - 1], p) < 1e-6) continue;
    while (out.length >= 2) {
      const u = norm(sub(out[out.length - 2], out[out.length - 1]));
      const v = norm(sub(p, out[out.length - 1]));
      if (Math.abs(dot(u, v)) > 0.9999) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

/**
 * Round every corner. At corner P between A and B: u = A - P, v = B - P
 * (normalised), theta the angle between them; the arc starts and ends a
 * distance d = min(r / tan(theta/2), |PA|/2, |PB|/2) from P, and r is worked
 * out again from d so a clamped corner is still a true arc. One sample per
 * ARC_STEP of turn.
 */
export function fillet(pts: V3[], radius: (i: number) => number, step = ARC_STEP): V3[] {
  const out: V3[] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i];
    const u = norm(sub(pts[i - 1], p));
    const v = norm(sub(pts[i + 1], p));
    const cos = dot(u, v);
    if (Math.abs(cos) > 0.9999) {
      out.push(p);
      continue;
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
    // A shallow turn (the ramps of a hump, about 34 degrees) stays a plain corner: the ring frames smooth it, and it saves a ring or two per hump.
    if (Math.PI - theta < SHALLOW) {
      out.push(p);
      continue;
    }
    const d = Math.min(radius(i) / Math.tan(theta / 2), dist(p, pts[i - 1]) / 2, dist(p, pts[i + 1]) / 2);
    const turn = Math.PI - theta;
    const centre = add(p, scale(norm(add(u, v)), d / Math.cos(theta / 2)));
    const a = sub(add(p, scale(u, d)), centre);
    const b = sub(add(p, scale(v, d)), centre);
    const n = Math.max(1, Math.ceil(turn / step - 1e-9));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      out.push(add(centre, scale(add(scale(a, Math.sin((1 - t) * turn)), scale(b, Math.sin(t * turn))), 1 / Math.sin(turn))));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
