// Square-cornered jumpers that lie flat on the board, the way a carefully
// hand-wired breadboard looks: cut to length, flush on the plastic, bent
// tight, bundled in parallel lanes, and never run over a chip.
//
// Four passes, after libavoid's route-then-nudge (Wybrow, Marriott and
// Stuckey 2009):
//   1. Hand-shaped wires first. A saved path whose end holes still match a
//      wire is used as it is and holds its lines; one that matches no wire is
//      set aside (kept in the sidecar) with a warning naming its net.
//   2. Every other wire, shortest first, is found by A* over a lattice with a
//      node every half pitch, the heading in the state so that a bend can
//      cost something. Without a bend penalty the cheapest paths staircase.
//   3. Nudging. Runs that ended up on the same line are packed into parallel
//      lanes with the left-edge algorithm, ordered so a bundle does not cross
//      itself where its wires peel off. Wires still sharing a line after that
//      are ripped up and searched again with sharing made dear, a few rounds.
//   4. Where two wires still cross, the one laid later humps over, clear of
//      any hump the lower one is making there.
//
// Pure: a function of the wires, the packages, the legs and the saved paths,
// so the flat board and the 3D board draw the same wires. The old corridor
// router in ortho.ts is the fallback when a search gives up.

import { holeKey } from '../layout/board.ts';
import type { BoardSpec, Hole, Package, Row, Wire, WirePath, WirePoint } from '../layout/types.ts';
import { HEIGHT, P, placeAt, pt, ROWY, tierCols, tierCount, tierOf, TIER_PITCH, X0 } from './geometry.ts';
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
  /** Ends of other jumpers on this board that are not among `wires` (on a stacked board, the wires joining two boards): never lain over either. */
  ends?: Hole[];
}

/** The jacket's radius: 0.56 mm, so 1.1 mm across, like 22 AWG solid-core wire. */
export const WIRE_R = 4;
export const WIRE_D = 2 * WIRE_R;
/** Bend radius along the board, about one wire diameter as a real jumper is bent. */
export const BEND_R = 4;
/** Bend radius where the wire comes up out of its hole: a little tighter. */
export const STUB_R = 3;
/** Air between a hump and the wire under it, so the two tubes do not just touch. */
export const AIR_Z = 1;
/** Centre to centre, a hump and the wire under it: a diameter and the air. */
const CLEAR = WIRE_D + AIR_Z;
/** Half the length of a hump one wire diameter high: about two pitches in all. */
export const HUMP = P;
/** Half the level top of a hump. */
const TOP_HALF = HUMP / 3;
/**
 * Ramp gradient, the same for every hump: one diameter over the outer two
 * thirds of HUMP, about 34 degrees. A taller hump (over a wire that is itself
 * humping) is longer rather than steeper, so its ramps stay under the tube's
 * 45 degree fillet threshold and cost no extra rings.
 */
const SLOPE = WIRE_D / (HUMP - TOP_HALF);

/**
 * How far a wire is raised off the board `s` along its plan: the highest of
 * its humps there. A hump is a trapezoid, level for TOP_HALF either side of
 * its lift and ramping down at SLOPE. Here rather than in the tube code so the
 * router can stack a hump on the one beneath it with the very shape the tube
 * is drawn with.
 */
export function rise(lifts: Lift[], s: number): number {
  return lifts.reduce((h, l) => Math.max(h, Math.min(l.height, SLOPE * (TOP_HALF + l.height / SLOPE - Math.abs(s - l.at)))), 0);
}

/**
 * Every distance along the plan where rise() changes slope: each hump's four
 * corners, and where one hump's ramp meets another's ramp or top. Sampled at
 * all of these, a line drawn straight between samples is rise() exactly; with
 * the corners alone it would cut above the valley between two overlapping
 * humps, and a wire humping over that valley would sink into it.
 */
export function riseBreaks(lifts: Lift[]): number[] {
  // Each hump as three pieces, f(s) = m * s + c on [lo, hi].
  const pieces = lifts.map((l) => {
    const foot = TOP_HALF + l.height / SLOPE;
    return [
      { lo: l.at - foot, hi: l.at - TOP_HALF, m: SLOPE, c: -SLOPE * (l.at - foot) },
      { lo: l.at - TOP_HALF, hi: l.at + TOP_HALF, m: 0, c: l.height },
      { lo: l.at + TOP_HALF, hi: l.at + foot, m: -SLOPE, c: SLOPE * (l.at + foot) },
    ];
  });
  const out: number[] = [];
  for (const [up, top, down] of pieces) out.push(up.lo, top.lo, top.hi, down.hi);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      for (const p of pieces[i]) {
        for (const q of pieces[j]) {
          if (p.m === q.m) continue;
          const s = (q.c - p.c) / (p.m - q.m);
          if (s > Math.max(p.lo, q.lo) && s < Math.min(p.hi, q.hi)) out.push(s);
        }
      }
    }
  }
  return out;
}
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
/** A joining wire's cost per bend, about 22 pitches: it takes a few long straight runs (a Z dropping through the gap between the boards) over a shorter winding path. */
const JOIN_BEND = 400;
/** Times the joining wires are laid again with the ones that had to wind first; kept only when that is better. */
const JOIN_ROUNDS = 3;
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

