// Combinational logic simulation over the design nets: 74xx gates, 7447/7448
// decoders, LEDs and 7-segment displays. Inputs are the nets controlled by
// switches. Anything else is placed and checked but reported as not simulated.

import type { EngineResult } from '../layout/engine.ts';
import type { Design } from '../netlist.ts';
import { displayName, isAutoNamed, isUnconnected } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { DECODER_PINS, icInfo, type GateKind } from '../parts/gates.ts';

export interface SimInput {
  name: string;
  net: string;
  control: string;
  activeLow: boolean;
}

export interface SimGate {
  name: string;
  kind: GateKind;
  inputs: string[];
  output: string;
  ref: string;
  pins: { inputs: number[]; output: number };
}

export interface SimDecoder {
  ref: string;
  kind: '7447' | '7448';
  inputs: Record<'A' | 'B' | 'C' | 'D', string>;
  lampTest: string;
  blanking: string;
  outputs: Record<string, string>;
}

export interface SimLed {
  ref: string;
  cathode: string;
  anode: string;
}

export interface SimDisplay {
  ref: string;
  common: 'cathode' | 'anode';
  segments: Record<string, string>;
  commonNets: string[];
}

export interface SimModel {
  inputs: SimInput[];
  gates: SimGate[];
  decoders: SimDecoder[];
  leds: SimLed[];
  displays: SimDisplay[];
  resistors: [string, string][];
  power: Record<string, 0 | 1>;
  notSimulated: string[];
}

export interface SimResult {
  nets: Record<string, 0 | 1>;
  leds: Record<string, boolean>;
  segments: Record<string, Record<string, boolean>>;
}

export interface TruthTable {
  inputs: string[];
  outputs: string[];
  leds: string[];
  rows: { inputs: number[]; outputs: number[]; leds: boolean[] }[];
}

/** Segments lit for digits 0-9 (a b c d e f g). */
export const SEGMENT_DIGITS: Record<number, string> = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

export function evalGate(kind: GateKind, values: number[]): 0 | 1 {
  const all = values.every((v) => v === 1);
  const any = values.some((v) => v === 1);
  const ones = values.filter((v) => v === 1).length;
  switch (kind) {
    case 'and':
      return all ? 1 : 0;
    case 'nand':
      return all ? 0 : 1;
    case 'or':
      return any ? 1 : 0;
    case 'nor':
      return any ? 0 : 1;
    case 'not':
      return values[0] === 1 ? 0 : 1;
    case 'xor':
      return ones % 2 === 1 ? 1 : 0;
    case 'xnor':
      return ones % 2 === 1 ? 0 : 1;
  }
}

export function buildSimModel(design: Design, res: EngineResult): SimModel {
  const model: SimModel = { inputs: [], gates: [], decoders: [], leds: [], displays: [], resistors: [], power: {}, notSimulated: [] };
  for (const n of res.power.plus) model.power[n] = 1;
  for (const n of res.power.gnd) model.power[n] = 0;
  for (const n of res.power.minus) model.power[n] = 0;
  const seenInput = new Set<string>();
  const addInput = (net: string, other: string, control: string) => {
    if (powerKind(net) || isUnconnected(net) || seenInput.has(net)) return;
    seenInput.add(net);
    model.inputs.push({ name: displayName(net), net, control, activeLow: powerKind(other) !== '+' });
  };
  const dipPosition = new Map<string, string>();
  for (const pkg of res.packages) if (pkg.kind === 'dipswitch' && pkg.map) for (const [pos, ref] of Object.entries(pkg.map)) if (pkg.id === 'SW') dipPosition.set(ref, `DIP position ${pos}`);

  const refs = Object.keys(res.footprints).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const ref of refs) {
    const fp = res.footprints[ref];
    const comp = design.components.get(ref);
    if (!comp) continue;
    const net = (pin: string) => comp.pins.get(pin)?.net ?? `unconnected-(${ref}-Pad${pin})`;
    switch (fp.kind) {
      case 'lead2': {
        if (fp.style === 'SW' || fp.style === 'BTN') {
          addInput(net(fp.a), net(fp.b), dipPosition.get(ref) ?? ref);
          addInput(net(fp.b), net(fp.a), dipPosition.get(ref) ?? ref);
        } else if (fp.style === 'LED') model.leds.push({ ref, cathode: net(fp.a), anode: net(fp.b) });
        else if (fp.style === 'R') model.resistors.push([net(fp.a), net(fp.b)]);
        else model.notSimulated.push(`${ref} (${res.values[ref]})`);
        break;
      }
      case 'dipswitch':
        fp.pairs.forEach(([a, b], i) => {
          addInput(net(a), net(b), `${ref} position ${i + 1}`);
          addInput(net(b), net(a), `${ref} position ${i + 1}`);
        });
        break;
      case 'sevenseg': {
        const segments: Record<string, string> = {};
        for (const [seg, pin] of Object.entries(fp.segments)) segments[seg] = net(pin);
        model.displays.push({ ref, common: fp.common, segments, commonNets: fp.commonPins.map(net) });
        break;
      }
      case 'dip': {
        const info = icInfo(res.values[ref] ?? comp.value, fp.pins);
        if (!info?.spec) {
          model.notSimulated.push(`${ref} (${res.values[ref] ?? comp.value})`);
          break;
        }
        if (info.spec.decoder) {
          const p = DECODER_PINS;
          const outputs: Record<string, string> = {};
          for (const [seg, pin] of Object.entries(p.outputs)) outputs[seg] = net(String(pin));
          model.decoders.push({ ref, kind: info.spec.decoder, inputs: { A: net(String(p.inputs.A)), B: net(String(p.inputs.B)), C: net(String(p.inputs.C)), D: net(String(p.inputs.D)) }, lampTest: net(String(p.lampTest)), blanking: net(String(p.blanking)), outputs });
          break;
        }
        info.spec.gates.forEach((g, i) => {
          const out = net(String(g.output));
          if (isUnconnected(out)) return;
          model.gates.push({ name: `${ref}${String.fromCharCode(65 + i)}`, kind: info.spec!.kind!, inputs: g.inputs.map((n) => net(String(n))), output: out, ref, pins: { inputs: g.inputs, output: g.output } });
        });
        break;
      }
      case 'to92':
      case 'pot3':
        model.notSimulated.push(`${ref} (${res.values[ref] ?? comp.value})`);
        break;
      default:
        break;
    }
  }
  model.inputs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return model;
}

