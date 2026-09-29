import { describe, expect, test } from 'bun:test';
import { addBendPair, handles, moveBend, moveSegment, nearestRun, removeBend, snapAcross } from '../src/edit/wireshape.ts';
import { P, ROWY, X0 } from '../src/render/geometry.ts';
import { LANE, ROW_YS, type Point } from '../src/render/route3d.ts';

// Hole a12 up into corridor T-|a, along to column 20, down into a20.
const x = (col: number) => X0 + (col - 1) * P;
const U: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), ROWY.a]];
/** Square corners, and the first and last runs along the holes' columns. */
const square = (plan: Point[]) => {
  for (let i = 0; i + 1 < plan.length; i++) expect(plan[i][0] === plan[i + 1][0] || plan[i][1] === plan[i + 1][1]).toBe(true);
  expect(plan[0][0]).toBe(plan[1][0]);
  expect(plan[plan.length - 1][0]).toBe(plan[plan.length - 2][0]);
};

describe('snapAcross', () => {
  test('runs across the board snap to corridor lanes, never onto a row of holes', () => {
    expect(snapAcross(true, 66)).toBe(66);
    expect(snapAcross(true, ROWY.c + 1)).not.toBe(ROWY.c);
    for (let y = 0; y < 350; y += 3) expect(ROW_YS.has(snapAcross(true, y))).toBe(false);
  });

  test('runs down the board snap between columns, never onto a column of holes', () => {
    expect(snapAcross(false, x(12))).toBe(x(12) + P / 2);
    expect(snapAcross(false, x(12) - 2)).toBe(x(12) - P / 2);
    expect(snapAcross(false, x(12) + P / 2 + 3)).toBe(x(12) + P / 2);
  });
});

describe('handles', () => {
  test('a segment handle on each run over two pitches, a bend handle on each corner', () => {
    const h = handles(U);
    expect(h.filter((k) => k.kind === 'segment').map((k) => k.index)).toEqual([1]);
    expect(h.find((k) => k.kind === 'segment')!.at).toEqual([(x(12) + x(20)) / 2, 66]);
    expect(h.find((k) => k.kind === 'segment')!.horizontal).toBe(true);
    expect(h.filter((k) => k.kind === 'bend').map((k) => k.index)).toEqual([1, 2]);
  });
});

describe('moveSegment', () => {
  test('a middle run moves across itself and its neighbours stretch', () => {
    const out = moveSegment(U, 1, 57);
    expect(out).toEqual([[x(12), ROWY.a], [x(12), 57], [x(20), 57], [x(20), ROWY.a]]);
  });

  test('a run out of a hole keeps its hole and gets a jog half a pitch out', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 174], [x(20), 174], [x(20), ROWY.j]];
    const out = moveSegment(long, 0, x(12) + P / 2);
    square(out);
    expect(out[0]).toEqual([x(12), ROWY.a]);
    expect(out[1]).toEqual([x(12), ROWY.a + LANE]);
    expect(out[2]).toEqual([x(12) + P / 2, ROWY.a + LANE]);
    expect(out[3]).toEqual([x(12) + P / 2, 174]);
  });

  test('a straight hole-to-hole run jogs out of both ends', () => {
    const out = moveSegment([[x(5), ROWY['T+']], [x(5), ROWY['B+']]], 0, x(5) + P / 2);
    square(out);
    expect(out.length).toBe(6);
    expect(out[0]).toEqual([x(5), ROWY['T+']]);
    expect(out[5]).toEqual([x(5), ROWY['B+']]);
  });
});

describe('moveBend', () => {
  test('a corner takes one coordinate from each of its runs and the path stays square', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(16), 66], [x(16), 111], [x(20), 111], [x(20), ROWY.c]];
    const out = moveBend(long, 2, [x(17) - P / 2 + P, 57]);
    square(out);
    expect(out).toContainEqual([x(17) + P / 2, 57]);
    expect(out[0]).toEqual(long[0]);
    expect(out[out.length - 1]).toEqual(long[long.length - 1]);
  });

  test('a corner next to a hole jogs rather than dragging the hole', () => {
    const out = moveBend(U, 1, [x(12) + P / 2, 57]);
    square(out);
    expect(out[0]).toEqual(U[0]);
    expect(out).toContainEqual([x(12) + P / 2, 57]);
  });
});

describe('addBendPair and removeBend', () => {
  test('a double-click puts a small Z in a run; removing either new corner takes the pair out again', () => {
    const z = addBendPair(U, 1, [x(16), 66]);
    square(z);
    expect(z.length).toBe(U.length + 2);
    expect(z).toContainEqual([x(16), 66]);
    const k = z.findIndex((p) => p[0] === x(16) && p[1] === 66);
    // Either new corner takes the pair out: one leaves the run on the new line, the other puts it back.
    expect(removeBend(z, k + 1)).toEqual(U);
    const other = removeBend(z, k)!;
    square(other);
    expect(other.length).toBe(U.length);
  });

  test('a Z in the run into a hole moves the part away from the hole', () => {
    const long: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), 174], [x(24), 174], [x(24), ROWY.j]];
    const z = addBendPair(long, 4, [x(24), 210]);
    square(z);
    expect(z[z.length - 1]).toEqual(long[long.length - 1]);
    expect(z[z.length - 2][0]).toBe(x(24));
  });

  test('a run too short for a Z (a single half-pitch jog) is left as it is', () => {
    const jog: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(12) + LANE, 66], [x(12) + LANE, 30]];
    expect(addBendPair(jog, 1, [x(12) + 4, 66])).toBe(jog);
  });

  test('a corner that holds a hole-end run on its column cannot be removed', () => {
    expect(removeBend(U, 1)).toBeNull();
    expect(removeBend(U, 0)).toBeNull();
  });

  test('nearestRun picks the run under a point', () => {
    expect(nearestRun(U, [x(15), 70])).toBe(1);
    expect(nearestRun(U, [x(12) - 3, 75])).toBe(0);
  });
});
