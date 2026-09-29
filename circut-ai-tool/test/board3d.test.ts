import { describe, expect, test } from 'bun:test';
import { archHeight, archY, chipLegend, MAX_ARCH, routeWire, WIRE_CLEARANCE, type Obstacle } from '../client/board3d-parts.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { readFixture } from './smoke.test.ts';

type Point = [number, number];

// A chip standing 26.7 units tall across the gutter, ten columns wide.
const chip: Obstacle = { x0: 200, x1: 380, z0: 146, z1: 202, top: 26.7 };
// A 5 mm LED, which towers over any chip.
const led: Obstacle = { x0: 600, x1: 660, z0: 220, z1: 280, top: 66 };

/** Where the drawn jumper runs, in plan and height, at t along its curve. */
function pointAt(a: Point, b: Point, control: Point, height: number, t: number) {
  const u = 1 - t;
  return {
    x: u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
    z: u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
    y: archY(height, t),
  };
}

/** The worst gap between a drawn jumper and anything standing under it. */
function tightestGap(a: Point, b: Point, plan: Point, obstacles: Obstacle[]): number {
  const { control, height } = routeWire(a, b, plan, obstacles);
  let worst = Infinity;
  // Only the run itself; the last stretch into each hole is meant to go down.
  for (let k = 0; k <= 200; k++) {
    const t = 0.1 + (0.8 * k) / 200;
    const p = pointAt(a, b, control, height, t);
    for (const o of obstacles) {
      if (p.x < o.x0 || p.x > o.x1 || p.z < o.z0 || p.z > o.z1) continue;
      worst = Math.min(worst, p.y - o.top);
    }
  }
  return worst;
}

describe('archHeight', () => {
  test('a jumper over open board keeps a gentle bow', () => {
    const height = archHeight([40, 84], [240, 84], [140, 74], []);
    expect(archY(height, 0.5)).toBeGreaterThan(4);
    expect(archY(height, 0.5)).toBeLessThan(23);
  });

  test('a jumper straight over a chip clears its roof', () => {
    expect(tightestGap([120, 174], [460, 174], [290, 174], [chip])).toBeGreaterThan(WIRE_CLEARANCE - 3);
  });

  test('an obstacle off to one side is cleared too, not just one at the peak', () => {
    // The case a peak-only rule gets wrong: three quarters of the way along,
    // a curve sized for its own apex has already come back down. Here the
    // chip sits in the last third of a long run.
    const late: Obstacle = { x0: 380, x1: 520, z0: 146, z1: 202, top: 26.7 };
    expect(tightestGap([40, 174], [700, 174], [370, 174], [late])).toBeGreaterThan(0);
  });

  test('the same chip costs more height off to one side than under the middle', () => {
    // The property that makes the case above work: sizing the loop by its own
    // apex is not enough, because the curve is lower everywhere else.
    const middle: Obstacle = { x0: 330, x1: 410, z0: 146, z1: 202, top: 26.7 };
    const late: Obstacle = { x0: 560, x1: 640, z0: 146, z1: 202, top: 26.7 };
    const run: [Point, Point, Point] = [[40, 174], [700, 174], [370, 174]];
    expect(archHeight(...run, [late])).toBeGreaterThan(archHeight(...run, [middle]));
  });

  test('the taller the thing under it, the higher it goes', () => {
    const overChip = archHeight([160, 174], [420, 174], [290, 174], [chip]);
    const overLed = archHeight([560, 250], [700, 250], [630, 250], [led]);
    expect(overLed).toBeGreaterThan(overChip);
  });

  test('a jumper leaving the hole beside a chip is not dragged over its roof', () => {
    const leaving = archHeight([205, 174], [20, 174], [112, 174], [chip]);
    const across = archHeight([120, 174], [460, 174], [290, 174], [chip]);
    expect(leaving).toBeLessThan(across);
    expect(archY(leaving, 0.5)).toBeLessThan(chip.top);
  });

  test('an obstacle the path misses changes nothing', () => {
    const a: Point = [40, 84];
    const b: Point = [240, 84];
    const c: Point = [140, 74];
    expect(archHeight(a, b, c, [led])).toBe(archHeight(a, b, c, []));
  });

  test('the loop is capped, so one awkward part cannot produce an absurd arch', () => {
    const wall: Obstacle = { x0: 0, x1: 2000, z0: 0, z1: 400, top: 400 };
    expect(archHeight([40, 84], [240, 84], [140, 84], [wall])).toBeLessThanOrEqual(MAX_ARCH);
  });
});

