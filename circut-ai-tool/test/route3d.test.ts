import { describe, expect, test } from 'bun:test';
import { holeKey } from '../src/layout/board.ts';
import type { Hole, WirePath } from '../src/layout/types.ts';
import { HEIGHT, placeAt, pt, TIER_PITCH } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { handles, moveSegment } from '../src/edit/wireshape.ts';
import { checkPlan, GAPS, LANE, latticeLines, nodeKey, SEAM, SEAM_LANES, pathToPlan, planToPath, routeWires, shapePlan, takenNodes, wireKey, AIR_Z, WIRE_D, type Point, type WireRoute } from '../src/render/route3d.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { centreLine, type V3 } from '../client/wiretube-math.ts';
import { clipPairs } from '../src/render/clearance.ts';
import { docs, FIXTURES } from './route-fixtures.ts';

const routed = Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, routeWires(doc)]));

/**
 * The legs and jumper ends a route lies on, other than its own two holes,
 * as hole names. Worked out here from pinHoles and the wires directly, not
 * through takenNodes, so the test does not just repeat checkPlan.
 */
function overTaken(doc: LayoutDoc, i: number, r: WireRoute): string[] {
  const at = (p: Point) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const taken = new Map<string, string>();
  for (const pins of Object.values(doc.pinHoles)) for (const h of Object.values(pins)) taken.set(at(pt(h)), holeKey(h));
  doc.wires.forEach((w, j) => {
    if (j === i) return;
    for (const h of [w.a, w.b]) taken.set(at(pt(h)), holeKey(h));
  });
  const own = new Set([at(pt(doc.wires[i].a)), at(pt(doc.wires[i].b))]);
  const out: string[] = [];
  for (let s = 0; s + 1 < r.plan.length; s++) {
    const [a, b] = [r.plan[s], r.plan[s + 1]];
    const n = Math.round((Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / LANE);
    for (let t = 0; t <= n; t++) {
      const k = at([a[0] + Math.sign(b[0] - a[0]) * t * LANE, a[1] + Math.sign(b[1] - a[1]) * t * LANE]);
      if (!own.has(k) && taken.has(k)) out.push(taken.get(k)!);
    }
  }
  return out;
}

describe('routeWires on the fixtures', () => {
  for (const name of Object.keys(FIXTURES)) {
    const doc = docs[name];
    const { routes, warnings } = routed[name];

    test(`${name}: every jumper starts and ends in its holes, and none needed the fallback`, () => {
      expect(warnings).toEqual([]);
      routes.forEach((r, i) => {
        expect(r.plan[0]).toEqual(pt(doc.wires[i].a));
        expect(r.plan[r.plan.length - 1]).toEqual(pt(doc.wires[i].b));
        expect(r.warning).toBeUndefined();
      });
    });

    test(`${name}: every run is square, leaves its holes along the column, stays on the board and clear of the chips`, () => {
      const taken = takenNodes(doc);
      const bad = routes.map((r, i) => [i, checkPlan(r.plan, doc.packages, doc.board, taken)]).filter(([, why]) => why);
      expect(bad).toEqual([]);
    });

    test(`${name}: no route, automatic or hand-shaped, lies on a leg or another wire's end`, () => {
      expect(routes.flatMap((r, i) => overTaken(doc, i, r).map((h) => `${wireKey(doc.wires[i])} over ${h}`))).toEqual([]);
      // Hand shapes: every drag of a run the editor would accept (one lane
      // step either way, then three pitches out), saved a few at a time and
      // laid out with everything else routed round them.
      const taken = takenNodes(doc);
      const kept = new Map<string, WirePath>();
      let accepted = 0;
      routes.forEach((r, i) => {
        const w = doc.wires[i];
        for (const h of handles(r.plan).filter((h) => h.kind === 'segment')) {
          for (const d of [-6, -2, -1, 1, 2, 6]) {
            const v = (h.horizontal ? h.at[1] : h.at[0]) + d * LANE;
            const path = planToPath(w, moveSegment(r.plan, h.index, v));
            if (!path || shapePlan(w, path, doc.packages, doc.board, taken).why) continue;
            accepted++;
            const plan = shapePlan(w, path, doc.packages, doc.board, taken).plan!;
            expect(overTaken(doc, i, { plan, lifts: [] })).toEqual([]);
            if (!kept.has(wireKey(w)) && kept.size < 12) kept.set(wireKey(w), path);
          }
        }
      });
      expect(accepted).toBeGreaterThan(0);
      const entries = [...kept];
      for (let b = 0; b < entries.length; b += 4) {
        const again = routeWires(doc, Object.fromEntries(entries.slice(b, b + 4)));
        again.routes.forEach((r, i) => expect(overTaken(doc, i, r)).toEqual([]));
      }
    });

    test(`${name}: every crossing has a hump, at least a diameter and a little air high`, () => {
      const plans = routes.map((r) => r.plan);
      let crossings = 0;
      for (let i = 0; i < plans.length; i++) {
        for (let j = i + 1; j < plans.length; j++) {
          for (let s = 0; s + 1 < plans[i].length; s++) {
            for (let t = 0; t + 1 < plans[j].length; t++) {
              const [a, b, c, d] = [plans[i][s], plans[i][s + 1], plans[j][t], plans[j][t + 1]];
              const ah = a[1] === b[1];
              if (ah === (c[1] === d[1])) continue;
              const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
              if (v1[0] > Math.min(h1[0], h2[0]) + 0.5 && v1[0] < Math.max(h1[0], h2[0]) - 0.5 && h1[1] > Math.min(v1[1], v2[1]) + 0.5 && h1[1] < Math.max(v1[1], v2[1]) - 0.5) crossings++;
            }
          }
        }
      }
      // Bends lying on another wire hump too, so there can be more humps than crossings.
      const lifts = routes.flatMap((r) => r.lifts);
      expect(lifts.length).toBeGreaterThanOrEqual(crossings);
      expect(lifts.every((l) => l.height >= WIRE_D + AIR_Z)).toBe(true);
    });

    test(`${name}: at every crossing the drawn wires are at least a diameter apart, centre to centre`, () => {
      // The tube's own centre lines, so a hump drawn over the valley between
      // two humps is measured as drawn, not as the router meant it.
      const lines = routes.map((r) => centreLine(r.plan, r.lifts, 0, -4));
      const heightAt = (line: V3[], [x, z]: Point) => {
        for (let k = 0; k + 1 < line.length; k++) {
          const [a, b] = [line[k], line[k + 1]];
          const onX = Math.abs(a[0] - b[0]) < 0.01 && Math.abs(x - a[0]) < 0.01 && z >= Math.min(a[2], b[2]) - 0.01 && z <= Math.max(a[2], b[2]) + 0.01;
          const onZ = Math.abs(a[2] - b[2]) < 0.01 && Math.abs(z - a[2]) < 0.01 && x >= Math.min(a[0], b[0]) - 0.01 && x <= Math.max(a[0], b[0]) + 0.01;
          if (!onX && !onZ) continue;
          const span = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]);
          return span < 1e-9 ? a[1] : a[1] + ((b[1] - a[1]) * (Math.abs(x - a[0]) + Math.abs(z - a[2]))) / span;
        }
        throw new Error(`no point of the line lies over ${x}, ${z}`);
      };
      const tight: string[] = [];
      let crossings = 0;
      for (let i = 0; i < routes.length; i++) {
        for (let j = i + 1; j < routes.length; j++) {
          const [p, q] = [routes[i].plan, routes[j].plan];
          for (let s = 0; s + 1 < p.length; s++) {
            for (let t = 0; t + 1 < q.length; t++) {
              const [a, b, c, d] = [p[s], p[s + 1], q[t], q[t + 1]];
              const ah = a[1] === b[1];
              if (ah === (c[1] === d[1])) continue;
              const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b];
              if (!(v1[0] > Math.min(h1[0], h2[0]) + 0.5 && v1[0] < Math.max(h1[0], h2[0]) - 0.5 && h1[1] > Math.min(v1[1], v2[1]) + 0.5 && h1[1] < Math.max(v1[1], v2[1]) - 0.5)) continue;
              crossings++;
              const gap = Math.abs(heightAt(lines[i], [v1[0], h1[1]]) - heightAt(lines[j], [v1[0], h1[1]]));
              if (gap < WIRE_D + AIR_Z - 1e-9) tight.push(`${wireKey(doc.wires[i])} x ${wireKey(doc.wires[j])}: ${gap}`);
            }
          }
        }
      }
      expect(crossings).toBeLessThanOrEqual(routes.flatMap((r) => r.lifts).length);
      expect(tight).toEqual([]);
    });

    test(`${name}: routing twice gives the same paths`, () => {
      expect(routeWires(doc)).toEqual(routed[name]);
    });
  }
});

