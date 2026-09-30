// Square-cornered jumpers that lie flat on the board, the way a carefully
// hand-wired breadboard looks: cut to length, flush on the plastic, bent
// tight, bundled in parallel lanes, and never run over a chip.
//
// Four passes, after libavoid's route-then-nudge (Wybrow, Marriott and
// Stuckey 2009):
//   1. Hand-shaped wires first. A saved path whose end holes still match a
//      wire is used as it is and holds its lines; one that matches no wire is
//      dropped with a warning naming its net.
//   2. Every other wire, shortest first, is found by A* over a lattice with a
//      node every half pitch, the heading in the state so that a bend can
//      cost something. Without a bend penalty the cheapest paths staircase.
//   3. Nudging. Runs that ended up on the same line are packed into parallel
//      lanes with the left-edge algorithm, ordered so a bundle does not cross
//      itself where its wires peel off. Wires still sharing a line after that
//      are ripped up and searched again with sharing made dear, a few rounds.
//   4. Where two wires still cross, the one laid later humps over.
//
// Pure: a function of the wires, the packages, the legs and the saved paths,
// so the flat board and the 3D board draw the same wires. The old corridor
// router in ortho.ts is the fallback when a search gives up.

import { holeKey } from '../layout/board.ts';
import type { BoardSpec, Hole, Package, Row, Wire, WirePath, WirePoint } from '../layout/types.ts';
import { HEIGHT, P, pt, ROWY, X0 } from './geometry.ts';
import { packageRects, wirePolylines } from './ortho.ts';

export type Point = [number, number];

/** A hump where this wire passes over another: `at` is the distance along the plan, in SVG units. */
export interface Lift {
  at: number;
  height: number;
}

export interface WireRoute {
  /** From the wire's `a` hole to its `b` hole, square corners only, in SVG units. */
  plan: Point[];
  lifts: Lift[];
  /** Set when no clean route was found and the simple router drew it instead. */
  warning?: string;
  /** Hand-shaped: taken from the sidecar, not routed. */
  locked?: true;
}

export interface RouteResult {
  routes: WireRoute[];
  warnings: string[];
}

export interface RouteInput {
  wires: Wire[];
  packages: Package[];
  board: BoardSpec;
  pinHoles: Record<string, Record<string, Hole>>;
}

/** The jacket's radius: 0.56 mm, so 1.1 mm across, like 22 AWG solid-core wire. */
export const WIRE_R = 4;
export const WIRE_D = 2 * WIRE_R;
/** Lane pitch: one wire diameter and a hair of air, which is half a hole pitch, so every lane sits on one grid. */
export const LANE = P / 2;
/**
 * Expanded states before a search gives up and the simple router takes over.
 * The lattice's own (node, heading) state space is the real bound (about 19k on
 * a full board, so this never binds there); the cap is a safety net.
 */
export const MAX_EXPAND = 30000;

// A* weights, in SVG units of length (a pitch is 18).
const BEND = 60;
/** Per half pitch of line another wire already lies on; nudging can usually part two, rarely five. */
const SHARE = 40;
/** The same down a column track, where there is far less room to part them. */
const SHARE_V = 400;
/** Through a node where another wire turns: the two would look joined. */
const TOUCH = 400;
/** Per wire crossed. */
const CROSS = 10;
/** Per half pitch hugging a package body. */
const NEAR_CHIP = 8;
/** Per half pitch along a row of holes, or down a column of them, rather than between. */
const ON_HOLES = 4;
/** Rounds of ripping up and searching again the wires that still clash after nudging. */
const RIP_ROUNDS = 3;

/** Air between a wire and a body it must not cross, as in ortho.ts. */
const AIR = 3;
/** How close to a body counts as hugging it. */
const HUG = 4;

const ROWS: Row[] = ['T+', 'T-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'B-', 'B+'];

export interface Gap {
  name: string;
  /** The corridor's centre line. */
  y: number;
}

/**
 * The corridors, top to bottom: one outside each rail, and one between each
 * pair of neighbouring hole rows, named by those rows. A saved bend is a
 * corridor and a signed lane from its centre line, one lane per half pitch.
 */
export const GAPS: Gap[] = (() => {
  const out: Gap[] = [{ name: 'top', y: ROWY['T+'] - P }];
  for (let i = 0; i + 1 < ROWS.length; i++) out.push({ name: `${ROWS[i]}|${ROWS[i + 1]}`, y: (ROWY[ROWS[i]] + ROWY[ROWS[i + 1]]) / 2 });
  out.push({ name: 'bottom', y: ROWY['B+'] + P });
  return out;
})();
const GAP_INDEX = new Map(GAPS.map((g, i) => [g.name, i]));

/** The lines wires may lie on: every half pitch from the top corridor to the bottom one. */
const Y0 = GAPS[0].y;
const LINES = Math.round((GAPS[GAPS.length - 1].y - Y0) / LANE) + 1;
/** Plan y of the lines that run along a row of holes. */
export const ROW_YS = new Set(ROWS.map((r) => ROWY[r]));

/** The sidecar key for a wire's hand shape: its net and both holes, sorted as strings. */
export function wireKey(w: Wire): string {
  return `${w.net}|${[holeKey(w.a), holeKey(w.b)].sort().join('|')}`;
}

/** The net a wire key names (a net name may itself contain '|'). */
export const keyNet = (key: string) => key.split('|').slice(0, -2).join('|');
/** The two holes a wire key names, as "e12-a20". */
const keyHoles = (key: string) => key.split('|').slice(-2).join('-');

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
}

