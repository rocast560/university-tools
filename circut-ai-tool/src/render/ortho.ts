// Orthogonal jumpers: every wire leaves its hole straight, runs along a
// corridor between two hole rows, and turns square corners, the way a tidy
// hand-wired board looks when the jumpers are cut and bent to length.
//
// The arcs in routing.ts are the default because they are honest about a
// jumper's slack. This is the other view: cleaner to read, and laid out so
// that no two runs share the same line. Corridors are the gaps between rows
// (three abreast where the gap is wide: the gutter and the strips beside the
// rails), each run claims the stretch of corridor it uses, and a vertical
// that would lie on another one steps sideways by a few units first.
//
// Pure, and a function of the wire list and the packages alone, so the same
// board always draws the same paths.

import { isRail } from '../layout/board.ts';
import type { BoardSpec, Package, Wire } from '../layout/types.ts';
import { moduleRect, P, placeAt, ROWY, tierCount, TIER_PITCH, tierShift } from './geometry.ts';

export type Point = [number, number];

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Air between a wire and a package body, in SVG units. */
const MARGIN = 3;
/** Sub-lanes within one corridor, tried in this order. */
const SUB_H = [0, -5, 5, -10, 10];
/** Sideways steps for a vertical that would lie on another, tried in this order. */
const SUB_V = [0, -4, 4, -8, 8];

/** Where the bodies are, so no run is drawn through a chip. */
export function packageRects(packages: Package[], board: BoardSpec): Rect[] {
  return packages.map((pkg) => {
    const [dx, dy] = tierShift(board, pkg.col0);
    if (pkg.kind === 'module') {
      const r = moduleRect(pkg);
      return { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy };
    }
    const width = pkg.kind === 'dipswitch' ? (pkg.positions ?? 1) : pkg.pins / 2;
    const x1 = placeAt(board, { col: pkg.col0, row: 'e' })[0] - P / 2 + 2;
    const x2 = placeAt(board, { col: pkg.col0 + width - 1, row: 'e' })[0] + P / 2 - 2;
    return pkg.kind === 'sevenseg' ? { x1, y1: ROWY.c - 8 + dy, x2, y2: ROWY.h + 8 + dy } : { x1, y1: ROWY.e - 7 + dy, x2, y2: ROWY.f + 7 + dy };
  });
}