export function simulate(model: SimModel, levels: Record<string, 0 | 1>): SimResult {
  const L: Record<string, 0 | 1> = { ...model.power };
  for (const i of model.inputs) L[i.net] = i.activeLow ? 1 : 0;
  Object.assign(L, levels);
  const val = (net: string): 0 | 1 => L[net] ?? 1; // an open TTL input reads high
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const g of model.gates) {
      const out = evalGate(g.kind, g.inputs.map(val));
      if (L[g.output] !== out) {
        L[g.output] = out;
        changed = true;
      }
    }
    for (const dec of model.decoders) {
      const digit = val(dec.inputs.A) + 2 * val(dec.inputs.B) + 4 * val(dec.inputs.C) + 8 * val(dec.inputs.D);
      const lit = val(dec.lampTest) === 0 ? 'abcdefg' : val(dec.blanking) === 0 ? '' : (SEGMENT_DIGITS[digit] ?? '');
      for (const [seg, net] of Object.entries(dec.outputs)) {
        const on = lit.includes(seg);
        const out: 0 | 1 = dec.kind === '7447' ? (on ? 0 : 1) : on ? 1 : 0;
        if (L[net] !== out) {
          L[net] = out;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // A net that is only reached through a resistor takes the level of the far side.
  const term = (net: string): 0 | 1 | null => {
    if (L[net] !== undefined) return L[net];
    for (const [a, b] of model.resistors) {
      if (a === net && L[b] !== undefined) return L[b];
      if (b === net && L[a] !== undefined) return L[a];
    }
    return null;
  };
  const leds: Record<string, boolean> = {};
  for (const led of model.leds) leds[led.ref] = term(led.anode) === 1 && term(led.cathode) === 0;
  const segments: Record<string, Record<string, boolean>> = {};
  for (const disp of model.displays) {
    const commonLevel = disp.commonNets.map(term).find((v) => v !== null) ?? (disp.common === 'cathode' ? 0 : 1);
    const segs: Record<string, boolean> = {};
    for (const [seg, net] of Object.entries(disp.segments)) {
      const lv = term(net);
      segs[seg] = disp.common === 'cathode' ? lv === 1 && commonLevel === 0 : lv === 0 && commonLevel === 1;
    }
    segments[disp.ref] = segs;
  }
  return { nets: L, leds, segments };
}

export function truthTable(model: SimModel, maxInputs = 6): TruthTable | null {
  const inputs = model.inputs;
  if (!inputs.length || inputs.length > maxInputs) return null;
  const outputNets = [...new Set([...model.gates.map((g) => g.output), ...model.decoders.flatMap((d) => Object.values(d.outputs))])]
    .filter((n) => !isAutoNamed(n) && !isUnconnected(n))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
  const leds = model.leds.map((l) => l.ref);
  const rows: TruthTable['rows'] = [];
  for (let code = 0; code < 1 << inputs.length; code++) {
    const levels: Record<string, 0 | 1> = {};
    const bits = inputs.map((inp, i) => {
      const bit = ((code >> (inputs.length - 1 - i)) & 1) as 0 | 1;
      levels[inp.net] = bit;
      return bit;
    });
    const r = simulate(model, levels);
    rows.push({ inputs: bits, outputs: outputNets.map((n) => r.nets[n] ?? 1), leds: leds.map((ref) => r.leds[ref]) });
  }
  return { inputs: inputs.map((i) => i.name), outputs: outputNets.map(displayName), leds, rows };
}
