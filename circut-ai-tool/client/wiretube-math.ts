// The geometry of a flat jumper, as plain numbers: the 3D centre line built
// from a routed plan, a fillet at every corner, and the rings of a tube along
// it. client/wiretube.ts turns the result into three.js BufferGeometry.
//
// Not three's TubeGeometry: it samples its curve evenly by length, so a tight
// fillet between two long runs gets one or two samples and comes out faceted
// or folds through itself. Here a straight run costs two rings and a bend
// gets one ring per 15 degrees of turn, wherever it is.
//
// Pure (no three, no DOM), so it is unit tested.

import type { Lift, Point } from '../src/render/route3d.ts';
import { P } from '../src/render/geometry.ts';

export type V3 = [number, number, number];

/** Bend radius along the board, about one wire diameter as a real jumper is bent. */
export const BEND_R = 4;
/** Bend radius where the wire comes up out of its hole: a little tighter. */
export const STUB_R = 3;
/** One ring per this much turn in a fillet. */
export const ARC_STEP = Math.PI / 12;
/** Bare wire showing above the board at each end, as a stripped jumper has. */
export const STRIP = 7;
/** Half the length of a hump over another wire: about two pitches in all. */
export const HUMP = P;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
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
  // A hump is a trapezoid: up over the outer third, level over the middle.
  const rise = (s: number) => lifts.reduce((h, l) => Math.max(h, l.height * Math.min(1, Math.max(0, (HUMP - Math.abs(s - l.at)) / (HUMP * (2 / 3))))), 0);
  const keys = new Set<number>(at);
  for (const l of lifts) for (const d of [-HUMP, -HUMP / 3, HUMP / 3, HUMP]) keys.add(Math.min(total, Math.max(0, l.at + d)));
  const out: V3[] = [[plan[0][0], endY, plan[0][1]]];
  for (const s of [...keys].sort((p, q) => p - q)) {
    const [x, z] = where(s);
    out.push([x, base + rise(s), z]);
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

/** The part of a line between two distances along it. */
export function trim(pts: V3[], from: number, to: number): V3[] {
  const out: V3[] = [];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const l = dist(a, b);
    const lerp = (x: number): V3 => add(a, scale(sub(b, a), l ? (x - s) / l : 0));
    if (s + l >= from && s <= to) {
      if (!out.length) out.push(lerp(Math.max(from, s)));
      if (s + l <= to) out.push(b);
      else {
        out.push(lerp(to));
        break;
      }
    }
    s += l;
  }
  return dropRepeats(out);
}

const dropRepeats = (pts: V3[]) => pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-6);

export interface TubeData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Rotate v about the unit axis k by angle (Rodrigues). */
function rotate(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/**
 * A tube of `sides` round a centre line: one ring per sample, frames carried
 * from ring to ring by parallel transport (the smallest rotation taking one
 * tangent to the next) so the tube never twists, and seeded pointing down on
 * the flattest run so the ring's seam lies against the board. `caps` closes
 * both ends.
 */
export function tubeData(centre: V3[], radius: number, sides: number, caps = false): TubeData {
  const n = centre.length;
  const tangents: V3[] = centre.map((_, i) => norm(sub(centre[Math.min(n - 1, i + 1)], centre[Math.max(0, i - 1)])));
  let seed = 0;
  for (let i = 1; i < n; i++) if (Math.abs(tangents[i][1]) < Math.abs(tangents[seed][1])) seed = i;
  const normals: V3[] = new Array(n);
  const down: V3 = [0, -1, 0];
  normals[seed] = norm(sub(down, scale(tangents[seed], dot(down, tangents[seed]))));
  const carry = (from: number, to: number) => {
    const [t0, t1] = [tangents[from], tangents[to]];
    const axis = cross(t0, t1);
    const sin = len(axis);
    let v = normals[from];
    if (sin > 1e-9) v = rotate(v, scale(axis, 1 / sin), Math.atan2(sin, dot(t0, t1)));
    normals[to] = norm(sub(v, scale(t1, dot(v, t1))));
  };
  for (let i = seed + 1; i < n; i++) carry(i - 1, i);
  for (let i = seed - 1; i >= 0; i--) carry(i + 1, i);

  const ring = sides + 1;
  const count = n * ring + (caps ? 2 * (ring + 1) : 0);
  const positions = new Float32Array(count * 3);
  const norms = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices: number[] = [];
  let s = 0;
  let vi = 0;
  const put = (p: V3, nn: V3, u: number, v: number) => {
    positions.set(p, vi * 3);
    norms.set(nn, vi * 3);
    uvs.set([u, v], vi * 2);
    return vi++;
  };
  for (let i = 0; i < n; i++) {
    if (i) s += dist(centre[i - 1], centre[i]);
    const b = cross(tangents[i], normals[i]);
    for (let j = 0; j <= sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const dir = add(scale(normals[i], Math.cos(a)), scale(b, Math.sin(a)));
      put(add(centre[i], scale(dir, radius)), dir, s / 20, j / sides);
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * ring + j;
      const b = a + ring;
      // Wound so the faces look outwards.
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (caps) {
    for (const [i, facing] of [[0, -1], [n - 1, 1]] as const) {
      const out = scale(tangents[i], facing);
      const mid = put(centre[i], out, 0, 0);
      const first = vi;
      for (let j = 0; j <= sides; j++) put(Array.from(positions.subarray((i * ring + j) * 3, (i * ring + j) * 3 + 3)) as V3, out, 0, 0);
      for (let j = 0; j < sides; j++) indices.push(...(facing > 0 ? [mid, first + j, first + j + 1] : [mid, first + j + 1, first + j]));
    }
  }
  return { positions, normals: norms, uvs, indices: Uint32Array.from(indices) };
}

/** Two tubes as one buffer set, so both bare ends of a wire are one draw. */
export function mergeTubes(a: TubeData, b: TubeData): TubeData {
  const offset = a.positions.length / 3;
  const cat = (x: Float32Array, y: Float32Array) => {
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  indices.set(b.indices.map((i) => i + offset), a.indices.length);
  return { positions: cat(a.positions, b.positions), normals: cat(a.normals, b.normals), uvs: cat(a.uvs, b.uvs), indices };
}

export interface WireShape {
  /** The jacket, stopping STRIP short of the board at each end, capped. */
  jacket: TubeData;
  /** The two bare tinned ends, from inside each hole to just under the jacket. */
  tin: TubeData;
  /** Centre-line length in scene units. */
  length: number;
  /** The filleted centre line, for the selection outline and the card's anchor. */
  line: V3[];
}

/**
 * Everything a jumper's meshes need. `base` is the height of the centre line
 * where it lies on the board (the board top plus the jacket radius), `endY`
 * the depth its tips reach inside the holes, `top` the board top.
 */
export function wireShape(plan: Point[], lifts: Lift[], o: { base: number; endY: number; top: number; radius: number; core: number; sides: number; coreSides: number }): WireShape {
  const raw = centreLine(plan, lifts, o.base, o.endY);
  // The corners where the wire comes out of its holes are the first and last.
  const line = fillet(raw, (i) => (i === 1 || i === raw.length - 2 ? STUB_R : BEND_R));
  const length = pathLength(line);
  const bare = o.top - o.endY + STRIP;
  const jacket = tubeData(trim(line, bare, length - bare), o.radius, o.sides, true);
  // A little under the jacket at each end, so no gap shows between the two.
  const tin = mergeTubes(tubeData(trim(line, 0, bare + 1), o.core, o.coreSides), tubeData(trim(line, length - bare - 1, length), o.core, o.coreSides));
  return { jacket, tin, length, line };
}
