import { describe, expect, test } from 'bun:test';
import { ARC_STEP, BEND_R, centreLine, dist, dropCollinear, fillet, mergeTubes, pathLength, STRIP, trim, tubeData, wireShape, type TubeData, type V3 } from '../client/wiretube-math.ts';
import { HUMP, rise, WIRE_D, WIRE_R, type Point } from '../src/render/route3d.ts';

const OPTS = { base: WIRE_R, endY: -4, top: 0, radius: WIRE_R, core: 2.1, sides: 10, coreSides: 8 };
/** A typical jumper: up out of a hole, along a corridor, down into another. */
const Z: Point[] = [[40, 84], [40, 93], [220, 93], [220, 84]];

const vertexCount = (t: TubeData) => t.positions.length / 3;

describe('centreLine', () => {
  test('goes up out of each hole, lies at the base height, and keeps only its corners', () => {
    const line = centreLine(Z, [], WIRE_R, -4);
    expect(line).toEqual([[40, -4, 84], [40, WIRE_R, 84], [40, WIRE_R, 93], [220, WIRE_R, 93], [220, WIRE_R, 84], [220, -4, 84]]);
  });

  test('a lift raises the line by its height over the middle third of two pitches', () => {
    const line = centreLine([[40, 84], [40, 93], [400, 93], [400, 84]], [{ at: 189, height: WIRE_D }], WIRE_R, -4);
    const top = Math.max(...line.map((p) => p[1]));
    expect(top).toBe(WIRE_R + WIRE_D);
    // The crossing is 180 along the run from x = 40; the hump is level within a third of a pitch-and-a-half either side.
    const high = line.filter((p) => p[1] === top).map((p) => p[0]);
    expect(Math.min(...high)).toBeCloseTo(220 - 6, 5);
    expect(Math.max(...high)).toBeCloseTo(220 + 6, 5);
  });

  test('a taller hump is longer, not steeper, and two that overlap are drawn with their valley, not a chord across it', () => {
    const plan: Point[] = [[40, 84], [40, 93], [400, 93], [400, 84]];
    const lifts = [{ at: 180, height: WIRE_D }, { at: 208, height: 2 * WIRE_D }];
    const line = centreLine(plan, lifts, 0, -4).filter((p) => p[2] === 93);
    // Every point of the flat part is rise() exactly, and so is every point between them.
    for (const p of line) expect(p[1]).toBeCloseTo(rise(lifts, p[0] - 31), 9);
    for (let i = 0; i + 1 < line.length; i++) {
      const mid = (line[i][0] + line[i + 1][0]) / 2;
      expect((line[i][1] + line[i + 1][1]) / 2).toBeCloseTo(rise(lifts, mid - 31), 9);
    }
    // Same gradient on both humps: the taller one's foot is twice as far out.
    expect(rise([{ at: 0, height: 2 * WIRE_D }], HUMP / 3 + 2 * (HUMP * (2 / 3)))).toBe(0);
    expect(rise([{ at: 0, height: 2 * WIRE_D }], HUMP / 3 + (HUMP * (2 / 3)))).toBeCloseTo(WIRE_D, 9);
  });
});

describe('dropCollinear', () => {
  test('removes points on a straight line and repeats, keeps the ends and the turns', () => {
    expect(dropCollinear([[0, 0, 0], [1, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 5], [2, 0, 9]])).toEqual([[0, 0, 0], [2, 0, 0], [2, 0, 9]]);
  });
});

describe('fillet', () => {
  test('a square corner with room becomes a quarter circle of the bend radius, one sample per 15 degrees', () => {
    const out = fillet([[0, 0, 0], [50, 0, 0], [50, 0, 50]], () => BEND_R);
    expect(out.length).toBe(2 + Math.ceil(Math.PI / 2 / ARC_STEP) + 1);
    const arc = out.slice(1, -1);
    const centre: V3 = [50 - BEND_R, 0, BEND_R];
    for (const p of arc) expect(dist(p, centre)).toBeCloseTo(BEND_R, 6);
    expect(arc[0]).toEqual([50 - BEND_R, 0, 0]);
    expect(arc[arc.length - 1][0]).toBeCloseTo(50, 9);
    expect(arc[arc.length - 1][2]).toBeCloseTo(BEND_R, 9);
  });

  test('a corner between short runs is clamped to half of each and stays a true arc inside them', () => {
    const out = fillet([[0, 0, 0], [4, 0, 0], [4, 0, 4]], () => 10);
    const arc = out.slice(1, -1);
    // d = min(10, 2, 2) = 2, so r = 2 for a right angle.
    for (const p of arc) expect(dist(p, [2, 0, 2])).toBeCloseTo(2, 6);
    for (const p of arc) expect(p[0] >= -1e-9 && p[0] <= 4 + 1e-9 && p[2] >= -1e-9 && p[2] <= 4 + 1e-9).toBe(true);
  });

  test('the filleted line is never longer than the corner it rounds, and is continuous', () => {
    const raw = centreLine(Z, [], WIRE_R, -4);
    const out = fillet(raw, () => BEND_R);
    expect(pathLength(out)).toBeLessThan(pathLength(raw));
    for (let i = 1; i < out.length; i++) expect(dist(out[i - 1], out[i])).toBeLessThanOrEqual(180 + 1e-9);
  });
});

describe('trim', () => {
  test('cuts a line at two distances along it, interpolating the cut points', () => {
    const t = trim([[0, 0, 0], [10, 0, 0], [10, 0, 10]], 5, 15);
    expect(t).toEqual([[5, 0, 0], [10, 0, 0], [10, 0, 5]]);
    expect(pathLength(t)).toBeCloseTo(10, 9);
  });
});

