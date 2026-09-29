import { describe, expect, test } from 'bun:test';
import { addBendPair, handles, moveBend, moveSegment, nearestRun, removeBend, snapAcross } from '../src/edit/wireshape.ts';
import { P, ROWY, X0 } from '../src/render/geometry.ts';
import { LANE, ROW_YS, type Point } from '../src/render/route3d.ts';

const COLS = 30;
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
    expect(snapAcross(true, 66, COLS)).toBe(66);
    expect(snapAcross(true, ROWY.c + 1, COLS)).not.toBe(ROWY.c);
    for (let y = 0; y < 350; y += 3) expect(ROW_YS.has(snapAcross(true, y, COLS))).toBe(false);
  });

  test('runs down the board stay within the columns of the board', () => {
    expect(snapAcross(false, -500, COLS)).toBe(X0 - P / 2);
    expect(snapAcross(false, 5000, COLS)).toBe(x(COLS) + P / 2);
  });

  test('runs down the board snap between columns, never onto a column of holes', () => {
    expect(snapAcross(false, x(12), COLS)).toBe(x(12) + P / 2);
    expect(snapAcross(false, x(12) - 2, COLS)).toBe(x(12) - P / 2);
    expect(snapAcross(false, x(12) + P / 2 + 3, COLS)).toBe(x(12) + P / 2);
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
    const z = addBendPair(U, 1, [x(16), 66], COLS);
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
    const z = addBendPair(long, 4, [x(24), 210], COLS);
    square(z);
    expect(z[z.length - 1]).toEqual(long[long.length - 1]);
    expect(z[z.length - 2][0]).toBe(x(24));
  });

  test('a run too short for a Z (a single half-pitch jog) is left as it is', () => {
    const jog: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(12) + LANE, 66], [x(12) + LANE, 30]];
    expect(addBendPair(jog, 1, [x(12) + 4, 66], COLS)).toBe(jog);
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

const collinear = (a: Point, b: Point, c: Point) => (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
/** Everything a result of these edits promises: square, both ends kept with vertical stubs, nothing redundant. */
function wellFormed(plan: Point[], first: Point, last: Point) {
  expect(plan[0]).toEqual(first);
  expect(plan[plan.length - 1]).toEqual(last);
  square(plan);
  for (let i = 0; i + 1 < plan.length; i++) expect(plan[i][0] === plan[i + 1][0] && plan[i][1] === plan[i + 1][1]).toBe(false);
  for (let i = 0; i + 2 < plan.length; i++) expect(collinear(plan[i], plan[i + 1], plan[i + 2])).toBe(false);
}

describe('collapses leave nothing redundant', () => {
  test('moving a run onto the line of its neighbours drops both corners, cascading', () => {
    const c: Point[] = [[112, 30], [112, 39], [175, 39], [175, 309], [112, 309], [112, 318]];
    expect(moveSegment(c, 2, 112)).toEqual([[112, 30], [112, 318]]);
    wellFormed(moveBend(c, 2, [112, 39]), c[0], c[5]);
  });

  test('removing a corner never leaves a duplicate at the end', () => {
    const c: Point[] = [[346, 66], [346, 120], [355, 120], [355, 93], [382, 93], [382, 120]];
    for (let k = 0; k < c.length; k++) {
      const out = removeBend(c, k);
      if (out) wellFormed(out, c[0], c[5]);
    }
  });

  test('a Z added to a run leaves nothing collinear', () => {
    const c: Point[] = [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), ROWY.j]];
    for (let i = 0; i + 1 < c.length; i++) wellFormed(addBendPair(c, i, [x(15), 100], COLS), c[0], c[3]);
  });
});

describe('random hand edits keep every plan well formed', () => {
  const bases: Point[][] = [
    U,
    [[x(12), ROWY.a], [x(12), 66], [x(16), 66], [x(16), 111], [x(20), 111], [x(20), ROWY.c]],
    [[x(12), ROWY.a], [x(12), 66], [x(20), 66], [x(20), 174], [x(24), 174], [x(24), ROWY.j]],
    [[x(5), ROWY['T+']], [x(5), ROWY['B+']]],
    [[x(8), ROWY.e], [x(8), 174], [x(9), 174], [x(9), ROWY.f]],
  ];
  test('several hundred seeded operation sequences', () => {
    let seed = 20260929;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = (n: number) => Math.floor(rnd() * n);
    for (let run = 0; run < 300; run++) {
      const base = bases[run % bases.length];
      const [first, last] = [base[0], base[base.length - 1]];
      let plan = base;
      for (let step = 0; step < 8; step++) {
        const op = pick(4);
        const before = plan;
        if (op === 0) {
          const i = pick(plan.length - 1);
          const h = Math.abs(plan[i][1] - plan[i + 1][1]) < 0.01;
          plan = moveSegment(plan, i, snapAcross(h, h ? 30 + rnd() * 290 : 40 + rnd() * 500, COLS));
        } else if (op === 1 && plan.length > 2) {
          plan = moveBend(plan, 1 + pick(plan.length - 2), [snapAcross(false, 40 + rnd() * 500, COLS), snapAcross(true, 30 + rnd() * 290, COLS)]);
        } else if (op === 2) {
          const i = pick(plan.length - 1);
          const t = rnd();
          plan = addBendPair(plan, i, [plan[i][0] + (plan[i + 1][0] - plan[i][0]) * t, plan[i][1] + (plan[i + 1][1] - plan[i][1]) * t], COLS);
        } else if (op === 3 && plan.length > 2) {
          plan = removeBend(plan, pick(plan.length)) ?? plan;
        }
        if (plan !== before) wellFormed(plan, first, last);
      }
    }
  });
});
