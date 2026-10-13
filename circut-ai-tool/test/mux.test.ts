import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { muxOutputs } from '../src/parts/gates.ts';
import { buildSimModel, simulate, truthTable } from '../src/sim/index.ts';
import { buildAnalogModel } from '../src/sim/analog/model.ts';
import { solveMixed } from '../src/sim/analog/mixed.ts';
import { readFixture } from './smoke.test.ts';

describe('muxOutputs (74151)', () => {
  test('Z follows the selected data input and W is its complement', () => {
    const data = [0, 1, 1, 0, 1, 0, 0, 1];
    for (let line = 0; line < 8; line++) {
      const select = [line & 1, (line >> 1) & 1, (line >> 2) & 1];
      expect({ line, out: muxOutputs(data, select, 0) }).toEqual({ line, out: { z: data[line] as 0 | 1, w: (1 - data[line]) as 0 | 1 } });
    }
  });

  test('a high strobe forces Z low and W high whatever is selected', () => {
    expect(muxOutputs([1, 1, 1, 1, 1, 1, 1, 1], [1, 0, 1], 1)).toEqual({ z: 0, w: 1 });
  });
});

// Lab 7 pre-lab: one 74LS151 per function, A B C on S2 S1 S0, D (or NOT D
// through a 74LS04) on the data inputs, and the LED sinking into /Z so it
// lights when F = 1. SW1 positions 1-4 are A-D and pull their line low when
// closed.
const CASES = [
  { name: 'F1 = ABC + A\'BD + A\'B\'C\' + ACD\'', fixture: 'lab7-mux-f1.net', d: 'Net-(U1-I2)', ones: [0, 1, 5, 7, 10, 14, 15] },
  { name: 'F2 = m(2,3,6,7,8,9,12,13,15)', fixture: 'lab7-mux-f2.net', d: 'Net-(U1-I7)', ones: [2, 3, 6, 7, 8, 9, 12, 13, 15] },
];
const SELECT = ['Net-(U1-S2)', 'Net-(U1-S1)', 'Net-(U1-S0)'];

for (const c of CASES) {
  describe(`lab7: ${c.name} on a 74LS151`, () => {
    const d = parseNetlist(readFixture(c.fixture));
    const res = layout(d, emptySidecar());
    const model = buildSimModel(d, res);
    const levelsFor = (m: number) => Object.fromEntries([...SELECT, c.d].map((net, i) => [net, (m >> (3 - i)) & 1])) as Record<string, 0 | 1>;

    test('the 74LS151 is simulated', () => {
      expect(model.notSimulated).toEqual([]);
    });

    test('select inputs come first, MSB first, then the data input', () => {
      expect(model.inputs.map((i) => i.net)).toEqual([...SELECT, c.d]);
    });

    test('the LED lights on exactly the minterms of F', () => {
      const t = truthTable(model)!;
      expect(t.rows).toHaveLength(16);
      const lit = t.rows.flatMap((row, m) => (row.leds[0] ? [m] : []));
      expect(lit).toEqual(c.ones);
    });

    test('/Z is the complement of F on every row', () => {
      for (let m = 0; m < 16; m++) {
        const r = simulate(model, levelsFor(m));
        expect({ m, zbar: r.nets['Net-(D1-K)'] }).toEqual({ m, zbar: c.ones.includes(m) ? 0 : 1 });
      }
    });

    test('the board model is complete and agrees with the boolean simulator on every switch setting', () => {
      expect(buildAnalogModel(d, res).notModelled).toEqual([]);
      for (let m = 0; m < 16; m++) {
        const want = simulate(model, levelsFor(m));
        // DIP position k is variable k (A = 1 ... D = 4); closed reads 0.
        const switches = Object.fromEntries([1, 2, 3, 4].map((k) => [`SW1:${k}`, ((m >> (4 - k)) & 1) === 0]));
        const board = buildAnalogModel(d, res, switches);
        const got = solveMixed(board)!;
        expect(got.converged).toBe(true);
        expect({ m, lit: (got.brightness.D1 ?? 0) > 0 }).toEqual({ m, lit: want.leds.D1 });
        expect({ m, zbar: got.levels[board.nodeOfNet['Net-(D1-K)']] }).toEqual({ m, zbar: want.nets['Net-(D1-K)'] });
      }
    });
  });
}
