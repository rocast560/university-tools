import { describe, expect, test } from 'bun:test';
import { displayName, isAutoNamed, isUnconnected, makeDesign, parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

describe('parseNetlist', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));

  test('merges multi-unit symbols into one component with every pin', () => {
    expect([...d.components.keys()].sort()).toEqual(['D1', 'D2', 'J1', 'R1', 'R2', 'R3', 'R4', 'SW1', 'SW2', 'U1', 'U2', 'U3']);
    const u3 = d.components.get('U3')!;
    expect(u3.value).toBe('74LS00');
    expect(u3.lib).toBe('74xx');
    expect(u3.part).toBe('74LS00');
    expect(u3.pins.size).toBe(14);
    expect(u3.pins.get('14')!.net).toBe('+5V');
    expect(u3.pins.get('14')!.name).toBe('VCC');
    expect(u3.pins.get('1')!.net).toBe('/A');
    expect(u3.pins.get('1')!.type).toBe('input');
  });

  test('pins that KiCad leaves out of the nets section get an unconnected net from libparts', () => {
    const u2 = d.components.get('U2')!;
    expect(u2.pins.size).toBe(14);
    const unconnected = [...u2.pins.values()].filter((p) => isUnconnected(p.net));
    expect(unconnected.length).toBeGreaterThan(0);
    expect(unconnected[0].net).toMatch(/^unconnected-\(U2-Pad\d+\)$/);
    expect(d.nets.get(unconnected[0].net)).toEqual([{ ref: 'U2', pin: unconnected[0].num }]);
  });

  test('nets list every member', () => {
    expect(d.nets.get('/A')!.map((n) => `${n.ref}.${n.pin}`).sort()).toEqual(['R1.2', 'SW1.2', 'U1.1', 'U3.1', 'U3.4']);
    expect(d.nets.get('+5V')!).toHaveLength(8);
  });

  test('rejects text that is not a netlist', () => {
    expect(() => parseNetlist('(kicad_sch)')).toThrow(/netlist/);
  });
});

describe('net name helpers', () => {
  test('displayName strips the sheet prefix', () => {
    expect(displayName('/A')).toBe('A');
    expect(displayName('+5V')).toBe('+5V');
  });
  test('classifies unconnected and auto-named nets', () => {
    expect(isUnconnected('unconnected-(U1-Pad3)')).toBe(true);
    expect(isAutoNamed('Net-(D1-A)')).toBe(true);
    expect(isAutoNamed('/A')).toBe(false);
  });
});

describe('makeDesign', () => {
  test('builds components and nets from a compact spec', () => {
    const d = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/A'] } },
      U1: { lib: '74xx', part: '74LS04', value: '74LS04', pins: { '1': ['~', 'input', '/A'], '2': ['~', 'output', 'unconnected-(U1-Pad2)'], '7': ['GND', 'power_in', 'GND'], '14': ['VCC', 'power_in', '+5V'] } },
    });
    expect(d.nets.get('/A')).toEqual([{ ref: 'R1', pin: '2' }, { ref: 'U1', pin: '1' }]);
    expect(d.components.get('U1')!.pins.get('14')!.type).toBe('power_in');
  });
});
