import { describe, expect, test } from 'bun:test';
import { archY, CROSS_GAP, liftCrossings, MAX_ARCH, planAt, type Span } from '../src/render/altitude.ts';

const span = (a: [number, number], b: [number, number], control: [number, number], height = 20): Span => ({ a, b, control, height });

/** The smallest vertical gap between two wires wherever they meet in plan. */
function tightestCrossing(x: Span, y: Span, hx: number, hy: number): number {
  let gap = Infinity;
  for (let i = 0; i <= 200; i++) {
    const ti = i / 200;
    const px = planAt(x, ti);
    for (let j = 0; j <= 200; j++) {
      const tj = j / 200;
      const py = planAt(y, tj);
      if (Math.hypot(px[0] - py[0], px[1] - py[1]) > 3) continue;
      gap = Math.min(gap, Math.abs(archY(hx, ti) - archY(hy, tj)));
    }
  }
  return gap;
}

describe('planAt', () => {
  test('runs from one hole to the other', () => {
    const s = span([0, 0], [100, 0], [50, 20]);
    expect(planAt(s, 0)).toEqual([0, 0]);
    expect(planAt(s, 1)).toEqual([100, 0]);
  });

  test('bows towards the control point at the middle', () => {
    const s = span([0, 0], [100, 0], [50, 40]);
    // A quadratic reaches half its control offset.
    expect(planAt(s, 0.5)[1]).toBeCloseTo(20, 6);
  });
});

describe('liftCrossings', () => {
  test('leaves wires that never meet at the height they came in with', () => {
    const wires = [span([0, 0], [100, 0], [50, 0], 18), span([0, 300], [100, 300], [50, 300], 24)];
    expect(liftCrossings(wires)).toEqual([18, 24]);
  });

  test('never lowers a wire below the height that clears its obstacles', () => {
    const wires = [span([0, 100], [200, 100], [100, 100], 30), span([100, 0], [100, 200], [100, 100], 30)];
    const out = liftCrossings(wires);
    for (const [i, h] of out.entries()) expect(h).toBeGreaterThanOrEqual(wires[i].height);
  });

  test('opens real air between two wires that cross', () => {
    const a = span([0, 100], [200, 100], [100, 100], 30);
    const b = span([100, 0], [100, 200], [100, 100], 30);
    const [ha, hb] = liftCrossings([a, b]);
    expect(tightestCrossing(a, b, ha, hb)).toBeGreaterThanOrEqual(CROSS_GAP - 0.5);
  });

  test('separates all three of a mutual crossing, pair by pair', () => {
    const wires = [
      span([0, 100], [200, 100], [100, 100], 26),
      span([100, 0], [100, 200], [100, 100], 26),
      span([20, 20], [180, 180], [100, 100], 26),
    ];
    const out = liftCrossings(wires);
    for (let i = 0; i < wires.length; i++) {
      for (let j = i + 1; j < wires.length; j++) {
        expect(tightestCrossing(wires[i], wires[j], out[i], out[j])).toBeGreaterThanOrEqual(CROSS_GAP - 0.5);
      }
    }
  });

  test('is a pure function of its input', () => {
    const wires = [span([0, 100], [200, 100], [100, 100], 30), span([100, 0], [100, 200], [100, 100], 30), span([0, 0], [200, 200], [100, 60], 22)];
    expect(liftCrossings(wires)).toEqual(liftCrossings(wires));
    const heights = wires.map((w) => w.height);
    liftCrossings(wires);
    expect(wires.map((w) => w.height)).toEqual(heights);
  });

  test('raises the wire that is already higher, so the lower one keeps its run', () => {
    // Close enough at the crossing that one of them has to give way.
    const low = span([0, 100], [200, 100], [100, 100], 20);
    const high = span([100, 0], [100, 200], [100, 100], 24);
    const [hLow, hHigh] = liftCrossings([low, high]);
    expect(hLow).toBe(20);
    expect(hHigh).toBeGreaterThan(24);
    expect(tightestCrossing(low, high, hLow, hHigh)).toBeGreaterThanOrEqual(CROSS_GAP - 0.5);
  });

  test('never pushes a wire through the ceiling', () => {
    // Twelve wires all crossing at one point cannot all be separated; the
    // planner has to give up at the ceiling rather than build a tower.
    const wires = Array.from({ length: 12 }, (_, i) => span([0, i], [200, 200 - i], [100, 100], 120));
    for (const h of liftCrossings(wires)) expect(h).toBeLessThanOrEqual(MAX_ARCH);
  });

  test('costs a board-sized wire list little enough to run at mount', () => {
    const wires = Array.from({ length: 60 }, (_, i) => span([i * 7, 0], [200 - i * 3, 300], [100, 150 + i], 20 + (i % 5)));
    const t0 = performance.now();
    liftCrossings(wires);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
