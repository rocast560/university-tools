import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../src/netlist.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { pt } from '../src/render/geometry.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { renderSvg } from '../src/render/index.ts';

const design = parseNetlist(readFileSync(new URL('../examples/Lab3_Prelab_Example.net', import.meta.url), 'utf8'));
const doc = buildLayoutDoc(design, emptySidecar());
const paths = wirePolylines(doc.wires, doc.packages, doc.board);

test('every square-cornered jumper starts and ends in its holes and turns only right angles', () => {
  paths.forEach((pts, i) => {
    expect(pts[0]).toEqual(pt(doc.wires[i].a));
    expect(pts[pts.length - 1]).toEqual(pt(doc.wires[i].b));
    for (let k = 0; k + 1 < pts.length; k++) expect(pts[k][0] === pts[k + 1][0] || pts[k][1] === pts[k + 1][1]).toBe(true);
  });
});

test('no two square-cornered jumpers share a stretch of the same line', () => {
  const runs: { key: string; lo: number; hi: number; wire: number }[] = [];
  paths.forEach((pts, i) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      if (ay === by) runs.push({ key: `h${ay}`, lo: Math.min(ax, bx), hi: Math.max(ax, bx), wire: i });
      else runs.push({ key: `v${ax}`, lo: Math.min(ay, by), hi: Math.max(ay, by), wire: i });
    }
  });
  const clashes: string[] = [];
  for (const r of runs) for (const s of runs) if (r.wire < s.wire && r.key === s.key && r.hi > s.lo + 1 && r.lo < s.hi - 1) clashes.push(`${r.key} wires ${r.wire} and ${s.wire}`);
  expect(clashes).toEqual([]);
});

test('the orthogonal style renders mitred paths and the arc style is untouched', () => {
  const ortho = renderSvg(doc, { wireStyle: 'orthogonal' });
  expect(ortho).toContain('stroke-linejoin="miter"');
  expect(ortho).not.toContain(' Q ');
  expect(renderSvg(doc)).toContain(' Q ');
});
