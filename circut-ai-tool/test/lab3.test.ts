import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../src/netlist.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { simulate, SEGMENT_DIGITS } from '../src/sim/index.ts';
import { l3Symbol, l3CoveredCols } from '../src/parts/lab3.ts';
import { isRail } from '../src/layout/board.ts';
import { renderSvg, svgSize } from '../src/render/index.ts';
import { createLibraryLookup } from '../server/libraries.ts';

const design = parseNetlist(readFileSync(new URL('../examples/Lab3_Prelab_Example.net', import.meta.url), 'utf8'));
const doc = buildLayoutDoc(design, emptySidecar());

test('L3 symbol is available without a separately installed library', async () => {
  expect(await createLibraryLookup({ symbolDir: '/missing' }).symbolText('ECE2300L:L3_Auxiliary')).toBe(l3Symbol());
});
test('L3 header sits in the outer row a, one column per position, and the reserved position has no signal', () => {
  expect(doc.unplaced).toEqual([]);
  expect(doc.error).toBeNull();
  expect(doc.checks.filter(c => c.level === 'error')).toEqual([]);
  expect(doc.footprints.U1.kind).toBe('module');
  const pkg = doc.packages.find(p => p.id === 'U1')!;
  expect(pkg.row).toBe('a');
  for (let i = 1; i <= 15; i++) expect(doc.pinHoles.U1[String(i)]).toEqual({ col: pkg.col0 + i - 1, row: 'a' });
  expect(design.components.get('U1')!.pins.get('7')!.net).toContain('unconnected-');
});
test('nothing lands in the top rail holes under the L3 board, which hangs over them', () => {
  const pkg = doc.packages.find(p => p.id === 'U1')!;
  const covered = new Set(l3CoveredCols(pkg.col0));
  const under = (h: { col: number; row: string }) => isRail(h.row as never) && h.row.startsWith('T') && covered.has(h.col);
  for (const w of doc.wires) expect(under(w.a) || under(w.b)).toBe(false);
  for (const lead of doc.supply?.leads ?? []) expect(under(lead.hole)).toBe(false);
  for (const holes of Object.values(doc.pinHoles)) for (const h of Object.values(holes)) expect(under(h)).toBe(false);
  // The board is 18 pitches long and hangs 12.5 pitches beyond row a, so the drawing grows upward to hold it.
  expect(svgSize(doc.board, doc.packages).viewBox.startsWith('-100 -')).toBe(true);
  const svg = renderSvg(doc);
  expect(svg).toContain('L3 CKT');
  expect(svg).toContain('L3 AUXILIARY');
  expect(doc.steps.some(s => s.ref === 'U1' && /row a, columns \d+-\d+/.test(s.label))).toBe(true);
});
test('prelab gates and auxiliary display every decimal digit with active-low segments', () => {
  expect(doc.sim.model.inputs.map(i => i.name)).toEqual(['W', 'X', 'Y', 'Z']);
  for (let digit = 0; digit < 10; digit++) {
    const levels = Object.fromEntries('WXYZ'.split('').map((name, i) => [name, ((digit >> (3 - i)) & 1) as 0 | 1]));
    const result = simulate(doc.sim.model, levels);
    for (const seg of 'abcdefg') {
      expect(result.segments.DS1[seg]).toBe(SEGMENT_DIGITS[digit].includes(seg));
      expect(result.nets[seg]).toBe(SEGMENT_DIGITS[digit].includes(seg) ? 0 : 1);
    }
    for (const name of 'WXYZ') expect(result.nets[`${name}n`]).toBe(levels[name] ? 0 : 1);
  }
});
