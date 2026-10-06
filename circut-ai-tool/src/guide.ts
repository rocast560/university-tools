// Ordered build steps, chip pinouts and a parts list from a layout.

import { holeName, isRail, stripOf } from './layout/board.ts';
import type { EngineResult } from './layout/engine.ts';
import type { Hole, PlacedPart, Wire } from './layout/types.ts';
import type { Design } from './netlist.ts';
import { displayName, isUnconnected } from './netlist.ts';
import { icInfo } from './parts/gates.ts';
import { compareRefs } from './parts/values.ts';
import type { SimModel } from './sim/index.ts';

export interface Step {
  n: number;
  phase: 'Chips' | 'Power' | 'Inputs' | 'Signals' | 'Outputs' | 'Other';
  kind: 'chip' | 'supply' | 'wire' | 'part';
  ref?: string;
  net?: string;
  wire?: number;
  label: string;
}

export interface Pinout {
  ref: string;
  name: string;
  pins: { num: number; function: string; net: string; hole: string; used: boolean }[];
}

const STYLE_NAMES: Record<string, string> = { R: 'resistor', C: 'capacitor', Cpol: 'electrolytic capacitor', L: 'inductor', D: 'diode', Z: 'Zener diode', LED: 'LED', SW: 'switch', BTN: 'pushbutton', X: 'part', POT: 'potentiometer' };

