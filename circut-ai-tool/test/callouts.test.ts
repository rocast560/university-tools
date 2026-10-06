import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { callouts, clusterBoxes, type Box } from '../src/render/callouts.ts';
import { renderSvg } from '../src/render/index.ts';
import { readFixture } from './smoke.test.ts';

const res = layout(parseNetlist(readFixture('PL1_1.net')), emptySidecar());

describe('callouts', () => {
  test('a part group rings every part in it', () => {
    const c = callouts(res, { group: 'resistors' });
    const resistors = res.parts.filter((p) => p.style === 'R');
    expect(c.rings.map((r) => r.id).sort()).toEqual(resistors.map((p) => p.id).sort());
    // Every ring is found in some cluster, and the counts add up.
    expect(c.clusters.reduce((s, k) => s + k.count, 0)).toBe(resistors.length);
  });

  test('a net rings both ends of each of its wires, labelled as wires', () => {
    const c = callouts(res, { net: '/A' });
    const wires = res.wires.filter((w) => w.net === '/A');
    expect(c.rings.length).toBe(wires.length * 2);
    expect(new Set(c.rings.map((r) => r.id)).size).toBe(wires.length);
    expect(c.rings.every((r) => r.kind === 'wire' && r.box.x2 - r.box.x1 < 40)).toBe(true);
  });

  test('a build step on one part or one wire rings just that', () => {
    expect(callouts(res, { ref: res.parts[0].id }).rings.map((r) => r.id)).toEqual([res.parts[0].id]);
    expect(callouts(res, { wire: 0 }).rings.map((r) => r.id)).toEqual(['wire0', 'wire0']);
    expect(callouts(res, { wire: 0 }).clusters.reduce((s, k) => s + k.count, 0)).toBeGreaterThanOrEqual(1);
  });

  test('nothing highlighted, nothing called out', () => {
    expect(callouts(res, null)).toEqual({ rings: [], clusters: [] });
  });

  test('a tiny target still gets a ring big enough to see', () => {
    const c = callouts(res, { wire: 0 });
    const [r] = c.rings;
    expect(r.box.x2 - r.box.x1).toBeGreaterThanOrEqual(16);
    expect(r.box.y2 - r.box.y1).toBeGreaterThanOrEqual(16);
  });
});

describe('clusterBoxes', () => {
  const box = (x: number, y: number): Box => ({ x1: x, y1: y, x2: x + 10, y2: y + 10 });
  test('boxes close together share one arrow and a count; a far one stands alone', () => {
    const k = clusterBoxes([box(0, 0), box(20, 0), box(40, 0), box(400, 300)]);
    expect(k.map((c) => c.count).sort()).toEqual([1, 3]);
    const three = k.find((c) => c.count === 3)!;
    expect(three.box).toEqual({ x1: 0, y1: 0, x2: 50, y2: 10 });
  });
  test('a long chain of neighbours is split into spots instead of one board-wide cluster', () => {
    const row = Array.from({ length: 30 }, (_, i) => box(i * 20, 0));
    const k = clusterBoxes(row);
    expect(k.length).toBeGreaterThan(1);
    expect(k.every((c) => c.box.x2 - c.box.x1 <= 160)).toBe(true);
    expect(k.reduce((s, c) => s + c.count, 0)).toBe(30);
  });
  test('two boxes of the same item count once', () => {
    expect(clusterBoxes([box(0, 0), box(15, 0)], 'wire', ['w1', 'w1'])).toEqual([{ box: { x1: 0, y1: 0, x2: 25, y2: 10 }, count: 1, kind: 'wire' }]);
  });
});

describe('renderSvg callouts', () => {
  test('rings, arrows and count badges are drawn for the highlight', () => {
    const svg = renderSvg(res, { highlight: { group: 'resistors' } });
    const resistors = res.parts.filter((p) => p.style === 'R').length;
    expect((svg.match(/class="callout-ring"/g) ?? []).length).toBe(resistors);
    expect((svg.match(/class="callout-arrow"/g) ?? []).length).toBe(callouts(res, { group: 'resistors' }).clusters.length);
    expect(renderSvg(res)).not.toContain('callout');
  });
});
