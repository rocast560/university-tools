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
/** Expanded states before a search gives up and the simple router takes over, so a drag never stalls. */
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

/** Drop repeated points and points in the middle of a straight run; the two ends always stay. */
export function simplify(plan: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of plan) {
    if (out.length && same(out[out.length - 1], p)) continue;
    if (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]];
      const straight = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01);
      if (straight) out.pop();
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Length along a square-cornered plan. */
export const planLength = (plan: Point[]) => plan.reduce((s, p, i) => (i ? s + Math.abs(p[0] - plan[i - 1][0]) + Math.abs(p[1] - plan[i - 1][1]) : 0), 0);

/**
 * Why a plan cannot be a jumper on this board, or null when it can: square
 * corners only, straight out of each hole along its column, on the board,
 * and never through a package body (other than one holding its own end).
 */
export function checkPlan(plan: Point[], packages: Package[], board: BoardSpec): string | null {
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

/** A plan's bends in grid units, from the hole that sorts first; null when a bend is off the half-pitch grid. */
export function planToPath(w: Wire, plan: Point[]): WirePath | null {
  const points: WirePoint[] = [];
  for (const [x, y] of plan.slice(1, -1)) {
    let g = 0;
    for (let i = 1; i < GAPS.length; i++) if (Math.abs(y - GAPS[i].y) < Math.abs(y - GAPS[g].y)) g = i;
    const lane = Math.round((y - GAPS[g].y) / LANE);
    if (Math.abs(GAPS[g].y + lane * LANE - y) > 0.01 || Math.abs(lane) > 4) return null;
    points.push({ col: Math.round(((x - X0) / P + 1) * 1e6) / 1e6, gap: GAPS[g].name, lane });
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
        if (nc < cost[ts] || (nc === cost[ts] && nb < bends[ts])) {
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
  for (const [key, path] of Object.entries(saved)) {
    const i = keys.indexOf(key);
    if (i < 0) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer matches a wire; dropped`);
      continue;
    }
    const plan = pathToPlan(input.wires[i], path);
    const why = plan ? checkPlan(plan, input.packages, input.board) : 'it names a corridor this board does not have';
    if (!plan || why) {
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer fits (${why}); re-routed`);
      continue;
    }
    plans[i] = simplify(plan);
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
