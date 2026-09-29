import { describe, expect, test } from 'bun:test';
import { holeKey } from '../src/layout/board.ts';
import { pt } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { checkPlan, GAPS, LANE, pathToPlan, planToPath, routeWires, wireKey, WIRE_D, type Point } from '../src/render/route3d.ts';
import { docs, FIXTURES } from './route-fixtures.ts';

const routed = Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, routeWires(doc)]));

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
      const bad = routes.map((r, i) => [i, checkPlan(r.plan, doc.packages, doc.board)]).filter(([, why]) => why);
      expect(bad).toEqual([]);
    });

    test(`${name}: every crossing has exactly one hump, one wire diameter high`, () => {
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
      const lifts = routes.flatMap((r) => r.lifts);
      expect(lifts.length).toBe(crossings);
      expect(lifts.every((l) => l.height === WIRE_D)).toBe(true);
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

  test('a saved shape for a wire that is gone is dropped with a warning naming its net', () => {
    const again = routeWires(doc, { '/NOPE|a1|a9': { points: [{ col: 1, gap: 'a|b', lane: 0 }, { col: 9, gap: 'a|b', lane: 0 }] } });
    expect(again.warnings).toEqual(['hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; dropped']);
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
