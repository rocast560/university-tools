// The shape of a saved Simulate-panel test, and how one is read off disk.
// Kept free of imports so the sidecar types can use it without pulling the
// simulator in.

export interface SimTest {
  name: string;
  /** Heading the test is listed under, e.g. "Addition (M = 0)". */
  group?: string;
  /** Input net (as shown, e.g. "A0", or the full "/A0") or switch position ("SW1:2") -> level. Inputs not named stay at their idle level. */
  levels: Record<string, 0 | 1>;
  expect?: {
    /** LED reference -> lit. */
    leds?: Record<string, boolean>;
    /** Display reference -> the digit it should show, or "blank". */
    displays?: Record<string, string>;
  };
  /** One line shown under the test when it is selected. */
  note?: string;
}

const level = (v: unknown): v is 0 | 1 => v === 0 || v === 1;

/** Accept whatever is on disk and keep only well-formed tests. */
export function normalizeTests(x: unknown): SimTest[] {
  if (!Array.isArray(x)) return [];
  const out: SimTest[] = [];
  for (const t of x) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.levels || typeof t.levels !== 'object') continue;
    const levels: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(t.levels as Record<string, unknown>)) if (level(v)) levels[k] = v;
    const test: SimTest = { name: t.name, levels };
    if (typeof t.group === 'string') test.group = t.group;
    if (typeof t.note === 'string') test.note = t.note;
    const e = t.expect;
    if (e && typeof e === 'object') {
      test.expect = {};
      if (e.leds && typeof e.leds === 'object') test.expect.leds = Object.fromEntries(Object.entries(e.leds as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
      if (e.displays && typeof e.displays === 'object') test.expect.displays = Object.fromEntries(Object.entries(e.displays as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
    out.push(test);
  }
  return out;
}