/** Package bodies with a little air round them: a wire must never cross one. */
export function chipRects(packages: Package[]): Rect[] {
  return packageRects(packages).map((r, i) => ({ x1: r.x1 - AIR, y1: r.y1 - AIR, x2: r.x2 + AIR, y2: r.y2 + AIR, id: packages[i].id }));
}

const grow = (r: Rect, m: number): Rect => ({ x1: r.x1 - m, y1: r.y1 - m, x2: r.x2 + m, y2: r.y2 + m, id: r.id });
const inside = (p: Point, r: Rect) => p[0] > r.x1 && p[0] < r.x2 && p[1] > r.y1 && p[1] < r.y2;
/** Whether an axis-aligned segment passes through the inside of a rectangle. */
const crosses = (a: Point, b: Point, r: Rect) => Math.max(a[0], b[0]) > r.x1 && Math.min(a[0], b[0]) < r.x2 && Math.max(a[1], b[1]) > r.y1 && Math.min(a[1], b[1]) < r.y2;
const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

/** Drop repeated points and points in the middle of a straight run, cascading (a removal can expose another); the two ends always stay. */
export function simplify(plan: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of plan) {
    if (out.length && same(out[out.length - 1], p)) continue;
    // Popping a middle point can leave the new last three straight or doubled back, so keep checking.
    while (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]];
      const straight = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01);
      if (!straight) break;
      out.pop();
    }
    if (out.length && same(out[out.length - 1], p)) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Length along a square-cornered plan. */
export const planLength = (plan: Point[]) => plan.reduce((s, p, i) => (i ? s + Math.abs(p[0] - plan[i - 1][0]) + Math.abs(p[1] - plan[i - 1][1]) : 0), 0);

/**
 * Lattice nodes where a leg or a jumper end sits, by `nodeKey`, naming what
 * is there: "a leg at d12" or "another jumper's end at d12". A wire may lie
 * across an empty hole, never on one of these (bar its own two ends).
 */
export type Taken = Map<string, string>;

/** A point's lattice node as "k,j" (half pitches from X0 and Y0), or null when it is off the lattice. */
export function nodeKey([x, y]: Point): string | null {
  const k = Math.round((x - X0) / LANE);
  const j = Math.round((y - Y0) / LANE);
  return Math.abs(X0 + k * LANE - x) < 0.01 && Math.abs(Y0 + j * LANE - y) < 0.01 ? `${k},${j}` : null;
}

/** Every leg and every jumper end on the board, for checkPlan and shapePlan. */
export function takenNodes(input: Pick<RouteInput, 'pinHoles' | 'wires'>): Taken {
  const out: Taken = new Map();
  for (const w of input.wires) for (const h of [w.a, w.b]) {
    const k = nodeKey(pt(h));
    if (k) out.set(k, `another jumper's end at ${holeKey(h)}`);
  }
  // Legs last, so a hole holding both is named for the leg.
  for (const pins of Object.values(input.pinHoles)) for (const h of Object.values(pins)) {
    const k = nodeKey(pt(h));
    if (k) out.set(k, `a leg at ${holeKey(h)}`);
  }
  return out;
}

/**
 * Why a plan cannot be a jumper on this board, or null when it can: square
 * corners only, straight out of each hole along its column, on the board,
 * never through a package body (other than one holding its own end), and,
 * given `taken`, never over a leg or another jumper's end. The plan's own two
 * ends are its holes, so they are the only taken nodes it may touch.
 */
