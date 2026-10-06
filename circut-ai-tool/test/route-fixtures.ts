// The four example boards the router is measured on, laid out once for every
// router test file.

import { readFileSync } from 'node:fs';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';

export const FIXTURES: Record<string, string> = {
  PL1_1: 'test/fixtures/PL1_1.net',
  lab3: 'examples/Lab3_Prelab_Example.net',
  'lab4-74ls08': 'test/fixtures/lab4-74ls08.net',
  'lab4-decoder': 'test/fixtures/lab4-decoder.net',
};

/** Each fixture's doc with curved wires (so the pipeline does not route it: the tests do). */
export const docs: Record<string, LayoutDoc> = Object.fromEntries(Object.entries(FIXTURES).map(([name, file]) => [name, buildLayoutDoc(parseNetlist(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), emptySidecar())]));
