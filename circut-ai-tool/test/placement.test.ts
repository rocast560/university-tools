import { describe, expect, test } from 'bun:test';
import { stripOf } from '../src/layout/board.ts';
import type { Hole, Row } from '../src/layout/types.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist, type Design } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { inBoard, jumperOutcome, legsToConnections, rotateLead2, stripNets, takenHoles, validatePlacement } from '../src/edit/placement.ts';
import { readFixture } from './smoke.test.ts';

const design = parseNetlist(readFixture('PL1_1.net'));
const doc = buildLayoutDoc(design, emptySidecar());
const part = doc.parts.find((p) => p.kind === 'lead2')!;
const here = doc.pinHoles[part.id];

/** A column whose top-half strip is empty of every leg and every net. */
function emptyTopColumn(): number {
  const nets = stripNets(doc, design, null);
  const taken = takenHoles(doc, null);
  for (let c = doc.board.cols - 1; c > 1; c--) {
    if (!nets.has(`T${c}`)) {
      // Also check that no hole in rows a–e of that column appears in takenHoles
      const rows: Row[] = ['a', 'b', 'c', 'd', 'e'];
      const hasHole = rows.some((row) => taken.has(`${row}${c}`));
      if (!hasHole) return c;
    }
  }
  throw new Error('fixture board has no empty column');
}

describe('inBoard', () => {
  test('knows the edges and the gaps in the rails', () => {
    expect(inBoard({ col: 1, row: 'a' }, doc.board)).toBe(true);
    expect(inBoard({ col: 0, row: 'a' }, doc.board)).toBe(false);
    expect(inBoard({ col: doc.board.cols + 1, row: 'j' }, doc.board)).toBe(false);
    expect(inBoard({ col: doc.board.railGapEvery, row: 'T+' }, doc.board)).toBe(false);
  });
});

describe('stripNets and takenHoles', () => {
  test('a part moved out of the way no longer counts against itself', () => {
    const [pin, h] = Object.entries(here)[0];
    expect(takenHoles(doc, null).get(`${h.row}${h.col}`)).toBe(part.id);
    expect(takenHoles(doc, part.id).has(`${h.row}${h.col}`)).toBe(false);
    const net = design.components.get(part.id)!.pins.get(pin)!.net;
    const without = stripNets(doc, design, part.id).get(stripOf(h));
    // The strip may still carry the net through another part, but never only through this one.
    const others = Object.entries(doc.pinHoles).filter(([r]) => r !== part.id).some(([, pins]) => Object.values(pins).some((o) => stripOf(o) === stripOf(h)));
    if (!others) expect(without?.has(net) ?? false).toBe(false);
  });
});

