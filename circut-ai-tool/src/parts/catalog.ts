// lib_id + value + pins -> breadboard footprint.

import type { Component } from '../netlist.ts';
import { displayName } from '../netlist.ts';

export type Lead2Style = 'R' | 'C' | 'Cpol' | 'L' | 'D' | 'Z' | 'LED' | 'SW' | 'BTN' | 'X';

export type Footprint =
  | { kind: 'dip'; pins: number }
  | { kind: 'lead2'; style: Lead2Style; a: string; b: string; polarized: boolean; aLabel: string; bLabel: string }
  | { kind: 'to92'; legs: [string, string, string]; names: [string, string, string] }
  | { kind: 'pot3'; legs: [string, string, string] }
  | { kind: 'dipswitch'; positions: number; pairs: [string, string][] }
  | { kind: 'sevenseg'; pins: number; common: 'cathode' | 'anode'; segments: Record<string, string>; commonPins: string[] }
  | { kind: 'power' }
  | { kind: 'supply' }
  | { kind: 'unsupported'; reason: string };

export type PowerKind = '+' | '-' | 'gnd' | null;

export function powerKind(net: string): PowerKind {
  const n = displayName(net);
  if (/^(GND\w*|GNDREF|0|VSS|AGND|DGND)$/i.test(n)) return 'gnd';
  if (/^\+/.test(n) || /^(VCC\w*|VDD\w*|5V|3V3|12V)$/i.test(n)) return '+';
  if (/^-/.test(n) || /^(VEE)$/i.test(n)) return '-';
  return null;
}

const numeric = (pins: string[]) => pins.every((p) => /^\d+$/.test(p));
const byNumber = (a: string, b: string) => Number(a) - Number(b);

export function classify(comp: Component): Footprint {
  const { lib, part, ref } = comp;
  const P = part.toUpperCase();
  const pinNums = [...comp.pins.keys()].sort(byNumber);
  const n = pinNums.length;
  if (ref.startsWith('#') || lib === 'power') return { kind: 'power' };
  if (lib.startsWith('Connector') || P.startsWith('CONN') || ref.startsWith('J')) {
    return [...comp.pins.values()].some((p) => powerKind(p.net))
      ? { kind: 'supply' }
      : { kind: 'unsupported', reason: 'connectors without a power net are not placed on the breadboard; name the nets instead' };
  }
  const dip = /^SW_DIP_X(\d+)$/.exec(P);
  if (dip) {
    const k = Number(dip[1]);
    return { kind: 'dipswitch', positions: k, pairs: Array.from({ length: k }, (_, i) => [String(i + 1), String(2 * k - i)] as [string, string]) };
  }
  if (lib === 'Display_Character') {
    const segments: Record<string, string> = {};
    const commonPins: string[] = [];
    let common: 'cathode' | 'anode' = 'cathode';
    for (const p of comp.pins.values()) {
      const nm = p.name.toUpperCase();
      if (/^[A-G]$/.test(nm)) segments[nm.toLowerCase()] = p.num;
      else if (/^(CC|K|COM|CATHODE|COMMON)$/.test(nm)) commonPins.push(p.num);
      else if (/^(CA|A|ANODE|COM\+)$/.test(nm)) {
        commonPins.push(p.num);
        common = 'anode';
      }
    }
    commonPins.sort(byNumber);
    if (Object.keys(segments).length >= 7 && n % 2 === 0 && numeric(pinNums)) return { kind: 'sevenseg', pins: n, common, segments, commonPins };
    return { kind: 'unsupported', reason: `display ${part} has ${n} pins; only 7-segment displays with an even pin count are supported` };
  }
  if (n === 2) {
    const [a, b] = pinNums;
    const lead = (style: Lead2Style, polarized = false, aLabel = '', bLabel = ''): Footprint => ({ kind: 'lead2', style, a, b, polarized, aLabel, bLabel });
    if (lib === 'Device' && P.startsWith('R') && !P.startsWith('R_POT')) return lead('R');
    if (lib === 'Device' && P.startsWith('C_POLARIZED')) return lead('Cpol', true, '+', '−');
    if (lib === 'Device' && P.startsWith('C')) return lead('C');
    if (lib === 'Device' && P.startsWith('LED')) return lead('LED', true, 'K', 'A');
    if (lib === 'Device' && P.startsWith('L')) return lead('L');
    if (lib === 'Device' && P.startsWith('D_ZENER')) return lead('Z', true, 'K', 'A');
    if ((lib === 'Device' && P.startsWith('D')) || lib === 'Diode') return lead('D', true, 'K', 'A');
    if (P.startsWith('SW_PUSH')) return lead('BTN');
    if (lib === 'Switch' || P.startsWith('SW')) return lead('SW');
    return lead('X');
  }
  if (n === 3 && (lib.startsWith('Transistor') || P.startsWith('Q_'))) {
    const legs = pinNums as [string, string, string];
    return { kind: 'to92', legs, names: legs.map((p) => comp.pins.get(p)!.name.toUpperCase()) as [string, string, string] };
  }
  if (n === 3 && P.startsWith('R_POT')) return { kind: 'pot3', legs: pinNums as [string, string, string] };
  if (n >= 4 && n % 2 === 0 && numeric(pinNums)) return { kind: 'dip', pins: n };
  return { kind: 'unsupported', reason: `${part} has ${n} pins${numeric(pinNums) ? '' : ' with non-numeric pin numbers'}; no breadboard footprint for it` };
}