export function buildSteps(design: Design, res: EngineResult, sim: SimModel): Step[] {
  const stripPins = new Map<string, { ref: string; pin: string }[]>();
  for (const [ref, pins] of Object.entries(res.pinHoles)) for (const [pin, h] of Object.entries(pins)) stripPins.set(stripOf(h), [...(stripPins.get(stripOf(h)) ?? []), { ref, pin }]);
  const isChip = (ref: string) => res.footprints[ref]?.kind === 'dip' || res.footprints[ref]?.kind === 'sevenseg';
  const chipStrips = new Set([...stripPins.entries()].filter(([, ps]) => ps.some((p) => isChip(p.ref))).map(([s]) => s));
  const hint = (h: Hole) => {
    if (isRail(h.row)) return '';
    const ps = (stripPins.get(stripOf(h)) ?? []).filter((p) => isChip(p.ref));
    return ps.length ? ` (${ps[0].ref} pin ${ps[0].pin})` : '';
  };
  const hn = (h: Hole) => holeName(h);
  const steps: Step[] = [];
  const wireStep = (phase: Step['phase'], i: number, text?: string) => {
    const w = res.wires[i];
    steps.push({ n: 0, phase, kind: 'wire', net: w.net, wire: i, label: text ?? `${displayName(w.net)}: ${hn(w.a)}${hint(w.a)} to ${hn(w.b)}${hint(w.b)}.` });
  };
  const partStep = (phase: Step['phase'], p: PlacedPart) => {
    let text: string;
    if (p.style === 'LED') text = `${p.id}: cathode (flat edge, short leg) in ${hn(p.holes[0])}${hint(p.holes[0])}, anode in ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else if (p.kind === 'lead2' && p.polarized) text = `${p.id} (${p.value}): ${p.labels[0]} side in ${hn(p.holes[0])}${hint(p.holes[0])}, ${p.labels[1]} side in ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else if (p.kind === 'lead2') text = `${p.id} (${p.value}): ${hn(p.holes[0])}${hint(p.holes[0])} to ${hn(p.holes[1])}${hint(p.holes[1])}.`;
    else text = `${p.id} (${p.value}): ${p.labels.map((l, i) => `${l} in ${hn(p.holes[i])}${hint(p.holes[i])}`).join(', ')}, flat face toward you.`;
    steps.push({ n: 0, phase, kind: 'part', ref: p.id, label: text });
  };

  for (const pkg of res.packages) {
    if (pkg.kind === 'module') {
      const row = pkg.row ?? 'a';
      const side = row === 'j' ? 'bottom' : 'top';
      const last = pkg.col0 + pkg.pins - 1;
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `${pkg.id}: plug the L3 board's 15-pin header into row ${row}, columns ${pkg.col0}-${last}, VCC in ${row}${pkg.col0} and D in ${row}${last}, chip facing up and the board hanging out over the ${side} rails and off the ${side} edge of the breadboard. Header order is VCC, GND, W, X, Y, Z, separator, ~W, ~X, ~Y, ~Z, A, B, C, D; leave position 7 (${row}${pkg.col0 + 6}) unwired. The board covers the ${side} rail holes in columns ${pkg.col0 - 2}-${last + 2}, so rail jumpers land outside that span. Outputs are active low. Inputs 10-15 are unspecified.` });
    } else if (pkg.kind === 'sevenseg') {
      const half = pkg.pins / 2;
      const last = pkg.col0 + half - 1;
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `Place ${pkg.id} (${pkg.name}) across the gutter, decimal point at the bottom, pin 1 in g${pkg.col0}. Pins 1 to ${half} sit in row g, columns ${pkg.col0} to ${last}; pins ${half + 1} to ${pkg.pins} in row d, columns ${last} down to ${pkg.col0}. Its body covers rows c to h in those columns, so its jumpers go in rows a, b, i and j. Check the pinout of your actual display before wiring the segments.` });
    } else if (pkg.kind === 'dip') {
      const half = pkg.pins / 2;
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `Place ${pkg.id} (${pkg.name}) across the gutter, notch on the left, pin 1 in f${pkg.col0}. Pins 1 to ${half} sit in row f, columns ${pkg.col0} to ${pkg.col0 + half - 1}; pins ${half + 1} to ${pkg.pins} in row e, columns ${pkg.col0 + half - 1} down to ${pkg.col0}.` });
    } else {
      // The nets a position joins, so a way that is wired to nothing can say
      // it is spare rather than claim to be an input.
      const netsOf = (ref: string, pos: string) => {
        const comp = design.components.get(ref);
        const fp = res.footprints[ref];
        if (!comp || fp?.kind !== 'dipswitch') return [];
        return (fp.pairs[Number(pos) - 1] ?? []).map((pin) => comp.pins.get(pin)?.net).filter((net): net is string => !!net);
      };
      const who = Object.entries(pkg.map ?? {}).map(([k, ref]) => {
        const where = `position ${k} (column ${pkg.col0 + Number(k) - 1})`;
        const inp = sim.inputs.find((i) => i.control === `DIP position ${k}` || i.control === `${ref} position ${k}`);
        if (inp) return `${where} is input ${inp.name}`;
        const joined = netsOf(ref, k);
        if (joined.length && joined.every(isUnconnected)) return `${where} is spare, leave it alone`;
        return `${where} is input ${ref}`;
      });
      // A real DIP switch is a part with a reference; a folded one only stands
      // in for the separate switches the schematic actually has.
      const which = design.components.has(pkg.id) ? `${pkg.id} (${pkg.name})` : `the ${pkg.name}`;
      steps.push({ n: 0, phase: 'Chips', kind: 'chip', ref: pkg.id, label: `Place ${which} across the gutter with its pins in e${pkg.col0} to e${pkg.col0 + (pkg.positions ?? 1) - 1} and f${pkg.col0} to f${pkg.col0 + (pkg.positions ?? 1) - 1}; ${who.join('; ')}. A position set to ON joins its top pin to its bottom pin.` });
    }
  }
  if (res.supply) {
    steps.push({ n: 0, phase: 'Power', kind: 'supply', ref: 'PSU', label: `Connect the supply: ${res.supply.leads.map((l) => `${displayName(l.net)} lead into the ${hn(l.hole)}`).join(', ')}. A bench supply or USB is fine; nothing else is powered directly.` });
  }
  res.wires.forEach((w, i) => {
    if (w.role === 'bridge') wireStep('Power', i, `Bridge the ${hn(w.a)} to the ${hn(w.b)}.`);
  });
  res.wires.forEach((w, i) => {
    if (w.role === 'split') wireStep('Power', i, `Rail split: ${hn(w.a)} to ${hn(w.b)}. Most full-size boards break every rail in the middle; skip only if yours run the full length.`);
  });
  const powerWires = res.wires.map((w, i) => [w, i] as [Wire, number]).filter(([w]) => w.role === 'power').sort((x, y) => x[0].a.col - y[0].a.col);
  for (const [w, i] of powerWires) if (chipStrips.has(stripOf(w.a))) wireStep('Power', i);
  const inputNets = new Set(sim.inputs.map((i) => i.net));
  const done = new Set<string>();
  const inputParts = res.parts.filter((p) => p.nets.some((n) => inputNets.has(n)));
  for (const p of inputParts) {
    partStep('Inputs', p);
    done.add(p.id);
  }
  for (const [w, i] of powerWires) if (!chipStrips.has(stripOf(w.a))) wireStep('Inputs', i, `${displayName(w.net)}: ${hn(w.a)} to the ${hn(w.b)}.`);
  const depth = new Map<string, number>();
  for (const n of inputNets) depth.set(n, 0);
  for (let k = 0; k <= sim.gates.length; k++) {
    for (const g of sim.gates) {
      const d = 1 + Math.max(0, ...g.inputs.map((n) => depth.get(n) ?? 0));
      if (depth.get(g.output) !== d) depth.set(g.output, d);
    }
  }
  const signalWires = res.wires.map((w, i) => [w, i] as [Wire, number]).filter(([w]) => w.role === 'signal').sort((x, y) => (depth.get(x[0].net) ?? 99) - (depth.get(y[0].net) ?? 99) || displayName(x[0].net).localeCompare(displayName(y[0].net)) || x[0].a.col - y[0].a.col);
  for (const [, i] of signalWires) wireStep('Signals', i);
  for (const p of res.parts) {
    if (done.has(p.id) || p.style !== 'LED') continue;
    partStep('Outputs', p);
    done.add(p.id);
    for (const qd of res.parts) {
      if (done.has(qd.id) || !p.nets.some((n) => !isUnconnected(n) && qd.nets.includes(n))) continue;
      partStep('Outputs', qd);
      done.add(qd.id);
    }
  }
  for (const p of res.parts) {
    if (done.has(p.id)) continue;
    partStep('Other', p);
    done.add(p.id);
  }
  steps.forEach((s, i) => (s.n = i + 1));
  return steps;
}

