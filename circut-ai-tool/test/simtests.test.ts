import { describe, expect, test } from 'bun:test';
import { normalizeSidecar } from '../src/layout/types.ts';
import type { SimModel } from '../src/sim/index.ts';
import { readDigit, runTest, switchesForTest, type SimTest } from '../src/sim/tests.ts';

/** Two switches to ground with pull-ups (A, B), an XOR, an LED that lights on a low output, and a 7447 + display. */
const model: SimModel = {
  inputs: [
    { name: 'A', net: '/A', control: 'SW1 position 1', key: 'SW1:1', activeLow: true },
    { name: 'B', net: '/B', control: 'SW1 position 2', key: 'SW1:2', activeLow: true },
  ],
  gates: [{ name: 'U1A', kind: 'xor', inputs: ['/A', '/B'], output: '/X', ref: 'U1', pins: { inputs: [1, 2], output: 3 } }],
  decoders: [{ ref: 'U2', kind: '7447', inputs: { A: '/A', B: '/B', C: 'GND', D: 'GND' }, lampTest: '+5V', blanking: '+5V', outputs: { a: 'sa', b: 'sb', c: 'sc', d: 'sd', e: 'se', f: 'sf', g: 'sg' } }],
  demuxes: [],
  leds: [{ ref: 'D1', cathode: '/X', anode: '+5V' }],
  displays: [{ ref: 'DS1', common: 'anode', segments: { a: 'sa', b: 'sb', c: 'sc', d: 'sd', e: 'se', f: 'sf', g: 'sg' }, commonNets: ['+5V'] }],
  resistors: [],
  power: { '+5V': 1, GND: 0 },
  notSimulated: [],
};

describe('saved simulation tests', () => {
  const t: SimTest = { name: 'A only', levels: { A: 1, B: 0 }, expect: { leds: { D1: false }, displays: { DS1: '1' } } };

  test('switch positions: a 0 on a switch to ground is a closed switch', () => {
    expect(switchesForTest(model, t)).toEqual({ 'SW1:1': false, 'SW1:2': true });
    // Full net names work as well as the shown ones.
    expect(switchesForTest(model, { name: 'x', levels: { '/A': 0 } })).toEqual({ 'SW1:1': true });
  });

  test('a test passes when the LEDs and display match', () => {
    const o = runTest(model, t);
    expect(o.pass).toBe(true);
    expect(o.shown).toEqual({ DS1: '1' });
  });

  test('a wrong expectation fails and says why, and an unknown input is reported', () => {
    const o = runTest(model, { name: 'bad', levels: { A: 1, B: 1, C: 1 }, expect: { leds: { D1: false }, displays: { DS1: '2' } } });
    expect(o.pass).toBe(false);
    expect(o.failures).toEqual(['no switch drives C', 'D1 should be off but is on', 'DS1 should show 2 but shows 3']);
  });

  test('digits read off the segments, and nothing lit reads blank', () => {
    expect(readDigit({ a: true, b: true, c: true })).toBe('7');
    expect(readDigit({})).toBe('blank');
    expect(readDigit({ a: true })).toBe('segments a');
  });

  test('tests survive the sidecar round trip and junk is dropped', () => {
    const s = normalizeSidecar({ version: 1, tests: [t, { name: 'no levels' }, { name: 'bad level', levels: { A: 2 } }] });
    expect(s.tests.map((x) => x.name)).toEqual(['A only', 'bad level']);
    expect(s.tests[0]).toEqual(t);
    expect(s.tests[1].levels).toEqual({});
  });
});
