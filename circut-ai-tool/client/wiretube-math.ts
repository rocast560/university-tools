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

import { add, BEND_R, centreLine, cross, dist, dot, fillet, len, norm, pathLength, scale, STUB_R, sub, type V3 } from '../src/render/centreline.ts';
import type { Lift, Point } from '../src/render/route3d.ts';

// The centre line lives in src/ so the clearance check measures the very line drawn here.
export { ARC_STEP, BEND_R, centreLine, dist, dropCollinear, fillet, pathLength, STUB_R, type V3 } from '../src/render/centreline.ts';

/** Bare wire showing above the board at each end, as a stripped jumper has. */
export const STRIP = 7;

/** The part of a line between two distances along it. */
export function trim(pts: V3[], from: number, to: number): V3[] {
  if (to <= from) return [];
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

const EMPTY = (): TubeData => ({ positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) });

/** Tangents and twist-free ring frames along a line, seeded pointing down on its flattest run. */
interface Frames {
  tangents: V3[];
  normals: V3[];
}

function frames(centre: V3[]): Frames {
  const n = centre.length;
  const tangents: V3[] = centre.map((_, i) => norm(sub(centre[Math.min(n - 1, i + 1)], centre[Math.max(0, i - 1)])));
  let seed = 0;
  for (let i = 1; i < n; i++) if (Math.abs(tangents[i][1]) < Math.abs(tangents[seed][1])) seed = i;
  const normals: V3[] = new Array(n);
  // A wire that is vertical all the way has no flat run to lie against: any sideways reference will do.
  const ref: V3 = Math.abs(tangents[seed][1]) > 0.999 ? [1, 0, 0] : [0, -1, 0];
  normals[seed] = norm(sub(ref, scale(tangents[seed], dot(ref, tangents[seed]))));
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
  return { tangents, normals };
}

/** The rings `from`..`to` (inclusive) of a line whose frames are already known. */
function tubeRange(centre: V3[], f: Frames, from: number, to: number, radius: number, sides: number, caps: boolean): TubeData {
  const n = to - from + 1;
  if (n < 2) return EMPTY();
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
    const c = centre[from + i];
    if (i) s += dist(centre[from + i - 1], c);
    const nrm = f.normals[from + i];
    const b = cross(f.tangents[from + i], nrm);
    for (let j = 0; j <= sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const dir = add(scale(nrm, Math.cos(a)), scale(b, Math.sin(a)));
      put(add(c, scale(dir, radius)), dir, s / 20, j / sides);
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
      const out = scale(f.tangents[from + i], facing);
      const mid = put(centre[from + i], out, 0, 0);
      const first = vi;
      for (let j = 0; j <= sides; j++) put(Array.from(positions.subarray((i * ring + j) * 3, (i * ring + j) * 3 + 3)) as V3, out, 0, 0);
      for (let j = 0; j < sides; j++) indices.push(...(facing > 0 ? [mid, first + j, first + j + 1] : [mid, first + j + 1, first + j]));
    }
  }
  return { positions, normals: norms, uvs, indices: Uint32Array.from(indices) };
}

/**
 * A tube of `sides` round a centre line: one ring per sample, frames carried
 * from ring to ring by parallel transport (the smallest rotation taking one
 * tangent to the next) so the tube never twists, and seeded pointing down on
 * the flattest run so the ring's seam lies against the board. `caps` closes
 * both ends. A line of fewer than two distinct points gives empty buffers.
 */
export function tubeData(centre: V3[], radius: number, sides: number, caps = false): TubeData {
  const line = dropRepeats(centre);
  if (line.length < 2) return EMPTY();
  return tubeRange(line, frames(line), 0, line.length - 1, radius, sides, caps);
}

/** Insert a point at each given distance along a line (no repeats), returning the new line and the index of each cut. */
function splitAt(pts: V3[], cuts: number[]): { line: V3[]; index: number[] } {
  const line: V3[] = [pts[0]];
  const index: number[] = new Array(cuts.length);
  const order = cuts.map((c, i) => [c, i] as const).sort((p, q) => p[0] - q[0]);
  let k = 0;
  let s = 0;
  const mark = (upTo: number, at: number) => {
    while (k < order.length && order[k][0] <= upTo + 1e-9) {
      const [d, i] = order[k++];
      if (d <= 1e-9) index[i] = 0;
      else if (d >= at - 1e-9) index[i] = line.length - 1;
    }
  };
  mark(0, 0);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const l = dist(a, b);
    while (k < order.length && order[k][0] > s + 1e-9 && order[k][0] < s + l - 1e-9) {
      const [d, idx] = order[k++];
      line.push(add(a, scale(sub(b, a), (d - s) / l)));
      index[idx] = line.length - 1;
    }
    line.push(b);
    s += l;
    while (k < order.length && order[k][0] <= s + 1e-9) index[order[k++][1]] = line.length - 1;
  }
  while (k < order.length) index[order[k++][1]] = line.length - 1;
  return { line, index };
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
  // One set of frames for the whole wire, cut into pieces afterwards, so the
  // jacket and the tin share seams and a short vertical piece cannot lose its frame.
  const cuts = [bare, bare + 1, length - bare - 1, length - bare];
  const usable = length > 2 * bare + 2;
  const { line: cut, index } = splitAt(line, usable ? cuts : []);
  const f = frames(cut);
  const last = cut.length - 1;
  const piece = (from: number, to: number, r: number, sides: number, caps: boolean) => tubeRange(cut, f, from, to, r, sides, caps);
  if (!usable) {
    // Too short for a jacket: all bare tin.
    return { jacket: EMPTY(), tin: piece(0, last, o.core, o.coreSides, false), length, line };
  }
  const jacket = piece(index[0], index[3], o.radius, o.sides, true);
  // A little under the jacket at each end, so no gap shows between the two.
  const tin = mergeTubes(piece(0, index[1], o.core, o.coreSides, false), piece(index[2], last, o.core, o.coreSides, false));
  return { jacket, tin, length, line };
}