export function buildPinouts(design: Design, res: EngineResult): Pinout[] {
  const out: Pinout[] = [];
  for (const pkg of res.packages) {
    if (pkg.kind === 'dipswitch') continue;
    const comp = design.components.get(pkg.id);
    if (!comp) continue;
    const func: Record<string, string> = {};
    const info = pkg.kind === 'dip' ? icInfo(res.values[pkg.id] ?? comp.value, pkg.pins) : null;
    if (info) {
      func[String(info.vcc)] = 'VCC';
      func[String(info.gnd)] = 'GND';
      info.spec?.gates.forEach((g, i) => {
        for (const n of g.inputs) func[String(n)] = `Gate ${i + 1} in`;
        func[String(g.output)] = `Gate ${i + 1} out`;
      });
    }
    const pins = [...comp.pins.values()]
      .filter((p) => /^\d+$/.test(p.num))
      .sort((a, b) => Number(a.num) - Number(b.num))
      .map((p) => {
        const h = res.pinHoles[pkg.id]?.[p.num];
        const used = !isUnconnected(p.net);
        return { num: Number(p.num), function: func[p.num] ?? (p.name && p.name !== '~' ? p.name : 'pin'), net: used ? displayName(p.net) : '', hole: h ? holeName(h) : '', used };
      });
    out.push({ ref: pkg.id, name: pkg.name, pins });
  }
  return out;
}

/** The little picture beside a parts-list row. */
export type PartIcon =
  | { kind: 'chip'; pins: number; label: string }
  | { kind: 'dipswitch'; positions: number }
  | { kind: 'sevenseg' }
  | { kind: 'resistor'; value: string }
  | { kind: 'led'; ref: string }
  | { kind: 'wire' }
  | { kind: 'part'; style: string };

export interface PartsItem {
  text: string;
  icon: PartIcon;
}

export function buildPartsList(res: EngineResult): PartsItem[] {
  const items: PartsItem[] = [];
  for (const pkg of res.packages) {
    if (pkg.kind === 'dip') {
      const info = icInfo(pkg.name, pkg.pins);
      items.push({ text: `1 × ${pkg.name} ${info?.spec?.description ?? `${pkg.pins}-pin DIP`} (${pkg.id})`, icon: { kind: 'chip', pins: pkg.pins, label: pkg.name } });
    } else if (pkg.kind === 'sevenseg') items.push({ text: `1 × ${pkg.name} 7-segment display, common ${pkg.common} (${pkg.id})`, icon: { kind: 'sevenseg' } });
    else if (pkg.kind === 'dipswitch') items.push({ text: `1 × ${pkg.name}${pkg.map ? ` (positions ${Object.keys(pkg.map).join(', ')} used)` : ''}`, icon: { kind: 'dipswitch', positions: pkg.positions ?? pkg.pins / 2 } });
    else items.push({ text: `1 × ${pkg.name}`, icon: { kind: 'chip', pins: pkg.pins, label: pkg.name } });
  }
  const groups = new Map<string, string[]>();
  for (const p of res.parts) {
    const k = `${p.style} ${p.value}`;
    groups.set(k, [...(groups.get(k) ?? []), p.id]);
  }
  for (const [k, refs] of [...groups.entries()].sort()) {
    const [style, value] = k.split(' ');
    const name = STYLE_NAMES[style] ?? (style.length === 3 ? 'transistor' : 'part');
    refs.sort(compareRefs);
    const icon: PartIcon = style === 'R' ? { kind: 'resistor', value } : style === 'LED' ? { kind: 'led', ref: refs[0] } : { kind: 'part', style };
    items.push({ text: `${refs.length} × ${value} ${name} (${refs.join(', ')})`, icon });
  }
  items.push({ text: `About ${res.wires.length} jumper wires, ${res.supply ? res.supply.leads.map((l) => displayName(l.net)).join(' and ') + ' supply' : 'no supply'}, a ${res.board.kind}-size breadboard`, icon: { kind: 'wire' } });
  return items;
}
