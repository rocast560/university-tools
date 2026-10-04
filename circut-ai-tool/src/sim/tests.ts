// Saved test cases for the Simulate panel: a name, the input levels that set
// the switches up, and what the LEDs and displays should then show. Stored in
// the sidecar beside the layout, so a lab's required checks travel with its
// board and can be stepped through without setting switches by hand.

import { displayName } from '../netlist.ts';
import { SEGMENT_DIGITS, simulate, type SimModel, type SimResult } from './index.ts';
import { normalizeTests, type SimTest } from './test-spec.ts';

export { normalizeTests, type SimTest };

export interface TestOutcome {
  /** True when every expectation holds (and vacuously when there are none). */
  pass: boolean;
  /** One line per expectation that failed. */
  failures: string[];
  /** What each display shows: a digit, "blank", or its lit segments. */
  shown: Record<string, string>;
  result: SimResult;
}

/** The model input a test names, by its shown name or its full net name. */
function inputFor(model: SimModel, key: string) {
  return model.inputs.find((i) => i.net === key || displayName(i.net) === key || i.name === key);
}

/** Net levels for a test, every input the test does not name left at its idle level. */
export function testLevels(model: SimModel, test: SimTest): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  for (const [key, v] of Object.entries(test.levels)) {
    const inp = inputFor(model, key);
    if (inp) out[inp.net] = v;
  }
  return out;
}

/**
 * The switch positions (switch key -> closed) that put the test's levels on
 * the board. A switch to ground is closed for a 0, a switch to the supply for
 * a 1; inputs the test does not name are left open.
 */
export function switchesForTest(model: SimModel, test: SimTest): Record<string, boolean> {
  const levels = testLevels(model, test);
  const out: Record<string, boolean> = {};
  for (const inp of model.inputs) {
    const v = levels[inp.net];
    if (v !== undefined) out[inp.key] = inp.activeLow ? v === 0 : v === 1;
  }
  return out;
}

/** Names in a test that match no switch-driven input, so a typo shows up instead of being ignored. */
export function unknownInputs(model: SimModel, test: SimTest): string[] {
  return Object.keys(test.levels).filter((k) => !inputFor(model, k));
}

/** What a display's lit segments read as. */
export function readDigit(segments: Record<string, boolean>): string {
  const lit = 'abcdefg'.split('').filter((s) => segments[s]).join('');
  if (!lit) return 'blank';
  const hit = Object.entries(SEGMENT_DIGITS).find(([, segs]) => segs === lit);
  return hit ? hit[0] : `segments ${lit}`;
}

export function runTest(model: SimModel, test: SimTest): TestOutcome {
  const result = simulate(model, testLevels(model, test));
  const shown = Object.fromEntries(Object.entries(result.segments).map(([ref, segs]) => [ref, readDigit(segs)]));
  const failures: string[] = unknownInputs(model, test).map((k) => `no switch drives ${k}`);
  for (const [ref, want] of Object.entries(test.expect?.leds ?? {})) {
    const got = !!result.leds[ref];
    if (got !== want) failures.push(`${ref} should be ${want ? 'on' : 'off'} but is ${got ? 'on' : 'off'}`);
  }
  for (const [ref, want] of Object.entries(test.expect?.displays ?? {})) {
    const got = shown[ref] ?? 'missing';
    if (got !== want) failures.push(`${ref} should show ${want} but shows ${got}`);
  }
  return { pass: failures.length === 0, failures, shown, result };
}
