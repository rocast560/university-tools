import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { holeKey } from '../src/layout/board.ts';
import { normalizeSidecar, type Sidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';
import { centreLines, clipPairs, lineDistance } from '../src/render/clearance.ts';
import { tierOf } from '../src/render/geometry.ts';
import { AIR_Z, liftCrossings, planLength, rise, WIRE_D, type Point, type WireRoute } from '../src/render/route3d.ts';
import { FIXTURES } from './route-fixtures.ts';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const square = (x: unknown = {}): Sidecar => {
  const s = normalizeSidecar(x);
  s.options.wireStyle = 'orthogonal';
  return s;
};
const lab6 = buildLayoutDoc(parseNetlist(read('test/fixtures/lab6.net')), square(JSON.parse(read('test/fixtures/lab6.breadboard.json'))));
const route = (plan: Point[]): WireRoute => ({ plan, lifts: [] });

describe('clipPairs', () => {
  // Two wires lying flat across each other.
  const across = () => [route([[100, 200], [100, 150], [300, 150], [300, 200]]), route([[200, 50], [200, 250]])];

  test('two flat wires crossing clip', () => {
    const pairs = clipPairs({ routes: across() });
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toMatchObject({ a: 0, b: 1 });
    expect(pairs[0].distance).toBeLessThan(1);
  });

  test('one humped a diameter and a little air over the other does not', () => {
    const routes = across();
    routes[1].lifts.push({ at: 100, height: WIRE_D + AIR_Z });
    expect(clipPairs({ routes })).toEqual([]);
  });
});

describe('humps', () => {
  test('a crossing on the lower wire’s ramp clears its whole hump, not just the height where they cross', () => {
    // 0 lies flat; 1 humps over it at 100 along; 2 crosses 1 nine units short of that, on the ramp.
    const make = () => [
      route([[100, 200], [100, 150], [300, 150], [300, 200]]),
      route([[200, 50], [200, 250]]),
      route([[120, 60], [120, 141], [280, 141], [280, 60]]),
    ];
    // The old rule, measured at the crossing alone: one diameter over the ramp's height there.
    const old = make();
    old[1].lifts.push({ at: 100, height: WIRE_D });
    old[2].lifts.push({ at: 81 + 80, height: WIRE_D + rise(old[1].lifts, 91) });
    const before = clipPairs({ routes: old });
    expect(before.map((p) => [p.a, p.b])).toEqual([[1, 2]]);
    expect(before[0].distance).toBeLessThan(WIRE_D);

    const routes = make();
    liftCrossings(routes, [0, 1, 2]);
    expect(routes[2].lifts.length).toBe(1);
    expect(clipPairs({ routes })).toEqual([]);
    const lines = centreLines(routes);
    expect(lineDistance(lines[1], lines[2])[0]).toBeGreaterThanOrEqual(WIRE_D);
  });

  test('a hump near the top of the lower wire’s ramp rises only as far as clearing it all round needs', () => {
    // 1 humps over 0 at 100 along; 2 crosses 1 fourteen short of that, where 1 is 3.67 up its ramp.
    // A full diameter and air over the highest point of 1 within reach would be 18.
    const routes = [
      route([[100, 200], [100, 150], [300, 150], [300, 200]]),
      route([[200, 50], [200, 250]]),
      route([[120, 60], [120, 136], [280, 136], [280, 60]]),
    ];
    liftCrossings(routes, [0, 1, 2]);
    expect(routes[1].lifts).toEqual([{ at: 100, height: WIRE_D + AIR_Z }]);
    expect(routes[2].lifts.length).toBe(1);
    expect(routes[2].lifts[0].height).toBeLessThanOrEqual(15);
    expect(clipPairs({ routes }, WIRE_D + AIR_Z)).toEqual([]);
  });

  test('a wire sharing a stretch of another’s line humps over all of it', () => {
    const routes = [route([[100, 200], [100, 150], [300, 150], [300, 200]]), route([[150, 60], [150, 150], [250, 150], [250, 60]])];
    expect(clipPairs({ routes }).length).toBe(1);
    liftCrossings(routes, [0, 1]);
    expect(routes[0].lifts).toEqual([]);
    expect(routes[1].lifts.length).toBeGreaterThan(1);
    expect(clipPairs({ routes })).toEqual([]);
  });

  test('a wire lying along another that is itself humping clears it a diameter and air all along', () => {
    // 1 humps over 0 at x = 200; 2 lies along 1’s line across that hump and turns away on its ramp.
    const routes = [route([[200, 50], [200, 250]]), route([[100, 200], [100, 150], [300, 150], [300, 200]]), route([[150, 60], [150, 150], [212, 150], [212, 60]])];
    liftCrossings(routes, [0, 1, 2]);
    expect(clipPairs({ routes }, WIRE_D + AIR_Z)).toEqual([]);
  });

  test('two wires turning at the same point: the later one humps', () => {
    const routes = [route([[100, 300], [100, 200], [200, 200], [200, 300]]), route([[300, 300], [300, 200], [200, 200], [200, 100]])];
    expect(clipPairs({ routes }).length).toBe(1);
    liftCrossings(routes, [0, 1]);
    expect(clipPairs({ routes })).toEqual([]);
  });
});

describe('real boards', () => {
  const wireNamed = (doc: LayoutDoc, net: string, holes: string) => doc.wires.findIndex((w) => w.net === net && `${holeKey(w.a)}-${holeKey(w.b)}` === holes);

  test('lab 6: the same-net pairs that shared a bend are a diameter apart', () => {
    const lines = centreLines(lab6.routes!);
    for (const [net, a, b] of [
      ['Net-(U2-S1)', 'c74-g77', 'h77-d77'],
      ['Net-(U1-C0)', 'c52-g55', 'h55-d55'],
    ]) {
      const [i, j] = [wireNamed(lab6, net, a), wireNamed(lab6, net, b)];
      expect(i).toBeGreaterThanOrEqual(0);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(lineDistance(lines[i], lines[j])[0]).toBeGreaterThanOrEqual(WIRE_D);
    }
  });

  // Wires joining the two boards are laid a lane from every other wire and
  // hump over what they cross, in one lift pass with all the others.
  test('lab 6 (stacked): no jumper clips another', () => {
    expect(lab6.board.kind).toBe('stacked');
    expect(clipPairs(lab6)).toEqual([]);
  });

  test('lab 6 (stacked): no jumper comes within a diameter and air of another', () => {
    expect(clipPairs(lab6, WIRE_D + AIR_Z)).toEqual([]);
  });

  // The tallest hump on each board, so humps that grow taller than clearing needs fail here.
  const tallest: Record<string, number> = { PL1_1: 17.5, lab3: 28.8, 'lab4-74ls08': 20.3, 'lab4-decoder': 9 };
  // Each single board's total bends and length (stacked boards' changes must not move these).
  const totals: Record<string, [number, number]> = { PL1_1: [42, 3366], lab3: [212, 21204], 'lab4-74ls08': [62, 5742], 'lab4-decoder': [68, 6714] };
  const maxLift = (routes: WireRoute[]) => Math.max(0, ...routes.flatMap((r) => r.lifts.map((l) => l.height)));

  test('lab 6: the tallest hump on wires within one board', () => {
    const cross = (i: number) => tierOf(lab6.board, lab6.wires[i].a.col) !== tierOf(lab6.board, lab6.wires[i].b.col);
    expect(maxLift(lab6.routes!.filter((_, i) => !cross(i)))).toBeLessThanOrEqual(26.0 + 0.05);
  });

  // Wires joining the two boards keep a lane from every other wire, which on
  // lab 6 costs some bends and length over the old overlapping bundles (224
  // bends, 40904 long): the trade-off the user chose. Regression ceilings.
  test('lab 6: the tallest hump on any wire', () => {
    // A jumper joining the boards can pass over a wire that is already humping over a third.
    expect(maxLift(lab6.routes!)).toBeLessThanOrEqual(34.5);
  });

  test('lab 6: total bends and length stay within what the user accepted', () => {
    const plans = lab6.routes!.map((r) => r.plan);
    expect(plans.reduce((n, p) => n + p.length - 2, 0)).toBeLessThanOrEqual(270);
    expect(plans.reduce((n, p) => n + planLength(p), 0)).toBeLessThanOrEqual(44700);
  });

  for (const [name, file] of Object.entries(FIXTURES)) {
    test(`${name} with square wires: no jumper comes within a diameter and air of another, and humps stay low`, () => {
      const doc = buildLayoutDoc(parseNetlist(read(file)), square());
      expect(doc.routes?.length).toBe(doc.wires.length);
      expect(clipPairs(doc)).toEqual([]);
      expect(clipPairs(doc, WIRE_D + AIR_Z)).toEqual([]);
      expect(maxLift(doc.routes!)).toBeLessThanOrEqual(tallest[name] + 0.05);
    });

    test(`${name} with square wires: total bends and length are exactly what they were`, () => {
      const plans = buildLayoutDoc(parseNetlist(read(file)), square()).routes!.map((r) => r.plan);
      expect(plans.reduce((n, p) => n + p.length - 2, 0)).toBe(totals[name][0]);
      expect(Math.round(plans.reduce((n, p) => n + planLength(p), 0))).toBe(totals[name][1]);
    });
  }
});