/**
 * The corridor between one stacked board and the next, measured on the upper
 * board like GAPS: centred between that board's bottom corridor and the
 * lower board's top one, with SEAM_LANES lanes either side of the centre that
 * stay a lane clear of both. A wire passes from one board to the next only
 * through here, so it never lies along either board's rails.
 */
export const SEAM: Gap = { name: 'seam', y: (GAPS[GAPS.length - 1].y + TIER_PITCH + Y0) / 2 };
export const SEAM_LANES = Math.floor((SEAM.y - GAPS[GAPS.length - 1].y - LANE) / LANE);

/** A lattice line: its drawn y, and whether it runs along a row of holes. */
interface Line {
  y: number;
  row: boolean;
}

const LATTICE = new Map<number, Line[]>();
/**
 * Every line of the lattice, top to bottom, in drawn y: each board's lines
 * and, between two stacked boards, the seam's lanes. One board's lines are a
 * half pitch apart; the seam's are too, but sit off that grid (the boards are
 * TIER_PITCH apart, not a whole number of lanes).
 */
export function latticeLines(board?: BoardSpec): Line[] {
  const tiers = board ? tierCount(board) : 1;
  let out = LATTICE.get(tiers);
  if (out) return out;
  out = [];
  for (let t = 0; t < tiers; t++) {
    for (let j = 0; j < LINES; j++) out.push({ y: Y0 + j * LANE + t * TIER_PITCH, row: ROW_YS.has(Y0 + j * LANE) });
    if (t + 1 < tiers) for (let l = -SEAM_LANES; l <= SEAM_LANES; l++) out.push({ y: SEAM.y + l * LANE + t * TIER_PITCH, row: false });
  }
  LATTICE.set(tiers, out);
  return out;
}

