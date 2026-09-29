import { describe, expect, test } from 'bun:test';
import { flipDip } from '../src/edit/placement.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const doc = buildLayoutDoc(design, emptySidecar());
const chip = doc.packages.find((p) => p.kind === 'dip')!;
const holes = doc.pinHoles[chip.id];

describe('flipDip', () => {
  test('pin 1 moves from the bottom-left corner to the top-right one', () => {
    const f = flipDip(holes);
    const cols = Object.values(holes).map((h) => h.col);
    expect(holes['1'].row).toBe('f');
    expect(f['1']).toEqual({ col: Math.max(...cols), row: 'e' });
  });

  test('flipping twice is the identity', () => {
    expect(flipDip(flipDip(holes))).toEqual(holes);
  });

  test('flipDip keeps every pin in rows e/f and inside the chip\'s own columns', () => {
    const cols = Object.values(holes).map((h) => h.col);
    const f = flipDip(holes);
    expect(Object.keys(f).sort()).toEqual(Object.keys(holes).sort());
    for (const h of Object.values(f)) {
      expect(['e', 'f']).toContain(h.row);
      expect(h.col).toBeGreaterThanOrEqual(Math.min(...cols));
      expect(h.col).toBeLessThanOrEqual(Math.max(...cols));
    }
  });
});

describe('a DIP pinned upside down', () => {
  const sidecar = { ...emptySidecar(), pinned: { [chip.id]: flipDip(holes) } };
  const flipped = buildLayoutDoc(design, sidecar);

  test('is kept, and marked flipped', () => {
    expect(flipped.warnings.filter((w) => w.includes(chip.id))).toEqual([]);
    expect(flipped.packages.find((p) => p.id === chip.id)!.flipped).toBe(true);
    expect(flipped.pinHoles[chip.id]['1'].row).toBe('e');
  });

  test('an unflipped chip carries no flag at all, so existing snapshots do not change', () => {
    expect('flipped' in doc.packages.find((p) => p.id === chip.id)!).toBe(false);
  });

  test('the flat board draws its notch at the right-hand end', () => {
    const svg = renderSvg(flipped, {});
    const g = svg.slice(svg.indexOf(`data-ref="${chip.id}"`));
    const rect = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(g)!;
    const notch = /<circle cx="([\d.]+)" cy="[\d.]+" r="5"/.exec(g)!;
    expect(Number(notch[1])).toBeCloseTo(Number(rect[1]) + Number(rect[2]), 1);
  });
});