describe('validatePlacement', () => {
  test('where it already is, is fine', () => {
    const v = validatePlacement(doc, design, part.id, here);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.tints.every((t) => t.tone === 'ok')).toBe(true);
  });

  test('off the board is refused with the pin named', () => {
    const [pin] = Object.keys(here);
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: { col: 0, row: 'a' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('off the board');
    expect(v.tints.find((t) => t.hole.col === 0)?.tone).toBe('bad');
  });

  test('a hole another part uses is refused, naming that part', () => {
    const other = doc.parts.find((p) => p.id !== part.id)!;
    const theirs = doc.pinHoles[other.id][other.pins[0]];
    const [pin] = Object.keys(here);
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: theirs });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(other.id);
  });

  test('refuses a leg that would short two nets', () => {
    // Put pin 1 into a free hole of a strip that carries some other net.
    const pin = part.pins[0];
    const net = design.components.get(part.id)!.pins.get(pin)!.net;
    const nets = stripNets(doc, design, part.id);
    const taken = takenHoles(doc, part.id);
    let target: Hole | null = null;
    for (const [ref, pins] of Object.entries(doc.pinHoles)) {
      if (ref === part.id || target) continue;
      for (const h of Object.values(pins)) {
        const carried = nets.get(stripOf(h));
        if (!carried || carried.has(net) || h.row.length === 2) continue;
        const rows: Row[] = 'abcde'.includes(h.row) ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
        const free = rows.map((row) => ({ col: h.col, row })).find((o) => !taken.has(`${o.row}${o.col}`));
        if (free) target = free;
        if (target) break;
      }
    }
    expect(target).not.toBeNull();
    const v = validatePlacement(doc, design, part.id, { ...here, [pin]: target! });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short');
  });

  test('a vertical part inside one half shorts itself', () => {
    const c = emptyTopColumn();
    const [p1, p2] = part.pins;
    const n1 = design.components.get(part.id)!.pins.get(p1)!.net;
    const n2 = design.components.get(part.id)!.pins.get(p2)!.net;
    expect(n1).not.toBe(n2);
    const v = validatePlacement(doc, design, part.id, { [p1]: { col: c, row: 'a' }, [p2]: { col: c, row: 'd' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short each other');
  });

  test('a two-lead part with both legs in one strip is refused even with no nets', () => {
    const c = emptyTopColumn();
    const [p1, p2] = part.pins;
    const v = validatePlacement(doc, design, part.id, { [p1]: { col: c, row: 'a' }, [p2]: { col: c, row: 'd' } }, () => '');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short each other');
    expect(v.tints[1].tone).toBe('bad');
  });

  test('a two-lead part with both legs in one strip is refused when both pins share a net', () => {
    const c = emptyTopColumn();
    const [p1, p2] = part.pins;
    const v = validatePlacement(doc, design, part.id, { [p1]: { col: c, row: 'a' }, [p2]: { col: c, row: 'd' } }, () => '/SAME');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short each other');
  });

  test('a new two-legged part from the tray is refused in one strip too', () => {
    const c = emptyTopColumn();
    const v = validatePlacement(doc, design, 'R_NEW', { '1': { col: c, row: 'a' }, '2': { col: c, row: 'b' } }, () => '');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('short each other');
  });

  test('a part with more than two legs keeps the multi-pin rule: same net in one strip is fine, different nets are not', () => {
    const c = emptyTopColumn();
    const holes = { '1': { col: c, row: 'a' as Row }, '2': { col: c, row: 'b' as Row }, '3': { col: c, row: 'f' as Row } };
    const same = validatePlacement(doc, design, 'Q_NEW', holes, (pin) => (pin === '3' ? '/B' : '/A'));
    expect(same.reason ?? '').not.toContain('short each other');
    const diff = validatePlacement(doc, design, 'Q_NEW', holes, (pin) => `/N${pin}`);
    expect(diff.ok).toBe(false);
    expect(diff.reason).toContain('short each other');
  });

  test('a new part (no nets yet) joining a strip gets the amber tone, not a refusal', () => {
    const other = doc.parts.find((p) => p.id !== part.id)!;
    const theirs = doc.pinHoles[other.id][other.pins[0]];
    const rows: Row[] = 'abcde'.includes(theirs.row) ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
    const taken = takenHoles(doc, null);
    const free = rows.map((row) => ({ col: theirs.col, row })).find((o) => !taken.has(`${o.row}${o.col}`))!;
    const c = emptyTopColumn();
    const v = validatePlacement(doc, design, 'R_NEW', { '1': free, '2': { col: c, row: 'a' } }, () => '');
    expect(v.ok).toBe(true);
    expect(v.tints[0].tone).toBe('join');
    expect(v.tints[0].label).toBeTruthy();
  });

  test('a chip must straddle the channel', () => {
    const chip = doc.packages.find((p) => p.kind === 'dip')!;
    const holes = Object.fromEntries(Object.entries(doc.pinHoles[chip.id]).map(([pin, h]) => [pin, { col: h.col, row: (h.row === 'e' ? 'd' : h.row) as Row }]));
    const v = validatePlacement(doc, design, chip.id, holes);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('straddle');
  });
});

describe('rotateLead2', () => {
  test('a quarter turn clockwise about pin 1 carries a row-e part across the channel', () => {
    const r = rotateLead2({ '1': { col: 10, row: 'e' }, '2': { col: 13, row: 'e' } }, ['1', '2'])!;
    expect(r['1']).toEqual({ col: 10, row: 'e' });
    expect(r['2']).toEqual({ col: 10, row: 'h' });
  });

  test('four quarter turns come home', () => {
    let h: Record<string, Hole> | null = { '1': { col: 20, row: 'f' }, '2': { col: 20, row: 'c' } };
    for (let i = 0; i < 4; i++) h = rotateLead2(h!, ['1', '2']);
    expect(h).toEqual({ '1': { col: 20, row: 'f' }, '2': { col: 20, row: 'c' } });
  });

  test('a turn that leaves the rows gives null', () => {
    expect(rotateLead2({ '1': { col: 10, row: 'j' }, '2': { col: 14, row: 'j' } }, ['1', '2'])).toBeNull();
  });
});

/** A hand-built board: R1 pin 1 a5 and pin 3 f5 on /A, pin 2 a10 on /B; R2 pin 1 loose at c20. */
function jumperFixture() {
  const pin = (net: string) => ({ num: '', name: '', type: '', net });
  const comp = (ref: string, pins: Record<string, string>) => ({ ref, value: '', lib: '', part: '', pins: new Map(Object.entries(pins).map(([k, n]) => [k, pin(n)])) });
  const d: Design = {
    components: new Map([
      ['R1', comp('R1', { '1': '/A', '2': '/B', '3': '/A' })],
      ['R2', comp('R2', { '1': 'unconnected-(R2-Pad1)' })],
    ]),
    nets: new Map(),
  };
  const dc = { ...doc, supply: undefined, pinHoles: { R1: { '1': { col: 5, row: 'a' }, '2': { col: 10, row: 'a' }, '3': { col: 5, row: 'f' } }, R2: { '1': { col: 20, row: 'c' } } } } as unknown as typeof doc;
  return { doc: dc, design: d };
}

describe('legsToConnections', () => {
  test('a leg in a strip with a net joins it; a leg in an empty strip stays unconnected', () => {
    const { doc: d, design: g } = jumperFixture();
    expect(legsToConnections(d, g, { '1': { col: 5, row: 'c' }, '2': { col: 30, row: 'c' } })).toEqual({ '1': '/A' });
  });
});

describe('jumperOutcome', () => {
  const h = (col: number, row: Row): Hole => ({ col, row });
  test('two different nets are refused', () => {
    const { doc: d, design: g } = jumperFixture();
    expect(jumperOutcome(d, g, h(5, 'e'), h(10, 'e'))).toEqual({ kind: 'refuse', reason: 'would join A and B. Merge nets in the schematic' });
  });
  test('an unconnected leg joins the net at the other end, in either order', () => {
    const { doc: d, design: g } = jumperFixture();
    const want = { kind: 'connect' as const, net: '/A', pins: [{ ref: 'R2', pin: '1' }] };
    expect(jumperOutcome(d, g, h(20, 'e'), h(5, 'e'))).toEqual(want);
    expect(jumperOutcome(d, g, h(5, 'e'), h(20, 'e'))).toEqual(want);
  });
  test('the same net twice changes nothing in the schematic', () => {
    const { doc: d, design: g } = jumperFixture();
    expect(jumperOutcome(d, g, h(5, 'b'), h(5, 'j'))).toMatchObject({ kind: 'same', net: '/A' });
  });
  test('two empty strips: nothing to connect', () => {
    const { doc: d, design: g } = jumperFixture();
    expect(jumperOutcome(d, g, h(40, 'b'), h(45, 'b'))).toEqual({ kind: 'refuse', reason: 'nothing to connect yet. Place a part first' });
  });
  test('both ends in one strip is refused', () => {
    const { doc: d, design: g } = jumperFixture();
    expect(jumperOutcome(d, g, h(5, 'a'), h(5, 'e'))).toEqual({ kind: 'refuse', reason: 'both ends are in the same strip' });
  });
  test('a strip carrying two nets is refused', () => {
    const { doc: d, design: g } = jumperFixture();
    d.pinHoles.R1['2'] = h(5, 'b');
    expect(jumperOutcome(d, g, h(5, 'e'), h(40, 'b'))).toEqual({ kind: 'refuse', reason: 'that strip already joins two nets' });
  });
});

describe('jumperOutcome with a multi-unit chip', () => {
  test('a pin of a gate the schematic does not place is offered as loose, to be joined', () => {
    // PL1's U1 is a 74LS86 with only gate A placed: pin 13 (gate D) is unconnected-(U1-Pad13).
    expect(design.components.get('U1')!.pins.get('13')!.net).toBe('unconnected-(U1-Pad13)');
    const pin13 = doc.pinHoles.U1['13'];
    const [aRef, aPin] = Object.entries(doc.pinHoles).flatMap(([ref, pins]) => Object.keys(pins).map((pin) => [ref, pin] as const)).find(([ref, pin]) => design.components.get(ref)?.pins.get(pin)?.net === '/A' && stripOf(doc.pinHoles[ref][pin]) !== stripOf(pin13))!;
    const o = jumperOutcome(doc, design, pin13, doc.pinHoles[aRef][aPin]);
    expect(o).toMatchObject({ kind: 'connect', net: '/A' });
    expect((o as { pins: { ref: string; pin: string }[] }).pins).toContainEqual({ ref: 'U1', pin: '13' });
  });
});