/** The lattice lines from y1 to y2, ends included, in drawn y. */
const linesBetween = (lines: Line[], y1: number, y2: number) => lines.filter((l) => l.y >= Math.min(y1, y2) - 0.01 && l.y <= Math.max(y1, y2) + 0.01).map((l) => l.y);

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
export function chipRects(packages: Package[], board: BoardSpec): Rect[] {
  return packageRects(packages, board).map((r, i) => ({ x1: r.x1 - AIR, y1: r.y1 - AIR, x2: r.x2 + AIR, y2: r.y2 + AIR, id: packages[i].id }));
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

/** A point's lattice node as "k,j" (half pitches from X0 and Y0, on the top board) or "t:k,j" on stacked board t; null off the lattice. */
export function nodeKey([x, y]: Point): string | null {
  const t = Math.max(0, Math.floor((y + (TIER_PITCH - HEIGHT) / 2) / TIER_PITCH));
  const yl = y - t * TIER_PITCH;
  const k = Math.round((x - X0) / LANE);
  const j = Math.round((yl - Y0) / LANE);
  if (Math.abs(X0 + k * LANE - x) >= 0.01 || Math.abs(Y0 + j * LANE - yl) >= 0.01) return null;
  return t ? `${t}:${k},${j}` : `${k},${j}`;
}

/** Every leg and every jumper end on the board, for checkPlan and shapePlan. */
export function takenNodes(input: Pick<RouteInput, 'pinHoles' | 'wires' | 'ends'> & { board?: BoardSpec }): Taken {
  const out: Taken = new Map();
  const at = (h: Hole) => (input.board ? placeAt(input.board, h) : pt(h));
  for (const h of [...input.wires.flatMap((w) => [w.a, w.b]), ...(input.ends ?? [])]) {
    const k = nodeKey(at(h));
    if (k) out.set(k, `another jumper's end at ${holeKey(h)}`);
  }
  // Legs last, so a hole holding both is named for the leg.
  for (const pins of Object.values(input.pinHoles)) for (const h of Object.values(pins)) {
    const k = nodeKey(at(h));
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
  const width = 2 * X0 + (tierCols(board) - 1) * P;
  const height = HEIGHT + (tierCount(board) - 1) * TIER_PITCH;
  if (plan.some(([x, y]) => x < WIRE_R || x > width - WIRE_R || y < WIRE_R || y > height - WIRE_R)) return 'the path leaves the board';
  const ends = [plan[0], plan[n - 1]];
  for (const r of chipRects(packages, board)) {
    if (ends.some((e) => inside(e, r))) continue;
    for (let i = 0; i + 1 < n; i++) if (crosses(plan[i], plan[i + 1], r)) return `the path runs through ${r.id}`;
  }
  if (taken?.size) {
    const own = new Set([nodeKey(plan[0]), nodeKey(plan[n - 1])]);
    // Every lattice node along every run, bends included: a run stretched
    // along a strip would otherwise lie on the legs standing in it. Down the
    // board, the lattice's own lines: across a seam they are off the half-pitch grid.
    const lines = latticeLines(board);
    for (let i = 0; i + 1 < n; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      const nodes: Point[] = [];
      if (Math.abs(a[1] - b[1]) < 0.01) {
        const steps = Math.round(Math.abs(b[0] - a[0]) / LANE);
        for (let t = 0; t <= steps; t++) nodes.push([a[0] + t * Math.sign(b[0] - a[0]) * LANE, a[1]]);
      } else for (const y of linesBetween(lines, a[1], b[1])) nodes.push([a[0], y]);
      for (const p of nodes) {
        const k = nodeKey(p);
        const what = k && !own.has(k) ? taken.get(k) : undefined;
        if (what) return `the path runs over ${what}`;
      }
    }
  }
  return null;
}

/** The board both ends of `w` sit on, or null when it joins two stacked boards. */
function tierOfWire(w: Wire, board: BoardSpec): number | null {
  const t = tierOf(board, w.a.col);
  return tierOf(board, w.b.col) === t ? t : null;
}

/** `w` as it reads on board `t` alone: columns from 1 on that board. */
function localWire(w: Wire, board: BoardSpec, t: number): Wire {
  const lo = t * tierCols(board);
  return { ...w, a: { ...w.a, col: w.a.col - lo }, b: { ...w.b, col: w.b.col - lo } };
}
/**
 * A saved shape moved by `dc` columns. Its bends run from the hole that sorts
 * first, and renumbering columns can change which that is ("a70" before "a80",
 * "a17" after "a7"), so they are turned round when the order differs.
 */
function shiftPath(path: WirePath, dc: number, w: Wire, board: BoardSpec, t: number): WirePath {
  const points = path.points.map((p) => ({ ...p, col: p.col + dc }));
  const lw = localWire(w, board, t);
  return { points: holeKey(w.a) > holeKey(w.b) === holeKey(lw.a) > holeKey(lw.b) ? points : points.reverse() };
}
const shiftPlan = (plan: Point[], dy: number): Point[] => plan.map(([x, y]) => [x, y + dy]);

/** A saved shape turned into a plan from `w.a` to `w.b`, or null when it names a corridor this board lacks. */
export function pathToPlan(w: Wire, path: WirePath, board?: BoardSpec): Point[] | null {
  if (board && tierCount(board) > 1) {
    const t = tierOfWire(w, board);
    if (t === null) return null;
    const plan = pathToPlan(localWire(w, board, t), shiftPath(path, -t * tierCols(board), w, board, t));
    return plan && shiftPlan(plan, t * TIER_PITCH);
  }
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
  const raw = pathToPlan(w, path, board);
  if (!raw) return { plan: null, why: 'it names a corridor this board does not have' };
  const plan = simplify(raw);
  const why = checkPlan(plan, packages, board, taken);
  return why ? { plan: null, why } : { plan, why: null };
}

/** A plan's bends in grid units, from the hole that sorts first; null when a bend is off the half-pitch grid. */
export function planToPath(w: Wire, plan: Point[], board?: BoardSpec): WirePath | null {
  if (board && tierCount(board) > 1) {
    const t = tierOfWire(w, board);
    if (t === null) return null;
    const path = planToPath(localWire(w, board, t), shiftPlan(plan, -t * TIER_PITCH));
    return path && shiftPath(path, t * tierCols(board), w, board, t);
  }
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

/**
 * The routing lattice and what the wires laid so far use of it. Nodes sit
 * every half pitch both ways: column tracks k (x = X0 + k * LANE, so even k
 * is a column of holes) by lines j (latticeLines: on one board y = Y0 + j *
 * LANE, some of them rows of holes). On a stacked board it is one lattice
 * of the whole stack: each board's lines, drawn where the board is, with the
 * seam's lanes between them, which the wires joining two boards are searched
 * on (routeStacked). A wire may lie across an empty hole, never on a leg or
 * on another wire's end.
 */
class Grid {
  readonly kMin = -1;
  readonly kMax: number;
  readonly nk: number;
  readonly lines: Line[];
  readonly nj: number;
  readonly hard: Rect[];
  private hug: Rect[];
  readonly place: (h: Hole) => Point;
  /** Nodes where a leg or a jumper end sits. */
  readonly taken = new Set<number>();
  /** By node: wires along the line from it to the next node right (hUse) or down (vUse), and through it across (hPass, vPass). */
  private hUse: Int32Array;
  private vUse: Int32Array;
  private hPass: Int32Array;
  private vPass: Int32Array;
  /** Nodes where a wire turns: another one meeting it there would look joined to it. */
  private bendAt: Int32Array;
  /** By node: how many bodies (hard) and body margins (hug) the step to the next node right, or down, passes through. */
  private hardRight: Uint8Array;
  private hardDown: Uint8Array;
  private hugRight: Uint8Array;
  private hugDown: Uint8Array;

  constructor(input: RouteInput) {
    this.kMax = 2 * tierCols(input.board) - 1;
    this.nk = this.kMax - this.kMin + 1;
    this.lines = latticeLines(input.board);
    this.nj = this.lines.length;
    this.hard = chipRects(input.packages, input.board);
    this.hug = this.hard.map((r) => grow(r, HUG));
    this.place = (h) => placeAt(input.board, h);
    const nn = this.nk * this.nj;
    [this.hUse, this.vUse, this.hPass, this.vPass, this.bendAt] = [0, 0, 0, 0, 0].map(() => new Int32Array(nn));
    [this.hardRight, this.hardDown, this.hugRight, this.hugDown] = [0, 0, 0, 0].map(() => new Uint8Array(nn));
    // Each body marks only the steps near it.
    const mark = (rects: Rect[], right: Uint8Array, down: Uint8Array) => {
      for (const r of rects) {
        const k1 = Math.max(this.kMin, Math.floor((r.x1 - X0) / LANE) - 1);
        const k2 = Math.min(this.kMax, Math.ceil((r.x2 - X0) / LANE) + 1);
        const j1 = Math.max(0, this.line(r.y1) - 1);
        const j2 = Math.min(this.nj - 1, this.line(r.y2) + 1);
        for (let j = j1; j <= j2; j++) {
          for (let k = k1; k <= k2; k++) {
            const a: Point = [this.x(k), this.y(j)];
            if (k < this.kMax && crosses(a, [this.x(k + 1), a[1]], r)) right[this.node(k, j)]++;
            if (j + 1 < this.nj && crosses(a, [a[0], this.y(j + 1)], r)) down[this.node(k, j)]++;
          }
        }
      }
    };
    mark(this.hard, this.hardRight, this.hardDown);
    mark(this.hug, this.hugRight, this.hugDown);
    for (const pins of Object.values(input.pinHoles)) for (const h of Object.values(pins)) this.taken.add(this.at(this.place(h)));
    for (const h of [...input.wires.flatMap((w) => [w.a, w.b]), ...(input.ends ?? [])]) this.taken.add(this.at(this.place(h)));
  }

  node(k: number, j: number) {
    return j * this.nk + (k - this.kMin);
  }

  /** The line nearest a drawn y. */
  line(y: number): number {
    const { lines } = this;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].y < y) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && y - lines[lo - 1].y < lines[lo].y - y ? lo - 1 : lo;
  }

  /** Whether a drawn y is one of the lattice's lines. */
  onLine(y: number): boolean {
    return Math.abs(this.lines[this.line(y)].y - y) < 0.01;
  }

  /** The node nearest a point in SVG units. */
  at([x, y]: Point) {
    return this.node(Math.round((x - X0) / LANE), this.line(y));
  }

  x(k: number) {
    return X0 + k * LANE;
  }

  y(j: number) {
    return this.lines[j].y;
  }

  /** How many ways out of a hole there are: up the column, down it, or both. */
  exits(p: Point): number {
    const hard = this.hard.filter((r) => !inside(p, r));
    const j = this.line(p[1]);
    return [j - 1, j + 1].filter((j2) => {
      if (j2 < 0 || j2 >= this.nj) return false;
      const q: Point = [p[0], this.y(j2)];
      return !this.taken.has(this.at(q)) && !hard.some((r) => crosses(p, q, r));
    }).length;
  }

  /** Record a plan (by = 1) or take it back (by = -1), so later searches pay for sharing its lines or crossing it. */
  claim(plan: Point[], by = 1) {
    for (const p of plan.slice(1, -1)) this.bendAt[this.at(p)] += by;
    for (let i = 0; i + 1 < plan.length; i++) {
      const [a, b] = [plan[i], plan[i + 1]];
      const k1 = Math.round((Math.min(a[0], b[0]) - X0) / LANE);
      const k2 = Math.round((Math.max(a[0], b[0]) - X0) / LANE);
      const j1 = this.line(Math.min(a[1], b[1]));
      const j2 = this.line(Math.max(a[1], b[1]));
      if (Math.abs(a[1] - b[1]) < 0.01) {
        // A fallback plan's run off the lattice's ends lies on no line.
        if (Math.abs(this.y(j1) - a[1]) > LANE / 2) continue;
        for (let k = Math.max(k1, this.kMin); k < Math.min(k2, this.kMax); k++) this.hUse[this.node(k, j1)] += by;
        for (let k = Math.max(k1 + 1, this.kMin); k < Math.min(k2, this.kMax + 1); k++) this.hPass[this.node(k, j1)] += by;
      } else {
        if (k1 < this.kMin || k1 > this.kMax) continue;
        for (let j = j1; j < j2; j++) this.vUse[this.node(k1, j)] += by;
        for (let j = j1 + 1; j < j2; j++) this.vPass[this.node(k1, j)] += by;
      }
    }
  }

  /** The cheapest plan for one wire, or null when there is none within `cap` expanded states. `dear` scales the cost of sharing. */
  search(w: Wire, cap: number, dear = 1): Point[] | null {
    return this.searchAt(this.place(w.a), this.place(w.b), cap, dear);
  }

  /** The same between two lattice points: a hole, or where a wire leaves the board along a column. */
  searchAt(pa: Point, pb: Point, cap: number, dear = 1, apart?: { bend: number }): Point[] | null {
    // `apart`: never along a line another wire lies on, and `bend` for each bend.
    const bendCost = apart?.bend ?? BEND;
    // A body holding one of this wire's own holes cannot bar it: it has to get there.
    const ownHard = this.hard.filter((r) => inside(pa, r) || inside(pb, r));
    const ownHug = this.hug.filter((r) => inside(pa, r) || inside(pb, r));
    const { hardRight, hardDown, hugRight, hugDown, hUse, vUse, hPass, vPass, bendAt } = this;
    /** How many of the bodies (or margins) counted on a step are not this wire's own. */
    const others = (count: number, own: Rect[], a: Point, b: Point) => (count && own.length ? count - own.filter((r) => crosses(a, b, r)).length : count);
    const blocked = new Uint8Array(this.nk * this.nj);
    for (const t of this.taken) blocked[t] = 1;
    const start = this.at(pa);
    const goal = this.at(pb);
    const n = this.nk * this.nj * 4;
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
        if (k2 < this.kMin || k2 > this.kMax || j2 < 0 || j2 >= this.nj) continue;
        const t = this.node(k2, j2);
        // Into the end hole only along its column; never onto anyone else's hole.
        if (t === goal ? m >= 2 : blocked[t]) continue;
        // The step, by the node it leaves rightward or downward from.
        const e = m >= 2 ? this.node(Math.min(k, k2), j) : this.node(k, Math.min(j, j2));
        const hardN = m >= 2 ? hardRight[e] : hardDown[e];
        const hugN = m >= 2 ? hugRight[e] : hugDown[e];
        // Only a step beside a body needs its ends, to tell this wire's own body from the rest.
        const a: Point | null = hardN || hugN ? [this.x(k), this.y(j)] : null;
        const b: Point | null = a && [this.x(k2), this.y(j2)];
        if (hardN && others(hardN, ownHard, a!, b!) > 0) continue;
        if (apart && (m >= 2 ? hUse[e] : vUse[e])) continue;
        let step: number;
        if (m >= 2) {
          step = LANE + dear * SHARE * hUse[e] + CROSS * vPass[t];
          if (this.lines[j].row) step += ON_HOLES;
        } else {
          // Lines are a lane apart on a board, a little more either side of a seam.
          step = Math.abs(this.lines[j2].y - this.lines[j].y) + dear * SHARE_V * vUse[e] + CROSS * hPass[t];
          // A column of holes is where every jumper into it has to run; keep it for them.
          if (k % 2 === 0) step += ON_HOLES;
        }
        if (hugN && others(hugN, ownHug, a!, b!) > 0) step += NEAR_CHIP;
        if (bendAt[t]) step += dear * TOUCH;
        const turn = m !== dir;
        if (turn) step += bendCost;
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
  const width = 2 * X0 + (tierCols(board) - 1) * P;
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
        // Across the board, only onto a lattice line (round a seam they are off the half-pitch grid).
        if (horizontal ? !grid.onLine(v) : v < X0 - LANE || v > width - X0 + LANE) return false;
        if (occ.hits(horizontal, v, r.lo, r.hi)) return false;
        const a: Point = horizontal ? [r.lo, v] : [v, r.lo];
        const b: Point = horizontal ? [r.hi, v] : [v, r.hi];
        if (grid.hard.some((rect) => crosses(a, b, rect))) return false;
        // Not along a row (or down a column) of holes where a leg or a jumper end sits.
        if (horizontal) {
          for (let t = r.lo; t <= r.hi + 0.01; t += LANE) if (onGrid([t, v])) return false;
        } else for (const t of linesBetween(grid.lines, r.lo, r.hi)) if (onGrid([v, t])) return false;
        // The runs at each end stretch to meet the new line: not across a leg or a body either.
        for (const e of [r.lo, r.hi]) {
          const p: Point = horizontal ? [e, c] : [c, e];
          const q: Point = horizontal ? [e, v] : [v, e];
          if (grid.hard.some((rect) => crosses(p, q, rect))) return false;
          if (horizontal) {
            for (const t of linesBetween(grid.lines, c, v)) if (onGrid([e, t])) return false;
          } else for (let t = Math.min(c, v); t <= Math.max(c, v) + 0.01; t += LANE) if (onGrid([t, e])) return false;
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
 * or a bend of one lying on the other. Indices into `plans`. Given `nets`,
 * two wires of one net are one conductor, so nothing is misread, and they do
 * not count; unless `sameNetBends`, when a bend of one on the other still
 * does, because there the two tubes collide (the router rips those up too).
 */
export function clashes(plans: Point[][], wires: number[], nets?: string[], sameNetBends = false): [number, number][] {
  const onSeg = (p: Point, a: Point, b: Point) => (Math.abs(a[0] - b[0]) < 0.01 ? Math.abs(p[0] - a[0]) < 0.5 && p[1] >= Math.min(a[1], b[1]) - 0.5 && p[1] <= Math.max(a[1], b[1]) + 0.5 : Math.abs(p[1] - a[1]) < 0.5 && p[0] >= Math.min(a[0], b[0]) - 0.5 && p[0] <= Math.max(a[0], b[0]) + 0.5);
  const out: [number, number][] = [];
  for (let x = 0; x < wires.length; x++) {
    for (let y = x + 1; y < wires.length; y++) {
      const sameNet = !!nets && nets[wires[x]] === nets[wires[y]];
      if (sameNet && !sameNetBends) continue;
      const [p, q] = [plans[wires[x]], plans[wires[y]]];
      let hit = false;
      for (let i = 0; i + 1 < p.length && !hit && !sameNet; i++) {
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

/**
 * Where two square-cornered segments meet: the point where they cross or
 * where a bend of one sits on the other, or, when they lie along one line,
 * points along the stretch they share, close enough that humps at them make
 * one level top. Empty when they are apart.
 */
export function contacts(a: Point, b: Point, c: Point, d: Point): Point[] {
  const ah = Math.abs(a[1] - b[1]) < 0.01;
  const ch = Math.abs(c[1] - d[1]) < 0.01;
  const within = (v: number, p: number, q: number) => v >= Math.min(p, q) - 0.01 && v <= Math.max(p, q) + 0.01;
  if (ah !== ch) {
    const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
    const [x, y] = [v1[0], h1[1]];
    return within(x, h1[0], h2[0]) && within(y, v1[1], v2[1]) ? [[x, y]] : [];
  }
  const [along, across] = ah ? [0, 1] : [1, 0];
  if (Math.abs(a[across] - c[across]) > 0.01) return [];
  const lo = Math.max(Math.min(a[along], b[along]), Math.min(c[along], d[along]));
  const hi = Math.min(Math.max(a[along], b[along]), Math.max(c[along], d[along]));
  if (hi < lo - 0.01) return [];
  const n = Math.ceil((hi - lo) / (2 * TOP_HALF) - 1e-9);
  const out: Point[] = [];
  for (let k = 0; k <= n; k++) {
    const v = n ? lo + ((hi - lo) * k) / n : lo;
    out.push(ah ? [v, a[1]] : [a[0], v]);
  }
  return out;
}

/** Distance along a plan to each of its corners. */
const corners = (plan: Point[]) => plan.reduce<number[]>((out, p, i) => (out.push(i ? out[i - 1] + Math.abs(p[0] - plan[i - 1][0]) + Math.abs(p[1] - plan[i - 1][1]) : 0), out), []);

/**
 * How high a hump at distance `su` along the lower wire must be for its level
 * top, meeting it there, to stay CLEAR of every point of the lower wire.
 * Crossing it, the top is over the lower wire at `su` alone, and the point
 * `d` along the lower wire is `d` away sideways, so it needs only
 * sqrt(CLEAR^2 - d^2) above it. Lying along it (`along`), the top is over the
 * lower wire for TOP_HALF either side of `su`, so it needs CLEAR above every
 * point there and the circle beyond. The highest of rise() plus that, over
 * the window it reaches. rise() is straight between its breaks with slope 0
 * or +-SLOPE, and the sum is concave on each straight piece, so its highest
 * point is at a window end, a break, an end of the level stretch, or where
 * the circle's slope matches the piece's (d = m * CLEAR / sqrt(1 + m^2)):
 * exact, not sampled.
 */
function hopHeight(lifts: Lift[], su: number, length: number, along = false): number {
  const w = along ? TOP_HALF : 0;
  const lo = Math.max(0, su - w - CLEAR);
  const hi = Math.min(length, su + w + CLEAR);
  const t = (SLOPE * CLEAR) / Math.sqrt(1 + SLOPE * SLOPE);
  const at = [lo, hi, su, su - w, su + w, su - w - t, su - w + t, su + w - t, su + w + t, ...riseBreaks(lifts)].filter((u) => u >= lo && u <= hi);
  const off = (u: number) => Math.max(0, Math.abs(u - su) - w);
  return Math.max(CLEAR, ...at.map((u) => rise(lifts, u) + Math.sqrt(Math.max(0, CLEAR * CLEAR - off(u) ** 2))));
}

/**
 * Humps: wherever two wires meet (cross, a bend of one on the other, or a
 * stretch shared along one line), the one later in `order` goes over,
 * CLEAR of the lower wire all round (hopHeight), not only straight below it
 * where they meet: just past the meeting the lower one may be ramping up to a
 * hump of its own. The lower one may itself be
 * humping over a third wire; its lifts are all in by now, because every wire
 * beneath it in the order was paired with it on an earlier pass. Adds to
 * each route's lifts, sorted.
 */
export function liftCrossings(routes: WireRoute[], order: number[]): void {
  for (let li = 0; li < order.length; li++) {
    const under = routes[order[li]];
    const along = corners(under.plan);
    const length = along[along.length - 1];
    for (let lj = li + 1; lj < order.length; lj++) {
      const over = routes[order[lj]];
      const ends = [over.plan[0], over.plan[over.plan.length - 1]];
      const found = new Map<number, number>();
      let before = 0;
      for (let s = 0; s + 1 < over.plan.length; s++) {
        const [a, b] = [over.plan[s], over.plan[s + 1]];
        for (let t = 0; t + 1 < under.plan.length; t++) {
          for (const hit of contacts(a, b, under.plan[t], under.plan[t + 1])) {
            // Its own hole: it goes down into that, not over anything.
            if (ends.some((e) => same(e, hit))) continue;
            const su = along[t] + Math.abs(hit[0] - under.plan[t][0]) + Math.abs(hit[1] - under.plan[t][1]);
            // Two runs along one line: the hump's whole level top is over the lower wire.
            const collinear = (Math.abs(a[1] - b[1]) < 0.01) === (Math.abs(under.plan[t][1] - under.plan[t + 1][1]) < 0.01);
            const height = hopHeight(under.lifts, su, length, collinear);
            // A meeting at a corner is found on both runs either side of it: one hump will do.
            const at = Math.round((before + Math.abs(hit[0] - a[0]) + Math.abs(hit[1] - a[1])) * 100) / 100;
            found.set(at, Math.max(found.get(at) ?? 0, height));
          }
        }
        before += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      }
      for (const [at, height] of found) over.lifts.push({ at, height });
    }
  }
  for (const r of routes) r.lifts.sort((p, q) => p.at - q.at);
}

// ---------- the whole board ----------

/** Every wire's route, in the order of `input.wires`, and what went wrong on the way. Never throws. */
export function routeWires(input: RouteInput, saved: Record<string, WirePath> = {}, opts: { maxExpand?: number } = {}): RouteResult {
  if (tierCount(input.board) > 1) return routeStacked(input, saved, opts);
  const { routes, warnings, order } = routeBoard(input, saved, opts);
  // 4. Humps, laid in the order the wires went down.
  liftCrossings(routes, order);
  return { routes, warnings };
}

/** Passes 1 to 3 on one board: every wire's plan, no humps yet, and the order the wires went down in. */
function routeBoard(input: RouteInput, saved: Record<string, WirePath>, opts: { maxExpand?: number }): RouteResult & { order: number[] } {
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
      // Left in the sidecar, not deleted: a part moved away and back again gets its shape back.
      warnings.push(`hand-shaped jumper for ${keyNet(key)} (${keyHoles(key)}) no longer matches a wire; kept in case the part moves back. 'Tidy all wires' forgets it`);
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
  const span = (w: Wire) => {
    const [a, b] = [grid.place(w.a), grid.place(w.b)];
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  };
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
  // net, or turns on one of its own, search it again with sharing made dear, and nudge again, a few times.
  let final = nudge(grid, input.board, plans, fixed, auto);
  for (let round = 1; round <= RIP_ROUNDS; round++) {
    const again = new Set(clashes(final, [...fixed, ...auto], input.wires.map((w) => w.net), true).flat().filter((i) => auto.includes(i)));
    if (!again.size) break;
    for (const i of again) grid.claim(plans[i], -1);
    // A wire with only one way out of a hole goes first. Then the longest in
    // odd rounds (the short hops in their way have room to move) and the
    // shortest in even ones, in case it was the other way round.
    const exits = (i: number) => Math.min(grid.exits(grid.place(input.wires[i].a)), grid.exits(grid.place(input.wires[i].b)));
    const longer = round % 2 ? 1 : -1;
    for (const i of auto.filter((i) => again.has(i)).sort((i, j) => exits(i) - exits(j) || longer * (span(input.wires[j]) - span(input.wires[i])) || i - j)) {
      plans[i] = grid.search(input.wires[i], cap, 10 * round) ?? plans[i];
      grid.claim(plans[i]);
    }
    final = nudge(grid, input.board, plans, fixed, auto);
  }
  for (const i of auto) routes[i].plan = final[i];
  return { routes, warnings, order: [...fixed, ...auto] };
}

/**
 * A stacked board. Each board's own wires are routed on that board alone,
 * in its own columns, exactly as on a single board (with the ends of the
 * wires joining boards taken, so none lies over one), then moved down to
 * where it is drawn. The wires joining two boards are then searched,
 * shortest first, on one lattice of the whole stack (each board's lines and
 * the seam's lanes between them) round everything already down: never along
 * a line another wire lies on, so each is at least a lane from its
 * neighbours, and at JOIN_BEND a bend, so most take a plain Z straight down
 * through the gap. Then every wire humps in one pass, the joining wires
 * last, so they hop over whatever they cross. A joining wire the lattice
 * cannot route keeps the corridor router's plan, with a warning. Saved shapes are keyed and numbered globally, so they are
 * translated on the way in; a joining wire has none.
 */
function routeStacked(input: RouteInput, saved: Record<string, WirePath>, opts: { maxExpand?: number }): RouteResult {
  const board = input.board;
  const cols = tierCols(board);
  const fallback = wirePolylines(input.wires, input.packages, board);
  const routes: WireRoute[] = fallback.map((plan) => ({ plan, lifts: [] }));
  const warnings: string[] = [];
  const order: number[] = [];
  const single: BoardSpec = { cols, kind: 'full', splitCol: null, railGapEvery: board.railGapEvery };
  const cross = input.wires.map((_, i) => i).filter((i) => tierOfWire(input.wires[i], board) === null);
  for (let t = 0; t < tierCount(board); t++) {
    const lo = t * cols;
    const on = (h: Hole) => tierOf(board, h.col) === t;
    const local = (h: Hole): Hole => ({ ...h, col: h.col - lo });
    const idx = input.wires.map((w, i) => (on(w.a) && on(w.b) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const wires = idx.map((i) => localWire(input.wires[i], board, t));
    const pinHoles: Record<string, Record<string, Hole>> = {};
    for (const [ref, pins] of Object.entries(input.pinHoles)) {
      const mine = Object.entries(pins).filter(([, h]) => on(h));
      if (mine.length) pinHoles[ref] = Object.fromEntries(mine.map(([p, h]) => [p, local(h)]));
    }
    const packages = input.packages.filter((p) => tierOf(board, p.col0) === t).map((p) => ({ ...p, col0: p.col0 - lo }));
    const ends = cross.flatMap((i) => [input.wires[i].a, input.wires[i].b]).filter(on).map(local);
    const localSaved: Record<string, WirePath> = {};
    idx.forEach((i, n) => {
      const path = saved[wireKey(input.wires[i])];
      if (path) localSaved[wireKey(wires[n])] = shiftPath(path, -lo, input.wires[i], board, t);
    });
    const r = routeBoard({ wires, packages, board: single, pinHoles, ends }, localSaved, opts);
    idx.forEach((i, n) => {
      routes[i] = { ...r.routes[n], plan: shiftPlan(r.routes[n].plan, t * TIER_PITCH) };
    });
    order.push(...r.order.map((n) => idx[n]));
    warnings.push(...r.warnings);
  }

  // The joining wires, on the whole stack's lattice round everything already down.
  if (cross.length) {
    const ends = (i: number): [Point, Point, boolean] => {
      const w = input.wires[i];
      const flip = tierOf(board, w.a.col) > tierOf(board, w.b.col);
      const [a, b] = (flip ? [w.b, w.a] : [w.a, w.b]).map((h) => placeAt(board, h));
      return [a, b, flip];
    };
    /** Every joining wire laid in `turn`: apart from every other wire if it can be, else as near as the plain search gets it. */
    const lay = (turn: number[]) => {
      const grid = new Grid(input);
      for (const i of order) grid.claim(routes[i].plan);
      // The whole stack's state space unless the caller sets a cap.
      const cap = opts.maxExpand ?? grid.nk * grid.nj * 4;
      const out = new Map<number, Point[] | null>();
      for (const i of turn) {
        const [a, b] = ends(i);
        const plan = grid.searchAt(a, b, cap, 1, { bend: JOIN_BEND }) ?? grid.searchAt(a, b, cap);
        out.set(i, plan);
        if (plan) grid.claim(plan);
      }
      return out;
    };
    const bends = (plan: Point[] | null | undefined) => (plan ? plan.length - 2 : Infinity);
    const score = (m: Map<number, Point[] | null>) => [...m.values()].reduce((s, p) => s + (p ? JOIN_BEND * bends(p) + planLength(p) : Infinity), 0);
    // Shortest first, as the corridor router lays them; then, a few times,
    // the ones that had to bend more than the hole-to-hole Z (out of the
    // hole, across, down through the gap, across, into the other hole: four
    // bends) first, kept if that is better.
    const span = (i: number) => planLength(fallback[i]);
    let turn = [...cross].sort((i, j) => span(i) - span(j) || i - j);
    let best = lay(turn);
    for (let round = 0; round < JOIN_ROUNDS; round++) {
      const hard = turn.filter((i) => bends(best.get(i)) > 4);
      if (!hard.length) break;
      const next = [...hard, ...turn.filter((i) => !hard.includes(i))];
      const tried = lay(next);
      if (score(tried) >= score(best)) break;
      [turn, best] = [next, tried];
    }
    const joined: number[] = [];
    for (const i of turn) {
      const plan = best.get(i);
      if (plan) {
        routes[i] = { plan: ends(i)[2] ? [...plan].reverse() : plan, lifts: [] };
        joined.push(i);
      } else {
        const w = input.wires[i];
        const warning = `no clean route for the ${w.net} jumper (${holeKey(w.a)}-${holeKey(w.b)}); drawn with the simple router`;
        routes[i] = { plan: fallback[i], lifts: [], warning };
        warnings.push(warning);
        order.push(i);
      }
    }
    order.push(...joined);
  }
  liftCrossings(routes, order);
  return { routes, warnings };
}