describe('hand-shaped wires', () => {
  const doc = docs.PL1_1;
  const i = routed.PL1_1.routes.findIndex((r) => r.plan.length >= 4);
  expect(i).toBeGreaterThanOrEqual(0);
  const w = doc.wires[i];
  const auto = routed.PL1_1.routes[i].plan;

  test('a plan survives the trip to grid units and back, whichever way round the wire is stored', () => {
    const path = planToPath(w, auto)!;
    expect(path.points.length).toBe(auto.length - 2);
    expect(pathToPlan(w, path)).toEqual(auto);
    const flipped = { ...w, a: w.b, b: w.a };
    expect(planToPath(flipped, [...auto].reverse())).toEqual(path);
    expect(pathToPlan(flipped, path)).toEqual([...auto].reverse());
    expect(path.points.every((p) => GAPS.some((g) => g.name === p.gap))).toBe(true);
  });

  test('a plan off the half-pitch grid (the simple router draws those) has no grid form', () => {
    const off: Point[] = [auto[0], [auto[0][0], auto[1][1] - 5], [auto[auto.length - 1][0], auto[1][1] - 5], auto[auto.length - 1]];
    expect(planToPath(w, off)).toBeNull();
  });

  test('a plan with a sideways-offset run (ortho.ts SUB_V) has no grid form', () => {
    const off = auto.map((p, n) => (n === 1 || n === 2 ? ([p[0] + 4, p[1]] as Point) : p));
    expect(planToPath(w, off)).toBeNull();
  });

  test('bends in the top and bottom corridors round-trip', () => {
    const [a, b] = [pt(w.a), pt(w.b)];
    for (const [gap, lane] of [['top', 0], ['bottom', 0], ['top', -1], ['bottom', 1]] as const) {
      const y = GAPS.find((g) => g.name === gap)!.y + lane * LANE;
      const plan: Point[] = [a, [a[0], y], [b[0], y], b];
      const path = planToPath(w, plan)!;
      expect(path.points.every((p) => p.gap === gap && p.lane === lane)).toBe(true);
      expect(pathToPlan(w, path)).toEqual(plan);
    }
  });

  test('a saved bend sitting exactly on its own hole is refused, not silently straightened', () => {
    const a = pt(w.a);
    const row = GAPS.find((g) => Math.abs(g.y + LANE - a[1]) < 0.01 || Math.abs(g.y - LANE - a[1]) < 0.01)!;
    const lane = Math.round((a[1] - row.y) / LANE);
    const path = { points: [{ col: 1 + (a[0] - pt({ col: 1, row: 'a' })[0]) / 18, gap: row.name, lane }, ...planToPath(w, auto)!.points.slice(1)] };
    const again = routeWires(doc, { [wireKey(w)]: w.a && holeKey(w.a) < holeKey(w.b) ? path : { points: [...path.points].reverse() } });
    expect(again.warnings.length).toBe(1);
    expect(again.warnings[0]).toContain('no longer fits');
    expect(again.routes[i].locked).toBeUndefined();
  });

  test('a saved shape is used exactly as saved, and marked locked', () => {
    // Slide the wire's second run (the first that is not in a hole) one lane over.
    const across = auto[1][0] === auto[2][0] ? 0 : 1;
    const shaped = auto.map((p, n) => (n === 1 || n === 2 ? ((across ? [p[0], p[1] + LANE] : [p[0] + LANE, p[1]]) as Point) : p));
    expect(checkPlan(shaped, doc.packages, doc.board)).toBeNull();
    const again = routeWires(doc, { [wireKey(w)]: planToPath(w, shaped)! });
    expect(again.warnings).toEqual([]);
    expect(again.routes[i].plan).toEqual(shaped);
    expect(again.routes[i].locked).toBe(true);
  });

  test('a shape that runs over a leg is refused, naming the hole; its own two holes are fine', () => {
    const k = doc.wires.findIndex((x) => wireKey(x) === '/A|g21|g3');
    const own = routed.PL1_1.routes[k].plan;
    const taken = takenNodes(doc);
    expect(checkPlan(own, doc.packages, doc.board, taken)).toBeNull();
    // Dragging its long run down past row j stretches the stub out of g3 over the leg in j3.
    const path = planToPath(doc.wires[k], moveSegment(own, 1, 273))!;
    expect(shapePlan(doc.wires[k], path, doc.packages, doc.board, new Map()).why).toBeNull();
    expect(shapePlan(doc.wires[k], path, doc.packages, doc.board, taken).why).toBe('the path runs over a leg at j3');
    // The router refuses the same saved shape and routes the wire itself.
    const again = routeWires(doc, { [wireKey(doc.wires[k])]: path });
    expect(again.warnings).toEqual([`hand-shaped jumper for /A (g21-g3) no longer fits (the path runs over a leg at j3); re-routed`]);
    expect(again.routes[k].locked).toBeUndefined();
  });

  test("a jumper's end is taken for every other wire", () => {
    const taken = takenNodes(doc);
    const other = doc.wires.find((x) => x !== w)!;
    expect(taken.get(nodeKey(pt(other.a))!)).toBe(`another jumper's end at ${holeKey(other.a)}`);
    // A run straight down that jumper's column, through its hole.
    const [ox, oy] = pt(other.a);
    expect(checkPlan([[ox, oy - 2 * LANE], [ox, oy + 2 * LANE]], doc.packages, doc.board, taken)).toBe(`the path runs over another jumper's end at ${holeKey(other.a)}`);
  });

  test('a saved shape for a wire that is gone is set aside with a warning naming its net', () => {
    const again = routeWires(doc, { '/NOPE|a1|a9': { points: [{ col: 1, gap: 'a|b', lane: 0 }, { col: 9, gap: 'a|b', lane: 0 }] } });
    expect(again.warnings).toEqual(["hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; kept in case the part moves back. 'Tidy all wires' forgets it"]);
    expect(again.routes).toEqual(routed.PL1_1.routes);
  });

  test('a saved shape naming a corridor the board lacks is re-routed with a warning; a run through a chip is refused', () => {
    const odd = routeWires(doc, { [wireKey(w)]: { points: [{ col: 3, gap: 'x|y', lane: 0 }] } });
    expect(odd.warnings[0]).toContain(`hand-shaped jumper for ${w.net}`);
    expect(odd.warnings[0]).toContain('names a corridor');
    expect(odd.routes[i].locked).toBeUndefined();
    const [cx] = pt({ col: doc.packages[0].col0 + 1, row: 'd' });
    expect(checkPlan([[cx, pt({ col: 1, row: 'd' })[1]], [cx, pt({ col: 1, row: 'g' })[1]]], doc.packages, doc.board)).toBe(`the path runs through ${doc.packages[0].id}`);
  });
});

