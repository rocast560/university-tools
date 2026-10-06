import { describe, expect, test } from 'bun:test';
import { easeOutCubic, frameBox } from '../client/editor3d/focus-math.ts';

describe('easeOutCubic', () => {
  test('starts at 0, ends at 1, and is past halfway by the middle', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('frameBox', () => {
  test('aims at the centre of the box', () => {
    expect(frameBox({ min: [0, 0, 0], max: [20, 10, 40] }, 38, 1.5, 1).target).toEqual([10, 5, 20]);
  });

  test('a bigger part needs the camera further back', () => {
    const small = frameBox({ min: [0, 0, 0], max: [10, 10, 10] }, 38, 1.5, 1.6).distance;
    const big = frameBox({ min: [0, 0, 0], max: [100, 10, 10] }, 38, 1.5, 1.6).distance;
    expect(big).toBeGreaterThan(small);
  });

  test('never closer than the orbit minimum', () => {
    expect(frameBox({ min: [0, 0, 0], max: [1, 1, 1] }, 38, 1.5, 1).distance).toBeGreaterThanOrEqual(60);
  });
});
