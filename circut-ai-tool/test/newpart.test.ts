import { describe, expect, test } from 'bun:test';
import { parse } from '../src/sexpr.ts';
import { parseLibSymbol } from '../src/kicad/schematic.ts';
import { classify } from '../src/parts/catalog.ts';
import { componentFromSymbol, defaultHoles, holeNear } from '../src/edit/newpart.ts';
import { placeAt } from '../src/render/geometry.ts';
import type { List } from '../src/sexpr.ts';

// A two-pin symbol in the shape extractLibSymbol returns.
const R = `(symbol "Device:R" (symbol "R_0_1") (symbol "R_1_1"
  (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
  (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;

describe('componentFromSymbol', () => {
  test('a resistor symbol becomes an unconnected two-lead resistor', () => {
    const comp = componentFromSymbol(parseLibSymbol(parse(R).items[0] as List), '1k');
    expect(comp).toMatchObject({ lib: 'Device', part: 'R', value: '1k' });
    expect([...comp.pins.keys()].sort()).toEqual(['1', '2']);
    expect([...comp.pins.values()].every((p) => p.net === '')).toBe(true);
    expect(classify(comp)).toMatchObject({ kind: 'lead2', style: 'R' });
  });
});

const full = { cols: 63, kind: 'full' as const, splitCol: null, railGapEvery: 6 };
const stacked = { cols: 126, kind: 'stacked' as const, splitCol: 63, railGapEvery: 6, tiers: 2 };

describe('holeNear', () => {
  test('snaps a point to the nearest hole', () => {
    const [x, y] = placeAt(full, { col: 12, row: 'c' });
    expect(holeNear(full, [x + 4, y - 3])).toEqual({ col: 12, row: 'c' });
  });
  test('holeNear on a stacked board picks the lower board', () => {
    const [x, y] = placeAt(stacked, { col: 70, row: 'h' });
    expect(holeNear(stacked, [x, y])).toEqual({ col: 70, row: 'h' });
  });
  test('off the board is null', () => {
    expect(holeNear(full, [-200, 10])).toBeNull();
  });
});

describe('defaultHoles', () => {
  const R = { kind: 'lead2', style: 'R', a: '1', b: '2', polarized: false, aLabel: '', bLabel: '' } as const;
  test('a resistor spans four columns along its row', () => {
    expect(defaultHoles(R, ['1', '2'], { col: 10, row: 'b' }, full)).toEqual({ '1': { col: 10, row: 'b' }, '2': { col: 14, row: 'b' } });
  });
  test('a 14-pin DIP straddles the channel with pin 1 bottom-left', () => {
    const pins = Array.from({ length: 14 }, (_, i) => String(i + 1));
    const h = defaultHoles({ kind: 'dip', pins: 14 }, pins, { col: 20, row: 'f' }, full)!;
    expect(h['1']).toEqual({ col: 20, row: 'f' });
    expect(h['7']).toEqual({ col: 26, row: 'f' });
    expect(h['8']).toEqual({ col: 26, row: 'e' });
    expect(h['14']).toEqual({ col: 20, row: 'e' });
  });
  test('a 7-position DIP switch is laid out in pin order despite paired pin lists', () => {
    const pairs = Array.from({ length: 7 }, (_, i) => [String(i + 1), String(14 - i)] as [string, string]);
    const h = defaultHoles({ kind: 'dipswitch', positions: 7, pairs }, pairs.flat(), { col: 20, row: 'f' }, full)!;
    expect(h['1']).toEqual({ col: 20, row: 'f' });
    expect(h['7']).toEqual({ col: 26, row: 'f' });
    expect(h['8']).toEqual({ col: 26, row: 'e' });
    expect(h['14']).toEqual({ col: 20, row: 'e' });
  });
  test('a DIP whose rows do not straddle the channel has no default holes', () => {
    const pins = Array.from({ length: 14 }, (_, i) => String(i + 1));
    expect(defaultHoles({ kind: 'dip', pins: 14 }, pins, { col: 20, row: 'b' }, full)).toBeNull();
  });
  test('a DIP running off the end of the top board is refused on a stacked board', () => {
    const pins = Array.from({ length: 16 }, (_, i) => String(i + 1));
    expect(defaultHoles({ kind: 'dip', pins: 16 }, pins, { col: 60, row: 'f' }, stacked)).toBeNull();
  });
  test('a display has no default holes: the engine places it', () => {
    expect(defaultHoles({ kind: 'sevenseg', pins: 10, common: 'anode', segments: {}, commonPins: [] }, [], { col: 5, row: 'f' }, full)).toBeNull();
  });
});