describe('search cap', () => {
  test('a search that gives up falls back to the ortho.ts path, with a warning, and never throws', () => {
    const doc = docs['lab4-74ls08'];
    const { routes, warnings } = routeWires(doc, {}, { maxExpand: 1 });
    const fell = routes.map((_, i) => i).filter((i) => routes[i].warning);
    expect(fell.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(fell.length);
    for (const i of fell) {
      expect(routes[i].plan).toEqual(wirePolylines([doc.wires[i]], doc.packages, doc.board)[0]);
      expect(routes[i].warning).toContain(doc.wires[i].net);
    }
  });
});

describe('stacked boards', () => {
  const board = { cols: 126, kind: 'stacked' as const, splitCol: 63, railGapEvery: 6, tiers: 2 };
  const w = (a: string, b: string) => {
    const h = (s: string) => ({ row: s.replace(/\d+$/, '') as never, col: Number(/\d+$/.exec(s)![0]) });
    return { net: '/N', a: h(a), b: h(b), role: 'signal' as const };
  };

  test('a wire on the lower board is routed there by the lattice, square and on that board', () => {
    const r = routeWires({ wires: [w('a70', 'a80')], packages: [], board, pinHoles: {} });
    expect(r.warnings).toEqual([]);
    const plan = r.routes[0].plan;
    // Both ends where placeAt puts them: lower board, columns 7 and 17 of it.
    expect(plan[0]).toEqual(placeAt(board, { col: 70, row: 'a' }));
    expect(plan[plan.length - 1]).toEqual(placeAt(board, { col: 80, row: 'a' }));
    expect(plan.every(([, y]) => y > TIER_PITCH - 30)).toBe(true);
    expect(checkPlan(plan, [], board)).toBeNull();
  });

  test('a wire joining the two boards is routed on the stack’s lattice and crosses only in the gap between them', () => {
    const wires = [w('a5', 'j70'), w('j20', 'a90'), w('e40', 'f75')];
    const pinHoles: Record<string, Record<string, Hole>> = { R1: { '1': { col: 70, row: 'c' } }, R2: { '1': { col: 30, row: 'i' } } };
    const r = routeWires({ wires, packages: [], board, pinHoles });
    expect(r.warnings).toEqual([]);
    const ys = latticeLines(board).map((l) => l.y);
    const onLattice = ([x, y]: Point) => Math.abs((x - pt({ col: 1, row: 'a' })[0]) / LANE - Math.round((x - pt({ col: 1, row: 'a' })[0]) / LANE)) < 1e-9 && ys.some((v) => Math.abs(v - y) < 0.01);
    const taken = takenNodes({ wires, pinHoles, board });
    r.routes.forEach((route, i) => {
      const plan = route.plan;
      expect(route.warning).toBeUndefined();
      expect(plan[0]).toEqual(placeAt(board, wires[i].a));
      expect(plan[plan.length - 1]).toEqual(placeAt(board, wires[i].b));
      // Every bend is a lattice node.
      expect(plan.slice(1, -1).every(onLattice)).toBe(true);
      expect(checkPlan(plan, [], board, taken)).toBeNull();
      // Between the two boards' outer corridors it lies only on the seam's lanes, and it crosses from one board to the other there.
      const seam = Array.from({ length: 2 * SEAM_LANES + 1 }, (_, l) => SEAM.y + (l - SEAM_LANES) * LANE);
      const [lo, hi] = [GAPS[GAPS.length - 1].y, TIER_PITCH + GAPS[0].y];
      for (let k = 0; k + 1 < plan.length; k++) {
        const [p, q] = [plan[k], plan[k + 1]];
        if (Math.abs(p[1] - q[1]) < 0.01 && p[1] > lo && p[1] < hi) expect(seam.some((y) => Math.abs(y - p[1]) < 0.01)).toBe(true);
      }
      const crossing = plan.slice(1).filter((q, k) => Math.min(plan[k][1], q[1]) < HEIGHT && Math.max(plan[k][1], q[1]) > TIER_PITCH);
      expect(crossing.length).toBe(1);
    });
  });

  test('a joining wire whose search gives up keeps the corridor plan, with a warning, and still hops', () => {
    // A cap the short wire on the upper board fits in and the joining wire does not.
    const wires = [{ ...w('a5', 'j70'), net: '/X' }, { ...w('g2', 'g12'), net: '/Y' }];
    const r = routeWires({ wires, packages: [], board, pinHoles: {} }, {}, { maxExpand: 200 });
    expect(r.warnings.length).toBe(1);
    expect(r.routes[0].warning).toContain('/X');
    expect(r.warnings[0]).toBe(r.routes[0].warning!);
    expect(r.routes[0].plan).toEqual(wirePolylines(wires, [], board)[0]);
    // It crosses the board wire, and humps over it.
    expect(r.routes[1].warning).toBeUndefined();
    expect(r.routes[0].lifts.length).toBeGreaterThan(0);
    expect(clipPairs({ routes: r.routes }, WIRE_D + AIR_Z)).toEqual([]);
  });

  test('a wire joining the two boards has no hand shape, and wires beside it stay a lane apart', () => {
    const wires = [w('j20', 'a70'), w('j21', 'a71'), w('j22', 'a72')];
    const r = routeWires({ wires, packages: [], board, pinHoles: {} });
    expect(r.warnings).toEqual([]);
    // Not hand-shapeable (the editor offers it no handles), as before.
    for (const [i, route] of r.routes.entries()) expect(planToPath(wires[i], route.plan, board)).toBeNull();
    // No two share a line: every run of one is a lane or more from every parallel run of another.
    const runs = r.routes.flatMap((route, i) => route.plan.slice(1).map((q, k) => ({ i, p: route.plan[k], q })));
    for (const a of runs) {
      for (const b of runs) {
        if (a.i >= b.i) continue;
        const ah = Math.abs(a.p[1] - a.q[1]) < 0.01;
        if (ah !== (Math.abs(b.p[1] - b.q[1]) < 0.01)) continue;
        const [al, ac] = ah ? [0, 1] : [1, 0];
        const overlap = Math.min(Math.max(a.p[al], a.q[al]), Math.max(b.p[al], b.q[al])) - Math.max(Math.min(a.p[al], a.q[al]), Math.min(b.p[al], b.q[al]));
        if (overlap > 0.5) expect(Math.abs(a.p[ac] - b.p[ac])).toBeGreaterThanOrEqual(LANE - 0.01);
      }
    }
  });

  test('a bend in the lower board’s left margin is told from one in the upper board’s right margin', () => {
    // Column 63.5 is both: the margin right of the upper board's last column and left of the lower board's first.
    const x0 = pt({ col: 1, row: 'a' })[0];
    const lower = w('a65', 'a70');
    const [a, b] = [placeAt(board, lower.a), placeAt(board, lower.b)];
    const left: Point[] = [a, [a[0], a[1] - LANE], [x0 - LANE, a[1] - LANE], [x0 - LANE, a[1] - 3 * LANE], [b[0], a[1] - 3 * LANE], b];
    const path = planToPath(lower, left, board)!;
    expect(path.points.map((p) => p.col)).toContain(63.5);
    expect(pathToPlan(lower, path, board)).toEqual(left);
    const upper = w('a55', 'a60');
    const [c, d] = [placeAt(board, upper.a), placeAt(board, upper.b)];
    const xr = pt({ col: 63, row: 'a' })[0] + LANE;
    const right: Point[] = [c, [c[0], c[1] - LANE], [xr, c[1] - LANE], [xr, c[1] - 3 * LANE], [d[0], c[1] - 3 * LANE], d];
    const p2 = planToPath(upper, right, board)!;
    expect(p2.points.map((p) => p.col)).toContain(63.5);
    expect(pathToPlan(upper, p2, board)).toEqual(right);
  });

  test('a lower-board plan round-trips through planToPath with global columns', () => {
    const wire = w('a70', 'a80');
    const plan = routeWires({ wires: [wire], packages: [], board, pinHoles: {} }).routes[0].plan;
    const path = planToPath(wire, plan, board)!;
    expect(path).not.toBeNull();
    for (const p of path.points) expect(p.col).toBeGreaterThan(63);
    expect(pathToPlan(wire, path, board)).toEqual(plan);
  });

  test('a saved shape on the lower board is kept by the router', () => {
    const wire = w('a70', 'a80');
    const path = { points: [{ col: 70, gap: 'top', lane: 0 }, { col: 80, gap: 'top', lane: 0 }] };
    const r = routeWires({ wires: [wire], packages: [], board, pinHoles: {} }, { [wireKey(wire)]: path });
    expect(r.routes[0].locked).toBe(true);
  });

  test('legs on the lower board are taken nodes there, not on the upper board', () => {
    const taken = takenNodes({ wires: [], pinHoles: { R1: { '1': { col: 70, row: 'c' } } }, board });
    expect([...taken.values()]).toEqual(['a leg at c70']);
    expect(taken.has(nodeKey(placeAt(board, { col: 70, row: 'c' }))!)).toBe(true);
    expect(taken.has(nodeKey(pt({ col: 7, row: 'c' }))!)).toBe(false);
  });
});