/** The corridors: between every pair of hole rows, three abreast where the gap is wide, and one outside each rail. */
const CORRIDORS: number[] = (() => {
  const ys = (['T+', 'T-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'B-', 'B+'] as const).map((r) => ROWY[r]);
  const out = [ys[0] - 12];
  for (let i = 0; i + 1 < ys.length; i++) {
    const gap = ys[i + 1] - ys[i];
    if (gap > 24) out.push(ys[i] + gap / 4, ys[i] + gap / 2, ys[i] + (3 * gap) / 4);
    else out.push((ys[i] + ys[i + 1]) / 2);
  }
  out.push(ys[ys.length - 1] + 12);
  return out;
})();

const span = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];

class Router {
  private rects: Rect[];
  private usedH = new Map<number, [number, number][]>();
  private usedV = new Map<number, [number, number][]>();
  private columns: number[];

  private corridors: number[];

  constructor(packages: Package[], board: BoardSpec) {
    this.rects = packageRects(packages, board);
    this.columns = [...new Set(Array.from({ length: board.cols }, (_, i) => placeAt(board, { col: i + 1, row: 'a' })[0]))];
    // Every stacked board has the same corridors, one pitch further down,
    // and the open space between two boards is a corridor too.
    this.corridors = [];
    for (let k = 0; k < tierCount(board); k++) {
      this.corridors.push(...CORRIDORS.map((y) => y + k * TIER_PITCH));
      if (k > 0) this.corridors.push(k * TIER_PITCH + (ROWY['B+'] + ROWY['T+'] - TIER_PITCH) / 2);
    }
  }

  private hitsH(y: number, xa: number, xb: number): boolean {
    const [x1, x2] = span(xa, xb);
    return this.rects.some((r) => y > r.y1 - MARGIN && y < r.y2 + MARGIN && x2 > r.x1 - MARGIN && x1 < r.x2 + MARGIN);
  }

  private hitsV(x: number, ya: number, yb: number): boolean {
    const [y1, y2] = span(ya, yb);
    return this.rects.some((r) => x > r.x1 - MARGIN && x < r.x2 + MARGIN && y2 > r.y1 - MARGIN && y1 < r.y2 + MARGIN);
  }

  /** How many runs already lie on this stretch of corridor. */
  private takenH(y: number, xa: number, xb: number): number {
    const [x1, x2] = span(xa, xb);
    return (this.usedH.get(y) ?? []).filter(([p, q]) => x2 > p + 0.5 && x1 < q - 0.5).length;
  }

  /** How many runs already lie on this stretch of column. */
  private takenV(x: number, ya: number, yb: number): number {
    const [y1, y2] = span(ya, yb);
    return (this.usedV.get(x) ?? []).filter(([p, q]) => y2 > p + 0.5 && y1 < q - 0.5).length;
  }

  private claim(path: Point[]) {
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      if (ay === by) this.usedH.set(ay, [...(this.usedH.get(ay) ?? []), span(ax, bx)]);
      else if (ax === bx) this.usedV.set(ax, [...(this.usedV.get(ax) ?? []), span(ay, by)]);
    }
  }

  /**
   * A vertical from (x, y1) to (x, y2) that does not lie on another: the
   * same line when it is free, otherwise stepped sideways with a short jog at
   * each end so the ends still meet their holes.
   */
  private vertical(x: number, y1: number, y2: number): Point[] {
    if (y1 === y2) return [];
    for (const dx of SUB_V) {
      const vx = x + dx;
      if (this.hitsV(vx, y1, y2) || this.takenV(vx, y1, y2)) continue;
      return dx === 0 ? [[x, y1], [x, y2]] : [[x, y1], [vx, y1], [vx, y2], [x, y2]];
    }
    return [[x, y1], [x, y2]];
  }

  /** Corridor sub-lanes nearest the given y first, so short hops stay close to their holes. */
  private lanes(ys: number[]): number[] {
    const mid = ys.reduce((s, y) => s + y, 0) / ys.length;
    const out: number[] = [];
    for (const c of [...this.corridors].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))) for (const sub of SUB_H) out.push(c + sub);
    return out;
  }

  /**
   * The best route between two holes. Lying on a stretch another run
   * already uses costs far more than any length, so runs only share a line
   * when the board is too crowded to avoid it, and even then they spread
   * over the least-used lines rather than piling onto one.
   */
  private search(a: Point, b: Point): Point[] | null {
    const [ax, ay] = a;
    const [bx, by] = b;
    const SHARE = 400;
    // One corridor: out of each hole to it, and along it between them.
    let u: { y: number; cost: number } | null = null;
    for (const y of this.lanes([ay, by])) {
      if (this.hitsV(ax, ay, y) || this.hitsV(bx, by, y) || this.hitsH(y, ax, bx)) continue;
      const cost = Math.abs(ay - y) + Math.abs(by - y) + SHARE * this.takenH(y, ax, bx);
      if (!u || cost < u.cost) u = { y, cost };
      if (u.cost === cost && cost <= 12) break;
    }
    if (u && u.cost < SHARE) return this.joinU(a, b, u.y);
    // Two corridors joined by a vertical down a free column, for a run that
    // has to get round a body between its holes.
    let z: { y1: number; x: number; y2: number; cost: number } | null = null;
    // The joining column lies between the holes or just outside them, and
    // may sit anywhere across a column's pitch, so several runs can share
    // one free column side by side.
    const [xlo, xhi] = span(ax, bx);
    const xs: number[] = [];
    for (const cx of this.columns) if (cx >= xlo - 3 * P && cx <= xhi + 3 * P) for (const dx of SUB_V) xs.push(cx + dx);
    for (const y1 of this.lanes([ay]).slice(0, 15)) {
      if (this.hitsV(ax, ay, y1)) continue;
      for (const y2 of this.lanes([by]).slice(0, 15)) {
        if (this.hitsV(bx, by, y2) || y1 === y2) continue;
        for (const x of xs) {
          if (this.hitsH(y1, ax, x) || this.hitsH(y2, x, bx) || this.hitsV(x, y1, y2)) continue;
          const shared = this.takenH(y1, ax, x) + this.takenH(y2, x, bx) + this.takenV(x, y1, y2);
          const cost = Math.abs(ay - y1) + Math.abs(ax - x) + Math.abs(y1 - y2) + Math.abs(x - bx) + Math.abs(y2 - by) + SHARE * shared;
          if (!z || cost < z.cost) z = { y1, x, y2, cost };
        }
      }
    }
    if (u && (!z || u.cost <= z.cost)) return this.joinU(a, b, u.y);
    if (!z) return null;
    const up = this.vertical(ax, ay, z.y1);
    const down = this.vertical(bx, z.y2, by);
    const pts: Point[] = [...(up.length ? up : [a]), [z.x, z.y1], [z.x, z.y2], ...(down.length ? down : [b])];
    return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  }

  route(a: Point, b: Point): Point[] {
    const [ax, ay] = a;
    const [bx, by] = b;
    let path: Point[] | null = null;
    if (ax === bx && !this.hitsV(ax, ay, by)) path = this.vertical(ax, ay, by);
    path ??= this.search(a, b) ?? this.joinU(a, b, this.lanes([ay, by])[0]);
    this.claim(path);
    return path;
  }

  private joinU(a: Point, b: Point, y: number): Point[] {
    const up = this.vertical(a[0], a[1], y);
    const down = this.vertical(b[0], b[1], y).reverse();
    const pts: Point[] = [...(up.length ? up : [a]), ...(down.length ? down : [b])];
    return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  }
}

/** Square-cornered paths for every wire, in the order given; each starts and ends on its holes. */
export function wirePolylines(wires: Wire[], packages: Package[], board: BoardSpec): Point[][] {
  const router = new Router(packages, board);
  const out: Point[][] = new Array(wires.length);
  // Short runs first, so they keep the corridor nearest their holes and the
  // long ones fan out beyond them.
  const pt = (h: Wire['a']) => placeAt(board, h);
  const order = wires.map((w, i) => i).sort((i, j) => {
    const li = Math.abs(pt(wires[i].a)[0] - pt(wires[i].b)[0]) + Math.abs(pt(wires[i].a)[1] - pt(wires[i].b)[1]);
    const lj = Math.abs(pt(wires[j].a)[0] - pt(wires[j].b)[0]) + Math.abs(pt(wires[j].a)[1] - pt(wires[j].b)[1]);
    return li - lj || i - j;
  });
  for (const i of order) {
    const w = wires[i];
    // Rail runs along a rail row itself stay on that row: a split bridge is
    // a short hop, drawn as a low arch above the rail so it reads as a wire.
    out[i] = router.route(pt(w.a), pt(w.b));
    if (isRail(w.a.row) && isRail(w.b.row) && w.a.row === w.b.row && out[i].length === 2) {
      const y = pt(w.a)[1] + (w.a.row.startsWith('T') ? -8 : 8);
      out[i] = [pt(w.a), [pt(w.a)[0], y], [pt(w.b)[0], y], pt(w.b)];
    }
  }
  return out;
}
