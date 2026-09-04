import { describe, expect, test } from 'bun:test';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { classify, powerKind } from '../src/parts/catalog.ts';
import { CHIPS, icInfo } from '../src/parts/gates.ts';
import { compareRefs, formatSI, parseFarads, parseHenries, parseOhms } from '../src/parts/values.ts';
import { readFixture } from './smoke.test.ts';

describe('values', () => {
  test('resistance', () => {
    expect(parseOhms('1k')).toBe(1000);
    expect(parseOhms('4k7')).toBe(4700);
    expect(parseOhms('330')).toBe(330);
    expect(parseOhms('330R')).toBe(330);
    expect(parseOhms('2.2M')).toBe(2.2e6);
    expect(parseOhms('10 Ω')).toBe(10);
    expect(parseOhms('LED')).toBeNull();
  });
  test('capacitance and inductance', () => {
    expect(parseFarads('10uF')).toBeCloseTo(10e-6, 12);
    expect(parseFarads('100n')).toBeCloseTo(100e-9, 12);
    expect(parseFarads('4n7')).toBeCloseTo(4.7e-9, 12);
    expect(parseFarads('0.1µF')).toBeCloseTo(0.1e-6, 12);
    expect(parseHenries('2.2mH')).toBeCloseTo(2.2e-3, 9);
    expect(parseHenries('10uH')).toBeCloseTo(10e-6, 12);
  });
  test('formatSI and reference ordering', () => {
    expect(formatSI(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatSI(0.0000001, 'F')).toBe('100 nF');
    expect(['U10', 'R2', 'U2', 'R10', 'C1'].sort(compareRefs)).toEqual(['C1', 'R2', 'R10', 'U2', 'U10']);
  });
});

describe('gates', () => {
  test('recognises 74xx families and codes', () => {
    expect(icInfo('74LS00')!.spec!.kind).toBe('nand');
    expect(icInfo('SN74HC04N')!.family).toBe('HC');
    expect(icInfo('74LS04')!.spec!.gates).toHaveLength(6);
    expect(icInfo('74LS47')!.spec!.decoder).toBe('7447');
    expect(icInfo('74LS47')!.vcc).toBe(16);
    expect(icInfo('74LS181', 24)!.spec).toBeNull();
    expect(icInfo('74LS181', 24)!.vcc).toBe(24);
    expect(icInfo('LM741')).toBeNull();
    expect(CHIPS['02'].gates[0]).toEqual({ inputs: [2, 3], output: 1 });
  });
});

describe('powerKind', () => {
  test('classifies supply nets', () => {
    expect(powerKind('+5V')).toBe('+');
    expect(powerKind('VCC')).toBe('+');
    expect(powerKind('GND')).toBe('gnd');
    expect(powerKind('/GND')).toBe('gnd');
    expect(powerKind('-12V')).toBe('-');
    expect(powerKind('/A')).toBeNull();
    expect(powerKind('Net-(D1-A)')).toBeNull();
  });
});

describe('classify', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  test('PL1_1 parts', () => {
    expect(classify(d.components.get('U3')!)).toEqual({ kind: 'dip', pins: 14 });
    expect(classify(d.components.get('R1')!)).toMatchObject({ kind: 'lead2', style: 'R', a: '1', b: '2', polarized: false });
    expect(classify(d.components.get('D1')!)).toMatchObject({ kind: 'lead2', style: 'LED', a: '1', b: '2', polarized: true, aLabel: 'K', bLabel: 'A' });
    expect(classify(d.components.get('SW1')!)).toMatchObject({ kind: 'lead2', style: 'SW' });
    expect(classify(d.components.get('J1')!)).toEqual({ kind: 'supply' });
  });

  const extra = makeDesign({
    C1: { lib: 'Device', part: 'C_Polarized', value: '10uF', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', 'GND'] } },
    L1: { lib: 'Device', part: 'L', value: '2.2mH', pins: { '1': ['1', 'passive', '/IN'], '2': ['2', 'passive', '/OUT'] } },
    D3: { lib: 'Diode', part: '1N4148', value: '1N4148', pins: { '1': ['K', 'passive', '/A'], '2': ['A', 'passive', '/B'] } },
    D4: { lib: 'Device', part: 'D_Zener', value: '5V1', pins: { '1': ['K', 'passive', '/A'], '2': ['A', 'passive', 'GND'] } },
    SW3: { lib: 'Switch', part: 'SW_Push', value: 'SW_Push', pins: { '1': ['1', 'passive', '/A'], '2': ['2', 'passive', 'GND'] } },
    SW4: { lib: 'Switch', part: 'SW_DIP_x04', value: 'SW_DIP_x04', pins: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8'].map((p) => [p, ['~', 'passive', `/S${p}`]])) },
    Q1: { lib: 'Transistor_BJT', part: '2N3904', value: '2N3904', pins: { '1': ['E', 'passive', 'GND'], '2': ['B', 'input', '/A'], '3': ['C', 'passive', '/OUT'] } },
    RV1: { lib: 'Device', part: 'R_Potentiometer', value: '10k', pins: { '1': ['1', 'passive', '+5V'], '2': ['2', 'passive', '/W'], '3': ['3', 'passive', 'GND'] } },
    U4: { lib: 'Amplifier_Operational', part: 'LM741', value: 'LM741', pins: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8'].map((p) => [p, ['~', 'passive', `/N${p}`]])) },
    DS1: { lib: 'Display_Character', part: 'D168K', value: 'D168K', pins: { '7': ['A', 'input', '/a'], '6': ['B', 'input', '/b'], '4': ['C', 'input', '/c'], '2': ['D', 'input', '/d'], '1': ['E', 'input', '/e'], '9': ['F', 'input', '/f'], '10': ['G', 'input', '/g'], '5': ['DP', 'input', 'unconnected-(DS1-Pad5)'], '3': ['CC', 'input', 'GND'], '8': ['CC', 'input', 'GND'] } },
    X1: { lib: 'Device', part: 'Crystal_GND24', value: '16MHz', pins: { '1': ['1', 'passive', '/A'], '2': ['2', 'passive', '/B'], '3': ['3', 'passive', 'GND'] } },
    J2: { lib: 'Connector', part: 'Conn_01x02', value: 'FGEN', pins: { '1': ['Pin_1', 'passive', '/IN'], '2': ['Pin_2', 'passive', '/B'] } },
  });
  test('analog and switch parts', () => {
    expect(classify(extra.components.get('C1')!)).toMatchObject({ kind: 'lead2', style: 'Cpol', polarized: true, aLabel: '+' });
    expect(classify(extra.components.get('L1')!)).toMatchObject({ kind: 'lead2', style: 'L' });
    expect(classify(extra.components.get('D3')!)).toMatchObject({ kind: 'lead2', style: 'D', aLabel: 'K' });
    expect(classify(extra.components.get('D4')!)).toMatchObject({ kind: 'lead2', style: 'Z' });
    expect(classify(extra.components.get('SW3')!)).toMatchObject({ kind: 'lead2', style: 'BTN' });
    expect(classify(extra.components.get('SW4')!)).toEqual({ kind: 'dipswitch', positions: 4, pairs: [['1', '8'], ['2', '7'], ['3', '6'], ['4', '5']] });
    expect(classify(extra.components.get('Q1')!)).toEqual({ kind: 'to92', legs: ['1', '2', '3'], names: ['E', 'B', 'C'] });
    expect(classify(extra.components.get('RV1')!)).toEqual({ kind: 'pot3', legs: ['1', '2', '3'] });
    expect(classify(extra.components.get('U4')!)).toEqual({ kind: 'dip', pins: 8 });
    expect(classify(extra.components.get('DS1')!)).toMatchObject({ kind: 'sevenseg', pins: 10, common: 'cathode', commonPins: ['3', '8'] });
    expect((classify(extra.components.get('DS1')!) as { segments: Record<string, string> }).segments).toEqual({ a: '7', b: '6', c: '4', d: '2', e: '1', f: '9', g: '10' });
    expect(classify(extra.components.get('X1')!).kind).toBe('unsupported');
    expect(classify(extra.components.get('J2')!).kind).toBe('unsupported');
  });
});