export function checkPlan(plan: Point[], packages: Package[], board: BoardSpec, taken?: Taken): string | null {
  if (plan.length < 2) return 'a jumper needs two ends';
  for (let i = 0; i + 1 < plan.length; i++) if (Math.abs(plan[i][0] - plan[i + 1][0]) > 0.01 && Math.abs(plan[i][1] - plan[i + 1][1]) > 0.01) return 'the path must turn square corners';
  const n = plan.length;
  if (Math.abs(plan[0][0] - plan[1][0]) > 0.01 || Math.abs(plan[n - 1][0] - plan[n - 2][0]) > 0.01) return 'a jumper has to leave each hole straight along its column';
  const width = 2 * X0 + (board.cols - 1) * P;
  if (plan.some(([x, y]) => x < WIRE_R || x > width - WIRE_R || y < WIRE_R || y > HEIGHT - WIRE_R)) return 'the path leaves the board';
  const ends = [plan[0], plan[n - 1]];
  for (const r of chipRects(packages)) {
    if (ends.some((e) => inside(e, r))) continue;
    for (let i = 0; i + 1 < n; i++) if (crosses(plan[i], plan[i + 1], r)) return `the path runs through ${r.id}`;
  }
  if (taken?.size) {
    const own = new Set([nodeKey(plan[0]), nodeKey(plan[n - 1])]);
    // Every lattice node along every run, bends included: a run stretched
    // along a strip would otherwise lie on the legs standing in it.
    for (let i = 0; i + 1 < n; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      const steps = Math.round((Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / LANE);
      const [dx, dy] = [Math.sign(b[0] - a[0]) * LANE, Math.sign(b[1] - a[1]) * LANE];
      for (let t = 0; t <= steps; t++) {
        const k = nodeKey([a[0] + t * dx, a[1] + t * dy]);
        const what = k && !own.has(k) ? taken.get(k) : undefined;
        if (what) return `the path runs over ${what}`;
      }
    }
  }
  return null;
}

/** A saved shape turned into a plan from `w.a` to `w.b`, or null when it names a corridor this board lacks. */
export function pathToPlan(w: Wire, path: WirePath): Point[] | null {
  const pts: Point[] = [];
  for (const p of path.points) {
    const g = GAP_INDEX.get(p.gap);
    if (g === undefined) return null;
    pts.push([X0 + (p.col - 1) * P, GAPS[g].y + p.lane * LANE]);
  }
  if (holeKey(w.a) > holeKey(w.b)) pts.reverse();
  return [pt(w.a), ...pts, pt(w.b)];
}

/**
 * A saved shape as the plan it will be drawn as (simplified, so a bend sitting
 * on its own hole is gone), or why it cannot be one. Shared by the save check,
 * the router and the editor's red preview, so a shape that saves is a shape
 * that lays out. `taken` is takenNodes() of the same doc.
 */
export function shapePlan(w: Wire, path: WirePath, packages: Package[], board: BoardSpec, taken: Taken): { plan: Point[]; why: null } | { plan: null; why: string } {
  const raw = pathToPlan(w, path);
  if (!raw) return { plan: null, why: 'it names a corridor this board does not have' };
  const plan = simplify(raw);
  const why = checkPlan(plan, packages, board, taken);
  return why ? { plan: null, why } : { plan, why: null };
}

/** A plan's bends in grid units, from the hole that sorts first; null when a bend is off the half-pitch grid. */
export function planToPath(w: Wire, plan: Point[]): WirePath | null {
  const points: WirePoint[] = [];
  for (const [x, y] of plan.slice(1, -1)) {
    let g = 0;
    for (let i = 1; i < GAPS.length; i++) if (Math.abs(y - GAPS[i].y) < Math.abs(y - GAPS[g].y)) g = i;
    const lane = Math.round((y - GAPS[g].y) / LANE);
    if (Math.abs(GAPS[g].y + lane * LANE - y) > 0.01 || Math.abs(lane) > 4) return null;
    const half = Math.round((x - X0) / LANE);
    if (Math.abs(X0 + half * LANE - x) > 0.01) return null;
    points.push({ col: 1 + half / 2, gap: GAPS[g].name, lane });
  }
  if (holeKey(w.a) > holeKey(w.b)) points.reverse();
  return { points };
}

/** A binary min-heap of state ids. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      ids[i] = ids[up];
      keys[i] = keys[up];
      i = up;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop()!;
    const key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

const bump = (m: Map<number, number>, k: number, by: number) => {
  const v = (m.get(k) ?? 0) + by;
  if (v) m.set(k, v);
  else m.delete(k);
};

/**
 * The routing lattice and what the wires laid so far use of it. Nodes sit
 * every half pitch both ways: column tracks k (x = X0 + k * LANE, so even k
 * is a column of holes) by lines j (y = Y0 + j * LANE, some of them rows of
 * holes). A wire may lie across an empty hole, never on a leg or on another
 * wire's end.
 */
class Grid {
  readonly kMin = -1;
  readonly kMax: number;
  readonly nk: number;
  readonly hard: Rect[];
  private hug: Rect[];
  /** Nodes where a leg or a jumper end sits. */
  readonly taken = new Set<number>();
  private hUse = new Map<number, number>();
  private vUse = new Map<number, number>();
  private hPass = new Map<number, number>();
  private vPass = new Map<number, number>();
  /** Nodes where a wire turns: another one meeting it there would look joined to it. */
  private bendAt = new Map<number, number>();

  constructor(input: RouteInput) {
    this.kMax = 2 * input.board.cols - 1;
    this.nk = this.kMax - this.kMin + 1;
    this.hard = chipRects(input.packages);
    this.hug = this.hard.map((r) => grow(r, HUG));
    for (const pins of Object.values(input.pinHoles)) for (const h of Object.values(pins)) this.taken.add(this.at(pt(h)));
    for (const w of input.wires) {
      this.taken.add(this.at(pt(w.a)));
      this.taken.add(this.at(pt(w.b)));
    }
  }

  node(k: number, j: number) {
    return j * this.nk + (k - this.kMin);
  }

  /** The node nearest a point in SVG units. */
  at([x, y]: Point) {
    return this.node(Math.round((x - X0) / LANE), Math.round((y - Y0) / LANE));
  }

  x(k: number) {
    return X0 + k * LANE;
  }

  y(j: number) {
    return Y0 + j * LANE;
  }

  /** How many ways out of a hole there are: up the column, down it, or both. */
  exits(p: Point): number {
    const hard = this.hard.filter((r) => !inside(p, r));
    return [-LANE, LANE].filter((d) => {
      const q: Point = [p[0], p[1] + d];
      return q[1] >= Y0 && q[1] <= Y0 + (LINES - 1) * LANE && !this.taken.has(this.at(q)) && !hard.some((r) => crosses(p, q, r));
    }).length;
  }

  /** Record a plan (by = 1) or take it back (by = -1), so later searches pay for sharing its lines or crossing it. */
  claim(plan: Point[], by = 1) {
    for (const p of plan.slice(1, -1)) bump(this.bendAt, this.at(p), by);
    for (let i = 0; i + 1 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      const k1 = Math.round((Math.min(a[0], b[0]) - X0) / LANE);
      const k2 = Math.round((Math.max(a[0], b[0]) - X0) / LANE);
      const j1 = Math.round((Math.min(a[1], b[1]) - Y0) / LANE);
      const j2 = Math.round((Math.max(a[1], b[1]) - Y0) / LANE);
      if (Math.abs(a[1] - b[1]) < 0.01) {
        if (j1 < 0 || j1 >= LINES) continue;
        for (let k = Math.max(k1, this.kMin); k < Math.min(k2, this.kMax); k++) bump(this.hUse, this.node(k, j1), by);
        for (let k = Math.max(k1 + 1, this.kMin); k < Math.min(k2, this.kMax + 1); k++) bump(this.hPass, this.node(k, j1), by);
      } else {
        if (k1 < this.kMin || k1 > this.kMax) continue;
        for (let j = Math.max(j1, 0); j < Math.min(j2, LINES - 1); j++) bump(this.vUse, this.node(k1, j), by);
        for (let j = Math.max(j1 + 1, 0); j < Math.min(j2, LINES); j++) bump(this.vPass, this.node(k1, j), by);
      }
    }
  }

  /** The cheapest plan for one wire, or null when there is none within `cap` expanded states. `dear` scales the cost of sharing. */
  search(w: Wire, cap: number, dear = 1): Point[] | null {
    const pa = pt(w.a);
    const pb = pt(w.b);
    // A body holding one of this wire's own holes cannot bar it: it has to get there.
    const hard = this.hard.filter((r) => !inside(pa, r) && !inside(pb, r));
    const hug = this.hug.filter((r) => !inside(pa, r) && !inside(pb, r));
    const start = this.at(pa);
    const goal = this.at(pb);
    const n = this.nk * LINES * 4;
    const cost = new Float64Array(n).fill(Infinity);
    const bends = new Int32Array(n);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new Heap();
    const h = (k: number, j: number) => Math.abs(this.x(k) - pb[0]) + Math.abs(this.y(j) - pb[1]);
    // Headings: 0 up, 1 down, 2 left, 3 right. A jumper leaves its hole
    // straight up or straight down its column, and arrives the same way.
    for (const dir of [0, 1]) {
      cost[start * 4 + dir] = 0;
      heap.push(start * 4 + dir, Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]));
    }
    let expanded = 0;
    while (heap.size) {
      const s = heap.pop();
      if (closed[s]) continue;
      closed[s] = 1;
      const node = s >> 2;
      const dir = s & 3;
      if (node === goal) return this.unwind(s, from, pa, pb);
      if (++expanded > cap) return null;
      const j = Math.floor(node / this.nk);
      const k = (node % this.nk) + this.kMin;
      const c = cost[s];
      for (let m = 0; m < 4; m++) {
        if (m === (dir ^ 1)) continue;
        // Out of the start hole the only way is straight on.
        if (node === start && m !== dir) continue;
        const k2 = k + (m === 2 ? -1 : m === 3 ? 1 : 0);
        const j2 = j + (m === 0 ? -1 : m === 1 ? 1 : 0);
        if (k2 < this.kMin || k2 > this.kMax || j2 < 0 || j2 >= LINES) continue;
        const t = this.node(k2, j2);
        // Into the end hole only along its column; never onto anyone else's hole.
        if (t === goal ? m >= 2 : this.taken.has(t)) continue;
        const a: Point = [this.x(k), this.y(j)];
        const b: Point = [this.x(k2), this.y(j2)];
        if (hard.some((r) => crosses(a, b, r))) continue;
        let step = LANE;
        if (m >= 2) {
          step += dear * SHARE * (this.hUse.get(this.node(Math.min(k, k2), j)) ?? 0) + CROSS * (this.vPass.get(t) ?? 0);
          if (ROW_YS.has(a[1])) step += ON_HOLES;
        } else {
          step += dear * SHARE_V * (this.vUse.get(this.node(k, Math.min(j, j2))) ?? 0) + CROSS * (this.hPass.get(t) ?? 0);
          // A column of holes is where every jumper into it has to run; keep it for them.
          if (k % 2 === 0) step += ON_HOLES;
        }
        if (hug.some((r) => crosses(a, b, r))) step += NEAR_CHIP;
        if (this.bendAt.has(t)) step += dear * TOUCH;
        const turn = m !== dir;
        if (turn) step += BEND;
        const ts = t * 4 + m;
        const nc = c + step;
        const nb = bends[s] + (turn ? 1 : 0);
        if (!closed[ts] && (nc < cost[ts] || (nc === cost[ts] && nb < bends[ts]))) {
          cost[ts] = nc;
          bends[ts] = nb;
          from[ts] = s;
          // Ties go to the path with fewer bends.
          heap.push(ts, nc + h(k2, j2) + nb / 1000);
        }
      }
    }
    return null;
  }

  /** Walk a search back from the end hole to the start one. */
  private unwind(s: number, from: Int32Array, pa: Point, pb: Point): Point[] {
    const nodes: Point[] = [];
    for (let t = s; t >= 0; t = from[t]) {
      const node = t >> 2;
      nodes.push([this.x((node % this.nk) + this.kMin), this.y(Math.floor(node / this.nk))]);
    }
    nodes.reverse();
    // The two ends are the holes themselves, exactly.
    nodes[0] = [pa[0], pa[1]];
    nodes[nodes.length - 1] = [pb[0], pb[1]];
    return simplify(nodes);
  }
}