describe('tubeData', () => {
  test('one ring per sample, every ring joined to the next, faces looking outwards', () => {
    const line = fillet(centreLine(Z, [], WIRE_R, -4), () => BEND_R);
    const t = tubeData(line, WIRE_R, 10);
    expect(vertexCount(t)).toBe(line.length * 11);
    expect(t.indices.length).toBe((line.length - 1) * 10 * 6);
    for (let k = 0; k < t.indices.length; k += 3) {
      const [a, b, c] = [t.indices[k], t.indices[k + 1], t.indices[k + 2]].map((i) => [t.positions[i * 3], t.positions[i * 3 + 1], t.positions[i * 3 + 2]] as V3);
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const face: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const i = t.indices[k];
      const nrm: V3 = [t.normals[i * 3], t.normals[i * 3 + 1], t.normals[i * 3 + 2]];
      expect(face[0] * nrm[0] + face[1] * nrm[1] + face[2] * nrm[2]).toBeGreaterThan(0);
    }
  });

  test('every ring vertex sits one radius from its centre, and the seam faces the board on a flat run', () => {
    const line = fillet(centreLine(Z, [], WIRE_R, -4), () => BEND_R);
    const t = tubeData(line, WIRE_R, 10);
    line.forEach((c, i) => {
      for (let j = 0; j <= 10; j++) {
        const v = (i * 11 + j) * 3;
        expect(dist([t.positions[v], t.positions[v + 1], t.positions[v + 2]], c)).toBeCloseTo(WIRE_R, 4);
      }
    });
    const mid = line.findIndex((p) => p[0] > 100);
    expect(t.normals[mid * 11 * 3 + 1]).toBeCloseTo(-1, 4);
  });

  test('caps close both ends', () => {
    const t = tubeData([[0, 4, 0], [50, 4, 0]], WIRE_R, 10, true);
    expect(vertexCount(t)).toBe(2 * 11 + 2 * 12);
    expect(t.indices.length).toBe(10 * 6 + 2 * 10 * 3);
  });

  test('merging two tubes shifts the second one\'s indices', () => {
    const a = tubeData([[0, 0, 0], [0, 10, 0]], 1, 4);
    const m = mergeTubes(a, a);
    expect(vertexCount(m)).toBe(2 * vertexCount(a));
    expect(m.indices[a.indices.length]).toBe(a.indices[0] + vertexCount(a));
  });
});

describe('wireShape', () => {
  test('a two-bend jumper stays inside the vertex budget', () => {
    const w = wireShape(Z, [], OPTS);
    expect(vertexCount(w.jacket) + vertexCount(w.tin)).toBeLessThanOrEqual(450);
    expect(vertexCount(w.jacket)).toBeLessThanOrEqual(400);
  });

  test('the jacket stops STRIP above the board at each end, the bare ends reach into the holes', () => {
    const w = wireShape(Z, [], OPTS);
    const bare = OPTS.top - OPTS.endY + STRIP;
    const jacketLine = trim(w.line, bare, w.length - bare);
    expect(pathLength(jacketLine)).toBeCloseTo(w.length - 2 * bare, 6);
    const lowest = Math.min(...Array.from({ length: w.tin.positions.length / 3 }, (_, i) => w.tin.positions[i * 3 + 1]));
    expect(lowest).toBeCloseTo(OPTS.endY, 4);
  });
});

describe('robustness', () => {
  const ringsOk = (t: TubeData, radius: number, centres: V3[], sides: number) => {
    const ring = sides + 1;
    for (let v = 0; v < t.positions.length / 3; v++) {
      const n = Math.hypot(t.normals[v * 3], t.normals[v * 3 + 1], t.normals[v * 3 + 2]);
      expect(n).toBeCloseTo(1, 4);
    }
    // Every vertex is a radius away from some centre.
    for (let i = 0; i < centres.length && (i + 1) * ring <= t.positions.length / 3; i++) {
      const v = i * ring * 3;
      expect(dist([t.positions[v], t.positions[v + 1], t.positions[v + 2]], centres[i])).toBeCloseTo(radius, 4);
    }
  };

  test('a lone vertical tube keeps a real frame', () => {
    const c: V3[] = [[0, -4, 0], [0, 20, 0]];
    ringsOk(tubeData(c, 2, 6), 2, c, 6);
  });

  for (const base of [20, 40]) {
    test(`with the base raised to ${base} the tinned ends still have unit normals and a radius`, () => {
      const w = wireShape(Z, [], { ...OPTS, base });
      expect(vertexCount(w.tin)).toBeGreaterThan(0);
      for (let v = 0; v < vertexCount(w.tin); v++) {
        expect(Math.hypot(w.tin.normals[v * 3], w.tin.normals[v * 3 + 1], w.tin.normals[v * 3 + 2])).toBeCloseTo(1, 4);
      }
      // The first ring lies 2.1 from the line's first point.
      const first: V3 = w.line[0];
      const v = 0;
      expect(dist([w.tin.positions[v], w.tin.positions[v + 1], w.tin.positions[v + 2]], first)).toBeCloseTo(OPTS.core, 4);
    });
  }

  test('a half-unit plan and empty ranges never throw', () => {
    const w = wireShape([[40, 84], [40, 84.5]], [], OPTS);
    expect(w.length).toBeGreaterThan(0);
    expect(w.jacket.indices.length % 3).toBe(0);
    expect(trim([[0, 0, 0], [10, 0, 0]], 5, 5)).toEqual([]);
    expect(trim([[0, 0, 0], [10, 0, 0]], 6, 5)).toEqual([]);
    expect(tubeData([[0, 0, 0]], 1, 6).positions.length).toBe(0);
    expect(tubeData([[0, 0, 0], [0, 0, 0]], 1, 6).indices.length).toBe(0);
  });
});
