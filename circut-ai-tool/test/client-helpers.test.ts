import { describe, expect, test } from 'bun:test';
import { nearestRow, shiftHoles } from '../client/drag.ts';
import { levelsFromSwitches, simState } from '../client/simstate.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildSimModel } from '../src/sim/index.ts';
import { P, ROWY } from '../src/render/index.ts';
import { readFixture } from './smoke.test.ts';

const board = { cols: 30, kind: 'half' as const, splitCol: null, railGapEvery: 6 };

describe('drag helpers', () => {
  test('nearestRow snaps to strip rows only', () => {
    expect(nearestRow(ROWY.a)).toBe('a');
    expect(nearestRow(ROWY.e + 10)).toBe('e');
    expect(nearestRow(ROWY.f - 10)).toBe('f');
    expect(nearestRow(ROWY['T+'])).toBe('a');
  });
  test('shiftHoles moves columns and rows, refuses off-board', () => {
    const holes = { '1': { col: 5, row: 'a' as const }, '2': { col: 5, row: 'T+' as const } };
    expect(shiftHoles(holes, 2 * P, 0, board, false)).toEqual({ '1': { col: 7, row: 'a' }, '2': { col: 7, row: 'T+' } });
    expect(shiftHoles({ '1': { col: 5, row: 'a' } }, 0, 2 * P, board, false)).toEqual({ '1': { col: 5, row: 'c' } });
    expect(shiftHoles({ '1': { col: 5, row: 'a' } }, 0, 2 * P, board, true)).toEqual({ '1': { col: 5, row: 'a' } });
    expect(shiftHoles({ '1': { col: 29, row: 'a' } }, 2 * P, 0, board, false)).toBeNull();
    expect(shiftHoles({ '1': { col: 2, row: 'a' } }, -2 * P, 0, board, false)).toBeNull();
  });
});

describe('sim state', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  const model = buildSimModel(d, layout(d, emptySidecar()));
  test('switch keys map to input levels (active low: closed = 0)', () => {
    expect(model.inputs.map((i) => i.key)).toEqual(['SW1', 'SW2']);
    expect(levelsFromSwitches(model, {})).toEqual({ '/A': 1, '/B': 1 });
    expect(levelsFromSwitches(model, { SW1: true })).toEqual({ '/A': 0, '/B': 1 });
    const s = simState(model, { SW1: true });
    expect(s.leds.D1).toBe(true);
    expect(s.switches).toEqual({ SW1: true });
  });
});