// ---------- nudging ----------

export interface Run {
  wire: number;
  /** Index of the run's first point in the wire's plan. */
  seg: number;
  lo: number;
  hi: number;
  /** Which way the run at each end leaves: -1 up (or left), 1 down (or right), 0 straight on or none. */
  loSide: number;
  hiSide: number;
}

/** Where each placed run lies, so a lane can be tested against everything already down. */
class Occupancy {
  private lines = new Map<string, [number, number][]>();
  private key(horizontal: boolean, c: number) {
    return `${horizontal ? 'h' : 'v'}${Math.round(c * 2) / 2}`;
  }
  add(horizontal: boolean, c: number, lo: number, hi: number) {
    const k = this.key(horizontal, c);
    const list = this.lines.get(k) ?? [];
    list.push([lo, hi]);
    this.lines.set(k, list);
  }
  hits(horizontal: boolean, c: number, lo: number, hi: number) {
    return (this.lines.get(this.key(horizontal, c)) ?? []).some(([p, q]) => hi > p + 0.5 && lo < q - 0.5);
  }
  addPlan(plan: Point[]) {
    for (let i = 0; i + 1 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      if (Math.abs(a[1] - b[1]) < 0.01) this.add(true, a[1], Math.min(a[0], b[0]), Math.max(a[0], b[0]));
      else this.add(false, a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1]));
    }
  }
}

