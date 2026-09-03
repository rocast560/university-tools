import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit } from '../src/kicad/schematic.ts';
import { pinPosition } from '../src/kicad/transform.ts';
import { addComponent, connectPin, disconnectPin, netTarget, removeComponent, setValue } from '../src/kicad/ops.ts';
import { parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

const base = readFixture('PL1_1.kicad_sch');
const sch = parseSchematic(base, 'PL1_1');
const design = parseNetlist(readFixture('PL1_1.net'));
const FAKE_C = '(symbol "Device:C" (pin_numbers (hide yes)) (property "Reference" "C" (at 0 0 0)) (property "Value" "C" (at 0 0 0)) (symbol "C_1_1" (pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin passive line (at 0 -3.81 90) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))';
const libs = async (libId: string) => {
  const own = sch.libSymbols.get(libId);
  if (own) return base.slice(own.node.start, own.node.end);
  if (libId === 'Device:C') return FAKE_C;
  throw new Error(`no lib ${libId}`);
};

describe('netTarget', () => {
  test('classifies names', () => {
    expect(netTarget('/A', design)).toEqual({ kind: 'local', name: 'A' });
    expect(netTarget('A', design)).toEqual({ kind: 'local', name: 'A' });
    expect(netTarget('+5V', design)).toEqual({ kind: 'power', name: '+5V' });
    expect(netTarget('GND', design)).toEqual({ kind: 'power', name: 'GND' });
    expect(netTarget('Net-(D1-A)', design)).toBe('auto');
    expect(netTarget('NEWNET', design)).toEqual({ kind: 'local', name: 'NEWNET' });
  });
});

describe('addComponent', () => {
  test('a new two-lead part with connections gets labels and a power symbol', async () => {
    const r = await addComponent(sch, design, { libId: 'Device:C', value: '100n', connections: { '1': '+5V', '2': 'GND' } }, libs);
    expect(r.ref).toBe('C1');
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.libSymbols.has('Device:C')).toBe(true);
    const c1 = s.symbols.find((x) => x.ref === 'C1')!;
    expect(c1.value).toBe('100n');
    const pwr = s.symbols.filter((x) => x.libId === 'power:+5V' || x.libId === 'power:GND');
    expect(pwr.length).toBe(8 + 6 + 2);
    const pin1 = pinsOfUnit(s.libSymbols.get('Device:C')!, 1).find((p) => p.number === '1')!;
    const end = pinPosition(c1, pin1);
    expect(pwr.some((p) => p.value === '+5V' && p.at.x === end.x && p.at.y === end.y)).toBe(true);
    expect(Object.keys(r.placed.C1).sort()).toEqual(['1', '2']);
    expect(r.placed.C1['1']).toHaveLength(1);
  });

  test('a gate reuses a spare unit of an existing chip', async () => {
    const r = await addComponent(sch, design, { libId: '74xx:74LS86', connections: { '4': 'A', '5': 'B' } }, libs);
    expect(r.ref).toBe('U1');
    expect(r.unit).toBe(2);
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.symbols.filter((x) => x.ref === 'U1').map((x) => x.unit).sort()).toEqual([1, 2, 5]);
    expect(s.labels.filter((l) => l.kind === 'label' && (l.text === 'A' || l.text === 'B')).length).toBe(4);
    expect(r.notes.join(' ')).toMatch(/spare gate/);
  });

  test('a new chip gets unit 1 and its power unit, and a note about pins outside the unit', async () => {
    const r = await addComponent(sch, design, { libId: '74xx:74LS00', connections: { '1': 'A', '14': '+5V', '9': 'B' } }, libs);
    expect(r.ref).toBe('U4');
    const s = parseSchematic(r.text, 'PL1_1');
    const units = s.symbols.filter((x) => x.ref === 'U4').map((x) => x.unit).sort();
    expect(units).toEqual([1, 5]);
    expect(r.notes.join(' ')).toMatch(/pin 9/);
    expect(s.symbols.some((x) => x.libId === 'power:+5V' && x.at.y > 0)).toBe(true);
  });

  test('explicit ref and unknown lib', async () => {
    const r = await addComponent(sch, design, { libId: 'Device:R', ref: 'R9', value: '1k' }, libs);
    expect(r.ref).toBe('R9');
    await expect(addComponent(sch, design, { libId: 'Nope:X' }, libs)).rejects.toThrow(/no lib/);
    await expect(addComponent(sch, design, { libId: 'Device:R', ref: 'R1' }, libs)).rejects.toThrow(/already/);
  });
});

describe('connect, disconnect, remove, setValue', () => {
  test('connect to an auto-named net names it first; disconnect removes only what was placed', async () => {
    const r1 = await connectPin(sch, design, 'R3', '2', 'Net-(D1-A)', libs);
    const s1 = parseSchematic(r1.text, 'PL1_1');
    const named = s1.labels.filter((l) => l.text === 'N1');
    expect(named).toHaveLength(2);
    expect(r1.notes.join(' ')).toMatch(/named N1/);
    const placedAll = r1.placed;
    const r2 = disconnectPin(s1, 'R3', '2', placedAll);
    const s2 = parseSchematic(r2.text, 'PL1_1');
    expect(s2.labels.filter((l) => l.text === 'N1')).toHaveLength(1);
    expect(r2.placed['-']).toBeDefined();
    const r3 = disconnectPin(s2, 'R1', '1', {});
    expect(r3.text).toBe(s2.text);
    expect(r3.notes.join(' ')).toMatch(/nothing placed by this tool/);
  });

  test('connect to an existing local net and to a power net', async () => {
    const r = await connectPin(sch, design, 'R4', '2', 'Y1', libs);
    const s = parseSchematic(r.text, 'PL1_1');
    expect(s.labels.filter((l) => l.kind === 'label' && l.text === 'Y1')).toHaveLength(2);
    const r2 = await connectPin(s, design, 'R4', '1', 'GND', libs);
    expect(parseSchematic(r2.text, 'PL1_1').symbols.filter((x) => x.libId === 'power:GND')).toHaveLength(7);
    await expect(connectPin(sch, design, 'R4', '9', 'Y1', libs)).rejects.toThrow(/pin 9/);
    await expect(connectPin(sch, design, 'R99', '1', 'Y1', libs)).rejects.toThrow(/R99/);
  });

  test('remove every unit and placed labels; setValue on all units', async () => {
    const added = await addComponent(sch, design, { libId: '74xx:74LS00', connections: { '1': 'A' } }, libs);
    const s = parseSchematic(added.text, 'PL1_1');
    const rm = removeComponent(s, 'U4', added.placed);
    const s2 = parseSchematic(rm.text, 'PL1_1');
    expect(s2.symbols.filter((x) => x.ref === 'U4')).toHaveLength(0);
    expect(s2.labels.length).toBe(4);
    expect(rm.notes.join(' ')).toMatch(/wires drawn by hand/);
    const sv = setValue(sch, 'U2', '74HC04');
    const s3 = parseSchematic(sv.text, 'PL1_1');
    expect(s3.symbols.filter((x) => x.ref === 'U2').every((x) => x.value === '74HC04')).toBe(true);
    expect(() => setValue(sch, 'U9', 'x')).toThrow(/U9/);
  });
});
