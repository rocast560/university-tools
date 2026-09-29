import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COLOR_GND, COLOR_PLUS } from '../src/layout/engine.ts';
import { emptySidecar, type Sidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';

const design = parseNetlist(readFileSync(new URL('./fixtures/PL1_1.net', import.meta.url), 'utf8'));
const square = (): Sidecar => ({ ...emptySidecar(), options: { ...emptySidecar().options, wireStyle: 'orthogonal' } });

describe('pipeline', () => {
  test('square wires put routes in the doc; curved ones leave the doc as it was', () => {
    expect(buildLayoutDoc(design, emptySidecar()).routes).toBeUndefined();
    const doc = buildLayoutDoc(design, square());
    expect(doc.routes?.length).toBe(doc.wires.length);
  });

  test('power jumpers stay red and ground ones black unless the sidecar says otherwise', () => {
    const doc = buildLayoutDoc(design, square());
    expect(doc.nets['+5V'].color).toBe(COLOR_PLUS);
    expect(doc.nets.GND.color).toBe(COLOR_GND);
  });

  test('a stale saved shape shows up in doc.warnings', () => {
    const s = square();
    s.wirePaths['/NOPE|a1|a9'] = { points: [] };
    expect(buildLayoutDoc(design, s).warnings).toContain('hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; dropped');
  });
});

describe('the flat board', () => {
  test('square wires are drawn along the routed paths, the same ones the 3D board uses', () => {
    const doc = buildLayoutDoc(design, square());
    const svg = renderSvg(doc, { wireStyle: 'orthogonal' });
    for (const r of doc.routes!) expect(svg).toContain(`d="${r.plan.map(([x, y], k) => `${k ? 'L' : 'M'} ${x} ${y}`).join(' ')}"`);
    expect(svg).not.toContain('stroke-dasharray');
  });

  test('the arc style is byte-for-byte what it was, routes or no routes', () => {
    const arc = buildLayoutDoc(design, emptySidecar());
    expect(renderSvg({ ...arc, routes: buildLayoutDoc(design, square()).routes })).toBe(renderSvg(arc));
    expect(renderSvg(arc)).toBe(readFileSync(new URL('./fixtures/PL1_1.flat.svg', import.meta.url), 'utf8'));
  });
});