const sign = (v: number) => (v > 0.01 ? 1 : v < -0.01 ? -1 : 0);

/** The runs of the given wires, by the line they lie on; the first and last run (into the holes) never move. */
function runsOf(plans: Point[][], wires: number[], horizontal: boolean): Map<number, Run[]> {
  const along = horizontal ? 0 : 1;
  const across = horizontal ? 1 : 0;
  const out = new Map<number, Run[]>();
  for (const w of wires) {
    const plan = plans[w];
    for (let i = 1; i + 2 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      if (Math.abs(a[across] - b[across]) > 0.01) continue;
      const startSide = sign(plan[i - 1][across] - a[across]);
      const endSide = sign(plan[i + 2][across] - b[across]);
      const forward = a[along] <= b[along];
      const run: Run = { wire: w, seg: i, lo: Math.min(a[along], b[along]), hi: Math.max(a[along], b[along]), loSide: forward ? startSide : endSide, hiSide: forward ? endSide : startSide };
      const c = Math.round(a[across] * 2) / 2;
      out.set(c, [...(out.get(c) ?? []), run]);
    }
  }
  return out;
}

const overlap = (a: Run, b: Run) => a.hi > b.lo + 0.5 && a.lo < b.hi - 0.5;

/**
 * Must `i` take a smaller lane (above, or left of) `j` for the two not to
 * cross where one peels off? 1 yes, -1 the other way round, 0 no rule. A run
 * that starts or ends inside the other's span leaves the line there; if it
 * leaves upwards it has to be the upper one, or it would cut across.
 */
export function peelOrder(i: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>, j: Pick<Run, 'lo' | 'hi' | 'loSide' | 'hiSide'>): number {
  let v = 0;
  if (i.lo > j.lo + 0.5 && i.lo < j.hi - 0.5 && i.loSide) v += i.loSide < 0 ? 1 : -1;
  if (i.hi < j.hi - 0.5 && i.hi > j.lo + 0.5 && i.hiSide) v += i.hiSide < 0 ? 1 : -1;
  if (j.lo > i.lo + 0.5 && j.lo < i.hi - 0.5 && j.loSide) v -= j.loSide < 0 ? 1 : -1;
  if (j.hi < i.hi - 0.5 && j.hi > i.lo + 0.5 && j.hiSide) v -= j.hiSide < 0 ? 1 : -1;
  return Math.sign(v);
}

