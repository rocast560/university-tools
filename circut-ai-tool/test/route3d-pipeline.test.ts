import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COLOR_GND, COLOR_PLUS } from '../src/layout/engine.ts';
import { emptySidecar, type Sidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { moveSegment } from '../src/edit/wireshape.ts';
import { buildLayoutDoc, ROUTER_FAILED, router, summarize } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';
import { wirePolylines } from '../src/render/ortho.ts';
import { planToPath, routeWires, wireKey } from '../src/render/route3d.ts';

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

  test('a stale saved shape shows up in doc.warnings and, as a layout warning, in the checks', () => {
    const s = square();
    s.wirePaths['/NOPE|a1|a9'] = { points: [] };
    const doc = buildLayoutDoc(design, s);
    const said = "hand-shaped jumper for /NOPE (a1-a9) no longer matches a wire; kept in case the part moves back. 'Tidy all wires' forgets it";
    expect(doc.warnings).toContain(said);
    expect(doc.checks).toContainEqual({ id: 'layout', level: 'warning', message: said, refs: [] });
    // So the counts every summary gives include it.
    expect(summarize(doc)).toContain(`${doc.checks.filter((c) => c.level === 'warning').length} warnings`);
    expect(doc.checks.filter((c) => c.level === 'warning').length).toBe(buildLayoutDoc(design, square()).checks.filter((c) => c.level === 'warning').length + 1);
  });

  test('a saved shape that no longer fits is named in the checks', () => {
    const s = square();
    const doc0 = buildLayoutDoc(design, s);
    const i = doc0.wires.findIndex((w) => wireKey(w) === '/A|g21|g3');
    // Its long run dragged below row j: the stub out of g3 would lie over the leg in j3.
    s.wirePaths[wireKey(doc0.wires[i])] = planToPath(doc0.wires[i], moveSegment(doc0.routes![i].plan, 1, 273))!;
    const doc = buildLayoutDoc(design, s);
    const said = 'hand-shaped jumper for /A (g21-g3) no longer fits (the path runs over a leg at j3); re-routed';
    expect(doc.warnings).toContain(said);
    expect(doc.checks).toContainEqual({ id: 'layout', level: 'warning', message: said, refs: [] });
  });

  test('a wire with no clean route is named in the checks', () => {
    // A board with its router given no search budget at all: every wire falls back.
    const was = router.route;
    router.route = (input, saved) => routeWires(input, saved, { maxExpand: 1 });
    try {
      const doc = buildLayoutDoc(design, square());
      const fell = doc.routes!.filter((r) => r.warning);
      expect(fell.length).toBeGreaterThan(0);
      for (const r of fell) expect(doc.checks).toContainEqual({ id: 'layout', level: 'warning', message: r.warning!, refs: [] });
    } finally {
      router.route = was;
    }
  });

  test('a router that throws leaves every wire drawn the simple way, flagged, and says so in the checks', () => {
    const was = router.route;
    router.route = () => {
      throw new Error('boom');
    };
    try {
      const doc = buildLayoutDoc(design, square());
      expect(doc.routes!.length).toBe(doc.wires.length);
      doc.routes!.forEach((r, i) => {
        expect(r.plan).toEqual(wirePolylines(doc.wires, doc.packages, doc.board)[i]);
        expect(r.warning).toBe(ROUTER_FAILED);
      });
      expect(doc.warnings).toContain(ROUTER_FAILED);
      expect(doc.checks).toContainEqual({ id: 'layout', level: 'warning', message: 'the wire router failed; showing simple square wires', refs: [] });
    } finally {
      router.route = was;
    }
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
