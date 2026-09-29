import { describe, expect, test } from 'bun:test';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar, type Hole, type Wire } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { pt } from '../src/render/geometry.ts';
import { wireControls } from '../src/render/routing.ts';
import { readFixture } from './smoke.test.ts';

const wire = (a: Hole, b: Hole): Wire => ({ net: '/N', a, b, role: 'signal' });
const h = (col: number, row: Hole['row']): Hole => ({ col, row });

/** How far the drawn curve leaves the straight line: half the control offset. */
function apex(w: Wire, c: [number, number]): number {
  const [ax, ay] = pt(w.a);
  const [bx, by] = pt(w.b);
  return Math.hypot(c[0] - (ax + bx) / 2, c[1] - (ay + by) / 2) / 2;
}

describe('wireControls', () => {
  test('bows every wire off the straight line', () => {
    const wires = [wire(h(3, 'a'), h(4, 'a')), wire(h(2, 'g'), h(20, 'g')), wire(h(10, 'T-'), h(10, 'B-'))];
    for (const [i, c] of wireControls(wires).entries()) expect(apex(wires[i], c)).toBeGreaterThan(1);
  });

  test('a longer wire arcs further, up to a ceiling under one row', () => {
    const short = wire(h(3, 'a'), h(4, 'a'));
    const long = wire(h(1, 'a'), h(30, 'a'));
    const [cs, cl] = wireControls([short, long]);
    expect(apex(long, cl)).toBeGreaterThan(apex(short, cs));
    // ROWY steps by 18, so an arc must never reach into the neighbouring row.
    expect(apex(long, cl)).toBeLessThan(18);
  });

  test('wires sharing a row are pulled into separate lanes', () => {
    // The case that made the board unreadable: three links along row g that
    // together look like one straight line.
    const wires = [wire(h(2, 'g'), h(12, 'g')), wire(h(3, 'g'), h(13, 'g')), wire(h(4, 'g'), h(14, 'g'))];
    const ys = wireControls(wires).map((c) => c[1]);
    for (let i = 0; i + 1 < ys.length; i++) expect(Math.abs(ys[i + 1] - ys[i])).toBeGreaterThan(4);
  });

  test('a lone wire is not fanned; adding a corridor mate moves both', () => {
    const a = wire(h(2, 'g'), h(12, 'g'));
    const alone = wireControls([a])[0];
    const [withMate] = wireControls([a, wire(h(3, 'g'), h(13, 'g'))]);
    expect(withMate[1]).not.toBe(alone[1]);
    expect(wireControls([a])[0]).toEqual(alone);
  });

  test('wires in different rows are left alone by each other', () => {
    const a = wire(h(2, 'g'), h(12, 'g'));
    const b = wire(h(2, 'c'), h(12, 'c'));
    expect(wireControls([a, b])[0]).toEqual(wireControls([a])[0]);
  });

  test('arcs bow away from the centre channel, not over the chips', () => {
    const [top] = wireControls([wire(h(2, 'c'), h(20, 'c'))]);
    const [bottom] = wireControls([wire(h(2, 'h'), h(20, 'h'))]);
    expect(top[1]).toBeLessThan(pt(h(2, 'c'))[1]);
    expect(bottom[1]).toBeGreaterThan(pt(h(2, 'h'))[1]);
  });

  test('swapping a wire round does not flip which way it bows', () => {
    const [fwd] = wireControls([wire(h(2, 'g'), h(12, 'g'))]);
    const [back] = wireControls([wire(h(12, 'g'), h(2, 'g'))]);
    expect(back).toEqual(fwd);
  });

  test('is pure: the real board renders the same arcs every time', () => {
    const res = layout(parseNetlist(readFixture('PL1_1.net')), emptySidecar());
    expect(wireControls(res.wires)).toEqual(wireControls(res.wires));
    expect(wireControls(res.wires)).toHaveLength(res.wires.length);
    for (const c of wireControls(res.wires)) expect(Number.isFinite(c[0]) && Number.isFinite(c[1])).toBe(true);
  });
});