/**
 * Pack the runs on one line into lanes. Each bundle of overlapping runs is
 * ordered by the peel-off rule (a topological sort; a cycle is broken by
 * which way the runs lean), stacked with the left-edge algorithm, centred on
 * the line, and slid sideways as a whole if that is what clears the legs,
 * bodies and fixed wires already there. A bundle that no slide clears is
 * placed a run at a time, each on the free lane nearest the one it wanted, or
 * left where the search put it. Returns run -> lane offset.
 */
export function packLine(runs: Run[], free: (lane: number, run: Run) => boolean): Map<Run, number> {
  const out = new Map<Run, number>();
  const sorted = [...runs].sort((a, b) => a.lo - b.lo || a.wire - b.wire || a.seg - b.seg);
  const bundles: Run[][] = [];
  let reach = -Infinity;
  for (const r of sorted) {
    if (bundles.length && r.lo < reach - 0.5) bundles[bundles.length - 1].push(r);
    else {
      bundles.push([r]);
      reach = -Infinity;
    }
    reach = Math.max(reach, r.hi);
  }
  for (const bundle of bundles) {
    const above = new Map<Run, Set<Run>>(bundle.map((r) => [r, new Set()]));
    for (const a of bundle) for (const b of bundle) if (a !== b && a.wire !== b.wire && overlap(a, b) && peelOrder(a, b) > 0) above.get(b)!.add(a);
    const lean = (r: Run) => r.loSide + r.hiSide;
    const rel = new Map<Run, number>();
    const left = new Set(bundle);
    while (left.size) {
      const ready = [...left].filter((r) => [...above.get(r)!].every((p) => !left.has(p)));
      const pool = ready.length ? ready : [...left];
      pool.sort((a, b) => lean(a) - lean(b) || a.wire - b.wire || a.seg - b.seg);
      const r = pool[0];
      left.delete(r);
      let lane = 0;
      for (const p of above.get(r)!) if (rel.has(p)) lane = Math.max(lane, rel.get(p)! + 1);
      while ([...rel].some(([q, l]) => l === lane && overlap(q, r))) lane++;
      rel.set(r, lane);
    }
    const count = Math.max(...rel.values()) + 1;
    const start = -Math.floor((count - 1) / 2);
    const shift = [0, -1, 1, -2, 2].find((s) => bundle.every((r) => free(start + rel.get(r)! + s, r)));
    if (shift !== undefined) {
      for (const r of bundle) out.set(r, start + rel.get(r)! + shift);
      continue;
    }
    const placed: [Run, number][] = [];
    for (const r of [...bundle].sort((a, b) => rel.get(a)! - rel.get(b)!)) {
      const want = start + rel.get(r)!;
      const lanes = [0, 1, -1, 2, -2, 3, -3, 4, -4].map((d) => want + d).filter((l) => Math.abs(l) <= 4);
      const lane = lanes.find((l) => free(l, r) && !placed.some(([q, ql]) => ql === l && overlap(q, r))) ?? 0;
      placed.push([r, lane]);
      out.set(r, lane);
    }
  }
  return out;
}

/**
 * Slide whole runs of a plan sideways (`moves`: run index -> new line). A run
 * whose neighbour lay on the same line gets a jog to stay joined to it.
 */
function shiftRuns(plan: Point[], moves: Map<number, number>, horizontal: boolean): Point[] {
  const across = horizontal ? 1 : 0;
  const out: Point[] = [];
  for (let i = 0; i + 1 < plan.length; i++) {
    const a: Point = [plan[i][0], plan[i][1]];
    const b: Point = [plan[i + 1][0], plan[i + 1][1]];
    const v = moves.get(i);
    if (v !== undefined) a[across] = b[across] = v;
    if (!out.length || !same(out[out.length - 1], a)) out.push(a);
    out.push(b);
  }
  return simplify(out);
}

/** Split a long run out of a hole after its first half pitch, so the rest of it can be nudged. */
function freeEnds(plan: Point[]): Point[] {
  const p = plan.map((q) => [q[0], q[1]] as Point);
  const step = (from: Point, to: Point): Point => [from[0], from[1] + Math.sign(to[1] - from[1]) * LANE];
  if (p.length >= 2 && Math.abs(p[1][1] - p[0][1]) > LANE + 0.01) p.splice(1, 0, step(p[0], p[1]));
  const n = p.length;
  if (n >= 2 && Math.abs(p[n - 2][1] - p[n - 1][1]) > LANE + 0.01) p.splice(n - 1, 0, step(p[n - 1], p[n - 2]));
  return p;
}

