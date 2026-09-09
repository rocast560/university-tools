import { describe, expect, test } from 'bun:test';
import { solve } from '../src/sim/analog/matrix.ts';

describe('solve', () => {
  test('solves a 2x2 system', () => {
    // 2x + y = 5 ; x + 3y = 10  ->  x = 1, y = 3
    const x = solve(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x![0]).toBeCloseTo(1, 9);
    expect(x![1]).toBeCloseTo(3, 9);
  });

  test('swaps rows when the pivot is zero', () => {
    // y = 1 ; x = 2. The first pivot is 0, so this needs a row swap.
    const x = solve(
      [
        [0, 1],
        [1, 0],
      ],
      [1, 2],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2, 9);
    expect(x![1]).toBeCloseTo(1, 9);
  });

  test('picks the largest pivot so a tiny one does not lose precision', () => {
    // Classic ill-conditioned pair: naive elimination on the 1e-18 pivot
    // loses every significant digit of x.
    const x = solve(
      [
        [1e-18, 1],
        [1, 1],
      ],
      [1, 2],
    );
    expect(x![0]).toBeCloseTo(1, 9);
    expect(x![1]).toBeCloseTo(1, 9);
  });

  test('returns null for a singular matrix', () => {
    expect(
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6],
      ),
    ).toBeNull();
  });
});
