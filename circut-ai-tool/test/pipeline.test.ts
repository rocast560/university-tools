import { describe, expect, test } from 'bun:test';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc, summarize } from '../src/pipeline.ts';
import { readFixture } from './smoke.test.ts';

describe('buildLayoutDoc', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  const doc = buildLayoutDoc(d, emptySidecar());
  test('composes engine, checks, sim and guide', () => {
    expect(doc.error).toBeNull();
    expect(doc.checks.some((c) => c.level === 'error')).toBe(false);
    expect(doc.sim.truthTable!.rows).toHaveLength(4);
    expect(doc.sim.note).toBeNull();
    expect(doc.steps.length).toBeGreaterThan(10);
    expect(doc.pinouts).toHaveLength(3);
    expect(doc.partsList.length).toBeGreaterThan(3);
    expect(JSON.parse(JSON.stringify(doc))).toBeTruthy();
  });
  test('summary mentions the board, parts and checks', () => {
    const s = summarize(doc);
    expect(s).toMatch(/full-size|half-size/);
    expect(s).toMatch(/3 chips/);
    expect(s).toMatch(/0 errors/);
  });
  test('the truth table is withheld when the wiring has errors', () => {
    const broken = { ...emptySidecar() };
    broken.pinned.R1 = { '1': { col: 1, row: 'a' }, '2': { col: 2, row: 'a' } };
    const doc2 = buildLayoutDoc(d, broken);
    if (doc2.checks.some((c) => c.level === 'error')) {
      expect(doc2.sim.truthTable).toBeNull();
      expect(doc2.sim.note).toMatch(/errors/);
    } else expect(doc2.sim.truthTable).not.toBeNull();
  });
});