/** Nudge the searched plans of `auto` apart around the `fixed` ones. Returns every wire's plan. */
function nudge(grid: Grid, board: BoardSpec, given: Point[][], fixed: number[], auto: number[]): Point[][] {
  const plans = given.map((p, i) => (auto.includes(i) ? freeEnds(p) : p));
  const width = 2 * X0 + (board.cols - 1) * P;
  for (const horizontal of [true, false]) {
    const occ = new Occupancy();
    for (const i of fixed) occ.addPlan(plans[i]);
    // The runs into the holes cannot move, so they are in the way too.
    for (const i of auto) {
      occ.addPlan(plans[i].slice(0, 2));
      occ.addPlan(plans[i].slice(-2));
    }
    const moves = new Map<number, Map<number, number>>();
    for (const [c, runs] of runsOf(plans, auto, horizontal)) {
      const onGrid = (p: Point) => grid.taken.has(grid.at(p));
      const free = (lane: number, r: Run) => {
        const v = c + lane * LANE;
        if (horizontal ? v < Y0 || v > Y0 + (LINES - 1) * LANE : v < X0 - LANE || v > width - X0 + LANE) return false;
        if (occ.hits(horizontal, v, r.lo, r.hi)) return false;
        const a: Point = horizontal ? [r.lo, v] : [v, r.lo];
        const b: Point = horizontal ? [r.hi, v] : [v, r.hi];
        if (grid.hard.some((rect) => crosses(a, b, rect))) return false;
        // Not along a row (or down a column) of holes where a leg or a jumper end sits.
        for (let t = r.lo; t <= r.hi + 0.01; t += LANE) if (onGrid(horizontal ? [t, v] : [v, t])) return false;
        // The runs at each end stretch to meet the new line: not across a leg or a body either.
        for (const e of [r.lo, r.hi]) {
          const p: Point = horizontal ? [e, c] : [c, e];
          const q: Point = horizontal ? [e, v] : [v, e];
          if (grid.hard.some((rect) => crosses(p, q, rect))) return false;
          for (let t = Math.min(c, v); t <= Math.max(c, v) + 0.01; t += LANE) if (onGrid(horizontal ? [e, t] : [t, e])) return false;
        }
        return true;
      };
      for (const [r, lane] of packLine(runs, free)) {
        const v = c + lane * LANE;
        if (!moves.has(r.wire)) moves.set(r.wire, new Map());
        moves.get(r.wire)!.set(r.seg, v);
        occ.add(horizontal, v, r.lo, r.hi);
      }
    }
    for (const [w, m] of moves) plans[w] = shiftRuns(plans[w], m, horizontal);
  }
  return plans.map((p, i) => (auto.includes(i) ? simplify(p) : p));
}

/**
 * Pairs of wires that would look joined: a run lying along part of another's,
 * or a bend of one lying on the other. Indices into `plans`.
 */
export function clashes(plans: Point[][], wires: number[], nets?: string[]): [number, number][] {
  const onSeg = (p: Point, a: Point, b: Point) => (Math.abs(a[0] - b[0]) < 0.01 ? Math.abs(p[0] - a[0]) < 0.5 && p[1] >= Math.min(a[1], b[1]) - 0.5 && p[1] <= Math.max(a[1], b[1]) + 0.5 : Math.abs(p[1] - a[1]) < 0.5 && p[0] >= Math.min(a[0], b[0]) - 0.5 && p[0] <= Math.max(a[0], b[0]) + 0.5);
  const out: [number, number][] = [];
  for (let x = 0; x < wires.length; x++) {
    for (let y = x + 1; y < wires.length; y++) {
      // Two jumpers of one net meeting are one conductor: nothing is misread.
      if (nets && nets[wires[x]] === nets[wires[y]]) continue;
      const [p, q] = [plans[wires[x]], plans[wires[y]]];
      let hit = false;
      for (let i = 0; i + 1 < p.length && !hit; i++) {
        for (let j = 0; j + 1 < q.length && !hit; j++) {
          const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
          const ah = Math.abs(a[1] - b[1]) < 0.01;
          const ch = Math.abs(c[1] - d[1]) < 0.01;
          if (ah === ch && (ah ? Math.abs(a[1] - c[1]) < 0.5 : Math.abs(a[0] - c[0]) < 0.5)) {
            const [lo1, hi1] = ah ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
            const [lo2, hi2] = ah ? [Math.min(c[0], d[0]), Math.max(c[0], d[0])] : [Math.min(c[1], d[1]), Math.max(c[1], d[1])];
            if (hi1 > lo2 + 1 && lo1 < hi2 - 1) hit = true;
          }
        }
      }
      for (const b of p.slice(1, -1)) for (let j = 0; j + 1 < q.length && !hit; j++) if (onSeg(b, q[j], q[j + 1])) hit = true;
      for (const b of q.slice(1, -1)) for (let i = 0; i + 1 < p.length && !hit; i++) if (onSeg(b, p[i], p[i + 1])) hit = true;
      if (hit) out.push([wires[x], wires[y]]);
    }
  }
  return out;
}

