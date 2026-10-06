import { describe, expect, test } from 'bun:test';
import { parse } from '../src/sexpr.ts';
import { parseLibSymbol } from '../src/kicad/schematic.ts';
import { classify } from '../src/parts/catalog.ts';
import { componentFromSymbol } from '../src/edit/newpart.ts';
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
