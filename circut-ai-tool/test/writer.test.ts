import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit } from '../src/kicad/schematic.ts';
import { pinBodyDirection, pinPosition } from '../src/kicad/transform.ts';
import { appendTopLevel, contentBounds, freeSpot, insertLibSymbol, labelNode, labelRotation, nextLabelName, nextReference, powerRotation, removeByUuid, setPropertyValue, symbolNode } from '../src/kicad/writer.ts';
import { readFixture } from './smoke.test.ts';

const base = readFixture('PL1_1.kicad_sch');
const sch = parseSchematic(base, 'PL1_1');

describe('writer helpers', () => {
  test('references, label names, bounds and free spots', () => {
    expect(nextReference(sch, 'R')).toBe('R5');
    expect(nextReference(sch, 'U')).toBe('U4');
    expect(nextReference(sch, 'C')).toBe('C1');
    expect(nextLabelName(sch)).toBe('N1');
    const b = contentBounds(sch);
    expect(b.maxX).toBeGreaterThan(b.minX);
    const s0 = freeSpot(sch, 0);
    expect(s0.x).toBeGreaterThan(b.maxX);
    // Grid alignment check: avoid `s0.x % 1.27`, which is unreliable in IEEE-754 --
    // e.g. 279.4 % 1.27 evaluates to ~1.27 (not ~0) because 279.4 / 1.27 rounds to
    // just under the true integer quotient. Checking the quotient against its
    // rounded value is the robust way to test float grid alignment.
    expect(s0.x / 1.27).toBeCloseTo(Math.round(s0.x / 1.27), 6);
    expect(freeSpot(sch, 1).y).toBeCloseTo(s0.y + 25.4, 6);
    // freeSpot re-snaps with round4, so its result can land on a different (but
    // equally valid) double than a raw `s0.x + 25.4` sum -- toBeCloseTo compares
    // the intended decimal values rather than requiring bit-identical doubles.
    expect(freeSpot(sch, 4).x).toBeCloseTo(s0.x + 25.4, 6);
  });
  test('rotations from the away vector', () => {
    expect(labelRotation({ x: 1, y: 0 })).toBe(0);
    expect(labelRotation({ x: -1, y: 0 })).toBe(180);
    expect(labelRotation({ x: 0, y: -1 })).toBe(90);
    expect(labelRotation({ x: 0, y: 1 })).toBe(270);
    expect(powerRotation({ x: 0, y: -1 })).toBe(0);
    expect(powerRotation({ x: 0, y: 1 })).toBe(180);
    expect(powerRotation({ x: -1, y: 0 })).toBe(90);
    expect(powerRotation({ x: 1, y: 0 })).toBe(270);
  });
});

describe('writer edits', () => {
  test('add a resistor, label its pins, change its value, remove it; untouched text is byte-identical', () => {
    const libText = base.slice(sch.libSymbols.get('Device:R')!.node.start, sch.libSymbols.get('Device:R')!.node.end);
    const t1 = insertLibSymbol(sch, libText);
    expect(t1).toBe(base); // already present
    const at = freeSpot(sch, 0);
    const node = symbolNode({ libId: 'Device:R', at, unit: 1, ref: 'R5', value: '4k7', pinNumbers: ['1', '2'], project: sch.project, rootUuid: sch.uuid });
    const t2 = appendTopLevel(sch, node);
    expect(t2.slice(0, sch.root.items[0].end - 1)).toBe(base.slice(0, sch.root.items[0].end - 1));
    const s2 = parseSchematic(t2, 'PL1_1');
    expect(s2.symbols).toHaveLength(36);
    const r5 = s2.symbols.find((s) => s.ref === 'R5')!;
    expect(r5.value).toBe('4k7');
    expect(r5.at).toEqual(at);
    expect([...r5.pinUuids.keys()]).toEqual(['1', '2']);
    const pin1 = pinsOfUnit(s2.libSymbols.get('Device:R')!, 1).find((p) => p.number === '1')!;
    const end = pinPosition(r5, pin1);
    const away = pinBodyDirection(r5, pin1);
    expect(away).toEqual({ x: 0, y: 1 });
    const label = labelNode({ kind: 'label', text: 'A', at: end, rot: labelRotation({ x: -away.x, y: -away.y }) });
    const t3 = appendTopLevel(s2, label);
    const s3 = parseSchematic(t3, 'PL1_1');
    const l = s3.labels.find((x) => x.text === 'A' && x.at.x === end.x && x.at.y === end.y)!;
    expect(l).toBeDefined();
    expect(l.rot).toBe(90);
    const t4 = setPropertyValue(s3, s3.symbols.find((s) => s.ref === 'R5')!, 'Value', '10k');
    const s4 = parseSchematic(t4, 'PL1_1');
    expect(s4.symbols.find((s) => s.ref === 'R5')!.value).toBe('10k');
    expect(s4.symbols).toHaveLength(36);
    const t5 = removeByUuid(s4, [s4.symbols.find((s) => s.ref === 'R5')!.uuid, l.uuid]);
    const s5 = parseSchematic(t5, 'PL1_1');
    expect(s5.symbols).toHaveLength(35);
    expect(s5.labels).toHaveLength(4);
    expect(t5.replace(/\s+/g, '')).toBe(base.replace(/\s+/g, ''));
  });

  test('insertLibSymbol adds a missing definition inside lib_symbols', () => {
    const fake = '(symbol "Device:C" (pin_numbers (hide yes)) (property "Reference" "C" (at 0 0 0)) (symbol "C_1_1" (pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))';
    const t = insertLibSymbol(sch, fake);
    const s = parseSchematic(t, 'PL1_1');
    expect(s.libSymbols.has('Device:C')).toBe(true);
    expect(s.libSymbols.size).toBe(11);
    expect(s.symbols).toHaveLength(35);
  });

  test('a power symbol node hides its reference', () => {
    const node = symbolNode({ libId: 'power:+5V', at: { x: 10, y: 10 }, rot: 0, unit: 1, ref: '#PWR099', value: '+5V', pinNumbers: ['1'], project: sch.project, rootUuid: sch.uuid, hideReference: true });
    expect(node).toMatch(/\(property "Reference" "#PWR099"[\s\S]*?\(hide yes\)/);
    const s = parseSchematic(appendTopLevel(sch, node), 'PL1_1');
    expect(s.symbols.find((x) => x.ref === '#PWR099')!.value).toBe('+5V');
  });
});