describe('routeWire', () => {
  test('keeps the bow the flat board drew whenever flying over works', () => {
    const plan: Point = [290, 200];
    const route = routeWire([120, 174], [460, 174], plan, [chip]);
    expect(route.control).toEqual(plan);
    expect(route.height).toBeLessThan(MAX_ARCH);
  });

  test('bows the other way when going over would need an absurd loop', () => {
    // A tall part sitting where the flat board's bow would take the wire, and
    // too near the end of the run to fly over.
    const tall: Obstacle = { x0: 480, x1: 546, z0: 226, z1: 267, top: 66 };
    const plan: Point = [400, 249];
    const route = routeWire([238, 228], [562, 228], plan, [tall]);
    expect(route.control).not.toEqual(plan);
    // Mirrored about the chord, so it passes the other side of the part.
    expect(route.control).toEqual([400, 207]);
    expect(route.height).toBeLessThan(MAX_ARCH);
  });

  test('does not swap for a bow that is no better', () => {
    // An obstacle straddling the run: neither side helps, so nothing changes.
    const wall: Obstacle = { x0: 0, x1: 2000, z0: 0, z1: 400, top: 400 };
    const plan: Point = [400, 249];
    expect(routeWire([238, 228], [562, 228], plan, [wall]).control).toEqual(plan);
  });
});

describe('the jumpers on a real board', () => {
  const doc = buildLayoutDoc(parseNetlist(readFixture('PL1_1.net')), emptySidecar());
  const MM = 18 / 2.54;
  const hx = (h: { col: number }) => 40 + (h.col - 1) * 18;
  const ROW: Record<string, number> = { 'T+': 30, 'T-': 48, a: 84, b: 102, c: 120, d: 138, e: 156, f: 192, g: 210, h: 228, i: 246, j: 264, 'B-': 300, 'B+': 318 };
  const hz = (h: { row: string }) => ROW[h.row];

  // The same solids board3d builds, so this asks about what is actually drawn.
  const obstacles: Obstacle[] = [
    ...doc.packages.map((p) => {
      const xs = Object.values(doc.pinHoles[p.id] ?? {}).map(hx);
      return { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, z0: ROW.e - 10, z1: ROW.f + 10, top: 1.2 + 3.6 * MM + 0.5 };
    }),
    ...doc.parts.map((p) => {
      const xs = p.holes.map(hx);
      const zs = p.holes.map(hz);
      const isLed = p.style === 'LED';
      const r = isLed ? 2.9 * MM : 1.2 * MM;
      return { x0: Math.min(...xs) - r, x1: Math.max(...xs) + r, z0: Math.min(...zs) - r, z1: Math.max(...zs) + r, top: isLed ? 9.3 * MM : 9 + 1.2 * MM };
    }),
  ];

  test('none of them passes through a chip or a part', () => {
    const through: string[] = [];
    for (const [i, w] of doc.wires.entries()) {
      const a: Point = [hx(w.a), hz(w.a)];
      const b: Point = [hx(w.b), hz(w.b)];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const gap = tightestGap(a, b, mid, obstacles);
      if (gap < 0) through.push(`wire ${i} by ${gap.toFixed(1)}`);
    }
    expect(through).toEqual([]);
  });
});

describe('chipLegend', () => {
  const doc = buildLayoutDoc(parseNetlist(readFixture('PL1_1.net')), emptySidecar());

  test('names the part and says what it does, which is the point of the label', () => {
    const byRef = Object.fromEntries(doc.packages.map((p) => [p.id, chipLegend(p, doc)]));
    expect(byRef.U1).toEqual({ code: '74LS86', description: 'quad 2-input XOR' });
    expect(byRef.U2).toEqual({ code: '74LS04', description: 'hex inverter' });
    expect(byRef.U3).toEqual({ code: '74LS00', description: 'quad 2-input NAND' });
  });

  test('a part with no entry in the catalogue still gets its number', () => {
    const d = makeDesign({
      U9: { lib: '74xx', part: '74LS99', value: '74LS99', pins: Object.fromEntries([...Array(14)].map((_, i) => [String(i + 1), ['~', 'passive', i === 6 ? 'GND' : i === 13 ? '+5V' : `/N${i}`] as [string, string, string]])) },
    });
    const res = layout(d, emptySidecar());
    const pkg = res.packages.find((p) => p.id === 'U9')!;
    expect(chipLegend(pkg, { ...doc, values: res.values } as never)).toEqual({ code: '74LS99', description: '' });
  });
});
