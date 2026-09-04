import { describe, expect, test } from 'bun:test';
import { parseSchematic, pinsOfUnit, powerUnit } from '../src/kicad/schematic.ts';
import { apply, pinBodyDirection, pinPosition, symbolMatrix } from '../src/kicad/transform.ts';
import { readFixture } from './smoke.test.ts';

const sch = parseSchematic(readFixture('PL1_1.kicad_sch'), 'PL1_1');

describe('parseSchematic', () => {
  test('reads the header, symbols, labels, wires and junctions', () => {
    expect(sch.project).toBe('PL1_1');
    expect(sch.uuid).toHaveLength(36);
    expect(sch.symbols).toHaveLength(35);
    expect(sch.labels).toHaveLength(4);
    expect(sch.wires).toHaveLength(53);
    expect(sch.junctions).toHaveLength(9);
    expect(sch.libSymbols.size).toBe(10);
    expect(sch.sheets).toBe(0);
    expect(sch.buses).toBe(0);
  });

  test('symbol instances carry reference, value, unit, rotation and pin uuids', () => {
    const u2 = sch.symbols.filter((s) => s.ref === 'U2');
    expect(u2.map((s) => s.unit).sort()).toEqual([3, 4, 7]);
    expect(u2[0].value).toBe('74LS04');
    const sw = sch.symbols.find((s) => s.ref === 'SW1')!;
    expect(sw.rot).toBe(90);
    expect(sw.mirror).toBeNull();
    expect([...sw.pinUuids.keys()].sort()).toEqual(['1', '2']);
  });

  test('library symbols expose pins per unit and the power unit', () => {
    const lib = sch.libSymbols.get('74xx:74LS04')!;
    expect(lib.power).toBe(false);
    expect(lib.unitCount).toBe(7);
    expect(pinsOfUnit(lib, 1).map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(pinsOfUnit(lib, 7).map((p) => p.number).sort()).toEqual(['14', '7']);
    expect(powerUnit(lib)).toBe(7);
    const gnd = sch.libSymbols.get('power:GND')!;
    expect(gnd.power).toBe(true);
    expect(pinsOfUnit(gnd, 1)).toHaveLength(1);
  });
});

describe('transform', () => {
  test('orientation matrices follow KiCad (y flipped, 90 = counter-clockwise)', () => {
    expect(apply(symbolMatrix(0, null), { x: 1, y: 2 })).toEqual({ x: 1, y: -2 });
    expect(apply(symbolMatrix(90, null), { x: 1, y: 2 })).toEqual({ x: -2, y: -1 });
    expect(apply(symbolMatrix(180, null), { x: 1, y: 2 })).toEqual({ x: -1, y: 2 });
    expect(apply(symbolMatrix(270, null), { x: 1, y: 2 })).toEqual({ x: 2, y: 1 });
    expect(apply(symbolMatrix(0, 'x'), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(apply(symbolMatrix(0, 'y'), { x: 1, y: 2 })).toEqual({ x: -1, y: -2 });
  });

  test('a resistor at rotation 0 has pin 1 above its origin with the body below', () => {
    const sym = { at: { x: 100, y: 50 }, rot: 0, mirror: null };
    const pin1 = { at: { x: 0, y: 3.81 }, angle: 270 };
    expect(pinPosition(sym, pin1)).toEqual({ x: 100, y: 46.19 });
    expect(pinBodyDirection(sym, pin1)).toEqual({ x: 0, y: 1 });
  });

  test('every connected pin in PL1_1 touches a wire, junction, label or another pin', () => {
    const points = new Set<string>();
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const w of sch.wires) for (const p of w.pts) points.add(key(p));
    for (const j of sch.junctions) points.add(key(j));
    for (const l of sch.labels) points.add(key(l.at));
    const onWire = (p: { x: number; y: number }) =>
      sch.wires.some((w) =>
        w.pts.slice(1).some((b, i) => {
          const a = w.pts[i];
          const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
          return Math.abs(cross) < 1e-6 && p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
        }),
      );
    const pinEnds = new Map<string, number>();
    const ends: { ref: string; pin: string; p: { x: number; y: number } }[] = [];
    for (const s of sch.symbols) {
      const lib = sch.libSymbols.get(s.libId)!;
      for (const pin of pinsOfUnit(lib, s.unit)) {
        const p = pinPosition(s, pin);
        ends.push({ ref: s.ref, pin: pin.number, p });
        pinEnds.set(key(p), (pinEnds.get(key(p)) ?? 0) + 1);
      }
    }
    // The netlist lists every connected pin; power symbols connect by name and are skipped.
    const connected = new Set(
      [...readFixture('PL1_1.net').matchAll(/\(node \(ref "([^"]+)"\) \(pin "([^"]+)"\)/g)].map((m) => `${m[1]}/${m[2]}`),
    );
    const bad = ends.filter((e) => connected.has(`${e.ref}/${e.pin}`) && !points.has(key(e.p)) && !onWire(e.p) && pinEnds.get(key(e.p))! < 2);
    expect(connected.size).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });
});