/** Where a horizontal and a vertical segment cross, strictly inside both, or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const ah = Math.abs(a[1] - b[1]) < 0.01;
  const ch = Math.abs(c[1] - d[1]) < 0.01;
  if (ah === ch) return null;
  const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
  const x = v1[0];
  const y = h1[1];
  const inH = x > Math.min(h1[0], h2[0]) + 0.5 && x < Math.max(h1[0], h2[0]) - 0.5;
  const inV = y > Math.min(v1[1], v2[1]) + 0.5 && y < Math.max(v1[1], v2[1]) - 0.5;
  return inH && inV ? [x, y] : null;
}

// ---------- the whole board ----------

/** Every wire's route, in the order of `input.wires`, and what went wrong on the way. Never throws. */
export function routeWires(input: RouteInput, saved: Record<string, WirePath> = {}, opts: { maxExpand?: number } = {}): RouteResult {
  const grid = new Grid(input);
  const cap = opts.maxExpand ?? MAX_EXPAND;
  const warnings: string[] = [];
  const keys = input.wires.map(wireKey);
  const plans: Point[][] = new Array(input.wires.length);
  const routes: WireRoute[] = new Array(input.wires.length);
  /** Wires whose plan is final before nudging: hand-shaped ones, then fallbacks. */
  const fixed: number[] = [];

  // 1. Hand-shaped wires, as saved.
  const taken = takenNodes(input);
  for (const [key, path] of Object.entries(saved)) {
    const i = keys.indexOf(key);
    if (i < 0) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer matches a wire; dropped`);
      continue;
    }
    const { plan, why } = shapePlan(input.wires[i], path, input.packages, input.board, taken);
    if (!plan) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer fits (${why}); re-routed`);
      continue;
    }
    plans[i] = plan;
    routes[i] = { plan: plans[i], lifts: [], locked: true };
    grid.claim(plans[i]);
    fixed.push(i);
  }

  // 2. The rest, shortest first, so short hops keep the lines nearest their holes.
  const span = (w: Wire) => Math.abs(pt(w.a)[0] - pt(w.b)[0]) + Math.abs(pt(w.a)[1] - pt(w.b)[1]);
  const todo = input.wires.map((_, i) => i).filter((i) => !plans[i]).sort((i, j) => span(input.wires[i]) - span(input.wires[j]) || i - j);
  const auto: number[] = [];
  for (const i of todo) {
    const w = input.wires[i];
    const plan = grid.search(w, cap);
    if (plan) {
      plans[i] = plan;
      routes[i] = { plan, lifts: [] };
      auto.push(i);
    } else {
      const warning = `no clean route for the ${w.net} jumper (${holeKey(w.a)}-${holeKey(w.b)}); drawn with the simple router`;
      plans[i] = wirePolylines([w], input.packages, input.board)[0];
      routes[i] = { plan: plans[i], lifts: [], warning };
      warnings.push(warning);
      fixed.push(i);
    }
    grid.claim(plans[i]);
  }

  // 3. Nudge; then rip up whatever still looks joined to a wire of another
  // net, search it again with sharing made dear, and nudge again, a few times.
  let final = nudge(grid, input.board, plans, fixed, auto);
  for (let round = 1; round <= RIP_ROUNDS; round++) {
    const again = new Set(clashes(final, [...fixed, ...auto], input.wires.map((w) => w.net)).flat().filter((i) => auto.includes(i)));
    if (!again.size) break;
    for (const i of again) grid.claim(plans[i], -1);
    // A wire with only one way out of a hole goes first. Then the longest in
    // odd rounds (the short hops in their way have room to move) and the
    // shortest in even ones, in case it was the other way round.
    const exits = (i: number) => Math.min(grid.exits(pt(input.wires[i].a)), grid.exits(pt(input.wires[i].b)));
    const longer = round % 2 ? 1 : -1;
    for (const i of auto.filter((i) => again.has(i)).sort((i, j) => exits(i) - exits(j) || longer * (span(input.wires[j]) - span(input.wires[i])) || i - j)) {
      plans[i] = grid.search(input.wires[i], cap, 10 * round) ?? plans[i];
      grid.claim(plans[i]);
    }
    final = nudge(grid, input.board, plans, fixed, auto);
  }
  for (const i of auto) routes[i].plan = final[i];

  // 4. Humps: of each crossing pair, the wire laid later goes over.
  const layer = [...fixed, ...auto];
  for (let li = 0; li < layer.length; li++) {
    for (let lj = li + 1; lj < layer.length; lj++) {
      const under = routes[layer[li]].plan;
      const over = routes[layer[lj]];
      let before = 0;
      for (let s = 0; s + 1 < over.plan.length; s++) {
        const [a, b] = [over.plan[s], over.plan[s + 1]];
        for (let t = 0; t + 1 < under.length; t++) {
          const hit = crossing(a, b, under[t], under[t + 1]);
          if (hit) over.lifts.push({ at: before + Math.abs(hit[0] - a[0]) + Math.abs(hit[1] - a[1]), height: WIRE_D });
        }
        before += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      }
    }
  }
  for (const r of routes) r.lifts.sort((p, q) => p.at - q.at);
  return { routes, warnings };
}
