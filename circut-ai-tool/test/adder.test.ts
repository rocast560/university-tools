import { describe, expect, test } from 'bun:test';
import { Board, hole } from '../src/layout/board.ts';
import { normalizeSidecar } from '../src/layout/types.ts';
import { adderOutputs, icInfo } from '../src/parts/gates.ts';
import { simulate, type SimModel } from '../src/sim/index.ts';

describe('74283 adder', () => {
  test('is recognised as an adder with 16-pin power', () => {
    const info = icInfo('74LS283', 16);
    expect(info?.spec?.adder).toBe(true);
    expect(info?.vcc).toBe(16);
    expect(info?.gnd).toBe(8);
  });

  test('adds two nibbles and the carry', () => {
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (const c of [0, 1]) {
      const bits = (v: number) => [0, 1, 2, 3].map((i) => (v >> i) & 1);
      const out = adderOutputs(bits(a), bits(b), c);
      const total = out.sum.reduce<number>((acc, v, i) => acc + (v << i), 0) + (out.carryOut << 4);
      expect(total).toBe(a + b + c);
    }
  });

  test('simulate drives sum and carry nets, and chained adders settle', () => {
    const model: SimModel = {
      inputs: [], gates: [], decoders: [], demuxes: [], leds: [], displays: [], resistors: [], notSimulated: [],
      power: { '+5V': 1, GND: 0 },
      adders: [
        { ref: 'U1', a: ['A0', 'A1', 'A2', 'A3'], b: ['B0', 'B1', 'B2', 'B3'], carryIn: 'GND', sum: ['S0', 'S1', 'S2', 'S3'], carryOut: 'C4' },
        { ref: 'U2', a: ['GND', 'GND', 'GND', 'GND'], b: ['GND', 'GND', 'GND', 'GND'], carryIn: 'C4', sum: ['S4', 'X1', 'X2', 'X3'], carryOut: 'X4' },
      ],
    };
    // 9 + 8 = 17 = 1 0001
    const r = simulate(model, { A0: 1, A1: 0, A2: 0, A3: 1, B0: 0, B1: 0, B2: 0, B3: 1 });
    expect([r.nets.S0, r.nets.S1, r.nets.S2, r.nets.S3, r.nets.S4]).toEqual([1, 0, 0, 0, 1]);
  });
});

describe('double board', () => {
  test('option survives normalisation and rails split between the two boards', () => {
    expect(normalizeSidecar({ version: 1, options: { board: 'double' } }).options.board).toBe('double');
    const b = new Board(126, 'double', 63, 6);
    expect(b.inBounds(hole(126, 'j'))).toBe(true);
    expect(b.railNode('T+', 63)).toBe('T+L');
    expect(b.railNode('T+', 64)).toBe('T+R');
  });
});
