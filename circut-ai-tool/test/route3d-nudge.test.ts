import { describe, expect, test } from 'bun:test';
import type { LayoutDoc } from '../src/pipeline.ts';
import { pt } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { checkPlan, clashes, LANE, packLine, peelOrder, planToPath, routeWires, wireKey, type Point, type Run } from '../src/render/route3d.ts';
import { docs, FIXTURES } from './route-fixtures.ts';

const routed = Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, routeWires(doc)]));
const bends = (plan: Point[]) => Math.max(0, plan.length - 2);
const nets = (doc: LayoutDoc) => doc.wires.map((w) => w.net);

describe('nudged routes on the fixtures', () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`${name}: no jumper lies along, or turns on, a jumper of another net`, () => {
      const { routes } = routed[name];
      expect(clashes(routes.map((r) => r.plan), routes.map((_, i) => i), nets(docs[name]))).toEqual([]);
    });
  }

  // ortho.ts steps sideways out of a hole along the row and runs over legs
  // and jumper ends to save bends; this router may not. The fair comparison
  // is on the wires ortho draws legally, and on the two lab4 boards this one
  // must match it or win there.
  const legal = (doc: LayoutDoc, plan: Point[]) => {
    const taken = [...Object.values(doc.pinHoles).flatMap((p) => Object.values(p)), ...doc.wires.flatMap((w) => [w.a, w.b])].map(pt);
    const n = plan.length;
    if (plan[0][0] !== plan[1][0] || plan[n - 1][0] !== plan[n - 2][0]) return false;
    return !taken.some((h) => {
      if ((h[0] === plan[0][0] && h[1] === plan[0][1]) || (h[0] === plan[n - 1][0] && h[1] === plan[n - 1][1])) return false;
      return plan.slice(0, -1).some((a, i) => {
        const b = plan[i + 1];
        return a[1] === b[1] ? Math.abs(h[1] - a[1]) < 4 && h[0] >= Math.min(a[0], b[0]) - 3 && h[0] <= Math.max(a[0], b[0]) + 3 : Math.abs(h[0] - a[0]) < 4 && h[1] >= Math.min(a[1], b[1]) - 3 && h[1] <= Math.max(a[1], b[1]) + 3;
      });
    });
  };
  for (const name of ['lab4-74ls08', 'lab4-decoder']) {
    test(`${name}: no more bends than ortho.ts on the wires it draws legally`, () => {
      const doc = docs[name];
      const old = wirePolylines(doc.wires, doc.packages, doc.board);
      const fair = old.map((p, i) => (legal(doc, p) ? i : -1)).filter((i) => i >= 0);
      expect(fair.length).toBeGreaterThan(doc.wires.length / 2);
      const sum = (plans: Point[][]) => fair.reduce((s, i) => s + bends(plans[i]), 0);
      expect(sum(routed[name].routes.map((r) => r.plan))).toBeLessThanOrEqual(sum(old));
    });
  }

  test('on every fixture the total bend count stays within 1.7x of ortho.ts (a regression guard for the crowded boards)', () => {
    for (const name of Object.keys(FIXTURES)) {
      const doc = docs[name];
      const old = wirePolylines(doc.wires, doc.packages, doc.board).reduce((s, p) => s + bends(p), 0);
      const now = routed[name].routes.reduce((s, r) => s + bends(r.plan), 0);
      expect(now).toBeLessThanOrEqual(Math.ceil(old * 1.7));
    }
  });

  test('the other wires route round a hand-shaped one', () => {
    const doc = docs.PL1_1;
    const i = routed.PL1_1.routes.findIndex((r) => r.plan.length >= 4);
    const w = doc.wires[i];
    const auto = routed.PL1_1.routes[i].plan;
    const across = auto[1][0] === auto[2][0] ? 0 : 1;
    const shaped = auto.map((p, n) => (n === 1 || n === 2 ? ((across ? [p[0], p[1] + LANE] : [p[0] + LANE, p[1]]) as Point) : p));
    expect(checkPlan(shaped, doc.packages, doc.board)).toBeNull();
    const again = routeWires(doc, { [wireKey(w)]: planToPath(w, shaped)! });
    expect(again.routes[i].plan).toEqual(shaped);
    expect(clashes(again.routes.map((r) => r.plan), again.routes.map((_, n) => n), nets(doc))).toEqual([]);
  });
});

describe('lane packing', () => {
  const run = (wire: number, lo: number, hi: number, loSide: number, hiSide: number): Run => ({ wire, seg: 1, lo, hi, loSide, hiSide });
  const all = () => true;
  const lanesOf = (m: Map<Run, number>) => [...m.entries()].sort(([a], [b]) => a.wire - b.wire).map(([, l]) => l);

  test('a run that peels off upward inside another takes the upper lane, and downward the lower', () => {
    expect(peelOrder(run(1, 20, 80, -1, -1), run(0, 0, 100, 1, 1))).toBe(1);
    expect(peelOrder(run(1, 20, 80, 1, 1), run(0, 0, 100, -1, -1))).toBe(-1);
    const [outer, inner] = lanesOf(packLine([run(0, 0, 100, 1, 1), run(1, 20, 80, -1, -1)], all));
    expect(inner).toBeLessThan(outer);
    const [o2, i2] = lanesOf(packLine([run(0, 0, 100, -1, -1), run(1, 20, 80, 1, 1)], all));
    expect(i2).toBeGreaterThan(o2);
  });

  test('a bundle of three that peel off downward one after another nests without crossing, centred on the line', () => {
    // In from the left along the line, out downward at 40, 60 and 80: the
    // first to leave must be the lowest, or the others would cut across it.
    const runs = [run(0, 0, 80, -1, 1), run(1, 0, 60, -1, 1), run(2, 0, 40, -1, 1)];
    const lanes = packLine(runs, all);
    const l = (w: number) => lanes.get(runs[w])!;
    expect(l(2)).toBeGreaterThan(l(1));
    expect(l(1)).toBeGreaterThan(l(0));
    expect([l(0), l(1), l(2)].sort()).toEqual([-1, 0, 1]);
  });

  test('runs that do not overlap share a lane, and a blocked lane slides the bundle', () => {
    expect(lanesOf(packLine([run(0, 0, 40, 1, 1), run(1, 50, 90, 1, 1)], all))).toEqual([0, 0]);
    expect(lanesOf(packLine([run(0, 0, 40, 1, 1)], (lane) => lane !== 0))).toEqual([-1]);
  });
});
