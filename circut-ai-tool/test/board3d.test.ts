import { describe, expect, test } from 'bun:test';
import { archHeight, archY, chipLegend, dipLegPath, MAX_ARCH, MM, placedBox, routeWire, WIRE_CLEARANCE, type Obstacle } from '../client/board3d-parts.ts';
import { readFileSync } from 'node:fs';
import { bodyPlacement, modelKeyFor, validateManifest, type ModelInfo } from '../src/models/manifest.ts';
import { holeKey } from '../src/layout/board.ts';
import { placeAt } from '../src/render/geometry.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar, normalizeSidecar, type Hole } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';
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

describe('model bodies', () => {
  test('a DIP leg path ends in its hole, below the board surface', () => {
    const path = dipLegPath({ x: 120, z: 200 }, 180, 22, 2, 25);
    const end = path[path.length - 1];
    expect(end[0]).toBe(120);
    expect(end[2]).toBe(200);
    expect(end[1]).toBeLessThan(0);
    expect(path[0][2]).toBe(180 + 22); // leaves the body side facing its hole
  });

  test('a leg on the far row leaves the far side of the body', () => {
    const path = dipLegPath({ x: 120, z: 150 }, 180, 22, 2, 25);
    expect(path[0][2]).toBe(180 - 22);
    expect(path.every(([x]) => x === 120)).toBe(true);
  });

  test('placedBox turns the model box with the part, so a DIP body straddles its rows', () => {
    const info = {
      file: 'dip14.glb', footprint: '', pads: { '1': [0, 0], '2': [0, 2.54] },
      box: { min: [0.635, 0.38, -1.905], max: [6.985, 3.68, 17.145] },
    } as ModelInfo;
    // Pin 1 at the origin, pin 2 one pitch along +x: the model's z (its pin row) turns onto board x.
    const p = bodyPlacement(info, '1', '2', [0, 0], [18, 0], MM);
    const b = placedBox(info, p, MM);
    const near = (a: number, e: number) => expect(Math.abs(a - e)).toBeLessThan(1e-6);
    near(b.x0, -1.905 * MM);
    near(b.x1, 17.145 * MM);
    near(b.z0, -6.985 * MM);
    near(b.z1, -0.635 * MM);
    near(b.y0, 0.38 * MM);
    near(b.y1, 3.68 * MM);
  });
  test('a DIP body sits midway between both pin rows, squeezed to the drawn gap, with its legs alike on each side', () => {
    // DIP-14 as KiCad has it: pins 1-7 down x = 0, pins 8-14 back up x = 7.62 mm.
    const pads: Record<string, [number, number]> = {};
    for (let i = 0; i < 7; i++) {
      pads[String(i + 1)] = [0, i * 2.54];
      pads[String(14 - i)] = [7.62, i * 2.54];
    }
    const info = { file: 'dip14.glb', footprint: '', pads, box: { min: [0.635, 0.38, -1.905], max: [6.985, 3.68, 17.145] } } as ModelInfo;
    // On the board: pin 1 at row e (z 156), pin 14 across the gutter at row f (z 192), 36 units, not 7.62 mm.
    const holes: Record<string, [number, number]> = {};
    for (let i = 0; i < 7; i++) {
      holes[String(i + 1)] = [100 + i * 18, 192];
      holes[String(14 - i)] = [100 + i * 18, 156];
    }
    const p = bodyPlacement(info, '1', '2', holes['1'], holes['2'], MM, holes);
    const b = placedBox(info, p, MM);
    const near = (a: number, e: number) => expect(Math.abs(a - e)).toBeLessThan(1e-6);
    near((b.z0 + b.z1) / 2, 174);
    near((b.x0 + b.x1) / 2, 100 + 3 * 18);
    // The epoxy's 6.35 mm across 7.62 mm of rows, drawn across 36 units.
    near(b.z1 - b.z0, 36 * (6.35 / 7.62));
    expect(b.z0).toBeGreaterThan(156);
    expect(b.z1).toBeLessThan(192);
    // The far row's pin 14 and the near row's pin 1 leave the body at the same distance.
    const half = (b.z1 - b.z0) / 2;
    const p1 = dipLegPath({ x: 100, z: 192 }, 174, half, b.y0, b.y1 - b.y0);
    const p14 = dipLegPath({ x: 100, z: 156 }, 174, half, b.y0, b.y1 - b.y0);
    near(p1[0][2] - 174, 174 - p14[0][2]);
    expect(p14[p14.length - 1][2]).toBe(156);
    expect(p1[p1.length - 1][2]).toBe(192);
  });
});

describe('KiCad bodies on the real boards', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const manifest = validateManifest(JSON.parse(read('public/models/manifest.json')));
  const boards: [string, LayoutDoc][] = [
    ['lab6', buildLayoutDoc(parseNetlist(read('test/fixtures/lab6.net')), normalizeSidecar(JSON.parse(read('test/fixtures/lab6.breadboard.json'))))],
    ['PL1_1', buildLayoutDoc(parseNetlist(readFixture('PL1_1.net')), normalizeSidecar({}))],
  ];

  for (const [name, doc] of boards)
    test(`${name}: each model body is centred on its pins and covers no other hole`, () => {
      const at = (h: Hole) => placeAt(doc.board, h);
      let checked = 0;
      for (const pkg of doc.packages) {
        const key = modelKeyFor(pkg.kind, undefined, pkg.pins, pkg.positions);
        const info = key ? manifest.models[key] : undefined;
        const own = doc.pinHoles[pkg.id] ?? {};
        if (!info || !own['1'] || !own['2']) continue;
        const holes = Object.fromEntries(Object.entries(own).map(([pin, h]) => [pin, at(h)])) as Record<string, [number, number]>;
        const b = placedBox(info, bodyPlacement(info, '1', '2', holes['1'], holes['2'], MM, holes), MM);
        const pts = Object.values(holes);
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        expect(Math.abs((b.x0 + b.x1) / 2 - cx), `${pkg.id} x`).toBeLessThan(0.5);
        expect(Math.abs((b.z0 + b.z1) / 2 - cz), `${pkg.id} z`).toBeLessThan(0.5);
        // No hole another part's pin or a jumper goes into lies under the body.
        const ownKeys = new Set(Object.values(own).map(holeKey));
        const others: [string, Hole][] = [
          ...doc.packages.filter((q) => q.id !== pkg.id).flatMap((q) => Object.values(doc.pinHoles[q.id] ?? {}).map((h): [string, Hole] => [q.id, h])),
          ...doc.parts.flatMap((p) => p.holes.map((h): [string, Hole] => [p.id, h])),
          ...doc.wires.flatMap((w) => [w.a, w.b].map((h): [string, Hole] => [`wire ${w.net}`, h])),
        ];
        const inside = others
          .filter(([, h]) => !ownKeys.has(holeKey(h)))
          .filter(([, h]) => {
            const [x, z] = at(h);
            return x > b.x0 + 0.5 && x < b.x1 - 0.5 && z > b.z0 + 0.5 && z < b.z1 - 0.5;
          })
          .map(([who, h]) => `${who} ${h.row}${h.col}`);
        expect(inside, `${pkg.id} body covers`).toEqual([]);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
});
