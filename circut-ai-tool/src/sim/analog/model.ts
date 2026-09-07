// Turn a laid-out board into a list of analog devices over the physical
// breadboard graph.
//
// Nodes are the union-find roots of breadboard strips and rails, exactly as
// the wiring checks compute them, so a part is connected to whatever its legs
// actually touch. That makes the simulation model what the user built rather
// than what the schematic says, and it is the only model a hand-placed part
// with no schematic net can participate in.

import { connectivity, holeNode, supplyVolts } from '../../checks/index.ts';
import type { EngineResult } from '../../layout/engine.ts';
import type { Hole } from '../../layout/types.ts';
import type { Design } from '../../netlist.ts';
import { DECODER_PINS, icInfo, type GateKind } from '../../parts/gates.ts';
import { parseFarads, parseHenries, parseOhms } from '../../parts/values.ts';
import type { Device } from './dc.ts';
import type { Family } from './digital.ts';
import { diodeFor, diodeForColour } from './nonlinear.ts';

/** One logic gate, with its pins already resolved to breadboard nodes. */
export interface AnalogGate {
  name: string;
  kind: GateKind;
  inputs: string[];
  output: string;
}

export interface AnalogDecoder {
  kind: '7447' | '7448';
  inputs: Record<'A' | 'B' | 'C' | 'D', string>;
  lampTest: string;
  blanking: string;
  /** Segment letter -> node. */
  outputs: Record<string, string>;
}

/** A logic chip placed on the board, as the mixed solver sees it. */
export interface AnalogChip {
  ref: string;
  code: string;
  family: Family;
  vccNode: string;
  gndNode: string;
  gates: AnalogGate[];
  decoder: AnalogDecoder | null;
  /** Every input pin of the chip, for the input load. */
  inputNodes: string[];
  iccMax: number;
}

export interface AnalogModel {
  devices: Device[];
  /** The reference node, held at 0 V. */
  ground: string;
  /** ref -> pin number -> node id. */
  pinNodes: Record<string, Record<string, string>>;
  /** node id -> the schematic net name on it, where there is one. */
  netOf: Record<string, string>;
  /** schematic net name -> node id. */
  nodeOfNet: Record<string, string>;
  /** Logic chips on the board. */
  chips: AnalogChip[];
  /** Parts that were placed but have no analog model yet. */
  notModelled: string[];
  /**
   * Largest integration step that still resolves this circuit's dynamics, in
   * seconds. Infinity when nothing in it can change on its own, which is the
   * common case for a board of gates and LEDs: then one solve per frame is
   * not an approximation, it is the whole answer.
   */
  dtMax: number;
}

/** Fallbacks when a part's value cannot be parsed. */
export const DEFAULT_OHMS = 1000;
export const DEFAULT_FARADS = 100e-9;
export const DEFAULT_HENRIES = 1e-3;

/** Steps per time constant, and per source period, needed to resolve a curve. */
const STEPS_PER_TAU = 20;

/**
 * The largest step that still resolves what this circuit can do.
 *
 * A board with no reactive elements and no time-varying source has no
 * dynamics at all: its answer is the same whenever you ask, so one solve per
 * frame is exact rather than coarse. Deriving this instead of fixing it is
 * what keeps a plain board of gates and LEDs running in real time.
 */
export function stepCeiling(devices: Device[]): number {
  let dt = Infinity;
  const resistance = (a: string, b: string) => {
    let best = Infinity;
    for (const d of devices) {
      if (d.kind === 'resistor' && ((d.a === a && d.b === b) || (d.a === b && d.b === a))) best = Math.min(best, d.ohms);
      else if (d.kind === 'resistor' && (d.a === a || d.b === a || d.a === b || d.b === b)) best = Math.min(best, d.ohms);
    }
    return Number.isFinite(best) ? best : 1000;
  };
  for (const d of devices) {
    if (d.kind === 'capacitor') dt = Math.min(dt, (resistance(d.a, d.b) * d.farads) / STEPS_PER_TAU);
    else if (d.kind === 'inductor') dt = Math.min(dt, d.henries / resistance(d.a, d.b) / STEPS_PER_TAU);
    else if (d.kind === 'vsource' && d.source && d.source.wave !== 'dc') {
      const hz = d.source.wave === 'pulse' ? 1 / Math.max(d.source.period, 1e-9) : d.source.hz;
      dt = Math.min(dt, 1 / (STEPS_PER_TAU * Math.max(hz, 1e-6)));
    }
  }
  return dt;
}

export function buildAnalogModel(design: Design, res: EngineResult, switches: Record<string, boolean> = {}): AnalogModel {
  const uf = connectivity(res);
  const node = (h: Hole): string => uf.find(holeNode(h, res.board));
  const devices: Device[] = [];
  const pinNodes: Record<string, Record<string, string>> = {};
  const netOf: Record<string, string> = {};
  const chips: AnalogChip[] = [];
  const notModelled: string[] = [];

  // Ground first: every gnd net collapses onto one reference node.
  const gndNets = res.power.gnd.length ? res.power.gnd : [res.power.gndName];
  const ground = uf.find(`PSU:${gndNets[0]}`);
  for (const g of gndNets) netOf[uf.find(`PSU:${g}`)] = g;

  // One supply source per positive/negative rail, referenced to ground.
  for (const net of [...res.power.plus, ...res.power.minus]) {
    const n = uf.find(`PSU:${net}`);
    netOf[n] = net;
    if (n === ground) continue;
    const volts = res.power.minus.includes(net) ? -supplyVolts(net) : supplyVolts(net);
    devices.push({ kind: 'vsource', ref: `PSU:${net}`, pos: n, neg: ground, volts });
  }

  // Record where every placed pin sits, and label its node with the schematic
  // net when the pin has one.
  for (const [ref, pins] of Object.entries(res.pinHoles)) {
    const map: Record<string, string> = {};
    for (const [pin, h] of Object.entries(pins)) {
      const n = node(h);
      map[pin] = n;
      const net = design.components.get(ref)?.pins.get(pin)?.net;
      if (net && !netOf[n] && !net.startsWith('unconnected-')) netOf[n] = net;
    }
    pinNodes[ref] = map;
  }

  for (const ref of Object.keys(res.pinHoles).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const fp = res.footprints[ref];
    const value = res.values[ref] ?? design.components.get(ref)?.value ?? '';
    const at = (pin: string) => pinNodes[ref]?.[pin];
    if (!fp) continue;
    if (fp.kind === 'lead2') {
      const a = at(fp.a);
      const b = at(fp.b);
      if (a === undefined || b === undefined) continue;
      if (fp.style === 'R') devices.push({ kind: 'resistor', ref, a, b, ohms: parseOhms(value) ?? DEFAULT_OHMS });
      else if (fp.style === 'SW' || fp.style === 'BTN') devices.push({ kind: 'switch', ref, a, b, closed: !!switches[ref] });
      // classify() puts the cathode on the `a` pin for every polarised
      // two-lead part, so `a` is K and `b` is A. The boolean simulator reads
      // them the same way round.
      // A colour chosen on the board overrides the schematic value, and it is
      // a real electrical choice: blue sits about 1.2 V higher than red, so
      // the same series resistor gives noticeably less current.
      else if (fp.style === 'LED') devices.push({ ...(res.ledColors?.[ref] ? diodeForColour(res.ledColors[ref]) : diodeFor(value || 'LED')), ref, anode: b, cathode: a });
      else if (fp.style === 'D' || fp.style === 'Z') devices.push({ ...diodeFor(value), ref, anode: b, cathode: a });
      else if (fp.style === 'C' || fp.style === 'Cpol') devices.push({ kind: 'capacitor', ref, a, b, farads: parseFarads(value) ?? DEFAULT_FARADS });
      else if (fp.style === 'L') devices.push({ kind: 'inductor', ref, a, b, henries: parseHenries(value) ?? DEFAULT_HENRIES });
      else notModelled.push(`${ref} (${value})`);
    } else if (fp.kind === 'dip') {
      const info = icInfo(value, fp.pins);
      const spec = info?.spec;
      if (!spec) {
        notModelled.push(`${ref} (${value})`);
        continue;
      }
      const vccNode = at(String(info.vcc));
      const gndNode = at(String(info.gnd));
      if (vccNode === undefined || gndNode === undefined) {
        notModelled.push(`${ref} (${value})`);
        continue;
      }
      const inputNodes: string[] = [];
      const gates: AnalogGate[] = [];
      spec.gates.forEach((g, i) => {
        const out = at(String(g.output));
        const ins = g.inputs.map((pin) => at(String(pin)));
        if (out === undefined || ins.some((x) => x === undefined)) return;
        inputNodes.push(...ins);
        gates.push({ name: `${ref}${String.fromCharCode(65 + i)}`, kind: spec.kind!, inputs: ins, output: out });
      });
      let decoder: AnalogDecoder | null = null;
      if (spec.decoder) {
        const p = DECODER_PINS;
        const outputs: Record<string, string> = {};
        for (const [seg, pin] of Object.entries(p.outputs)) outputs[seg] = at(String(pin));
        const ins = { A: at(String(p.inputs.A)), B: at(String(p.inputs.B)), C: at(String(p.inputs.C)), D: at(String(p.inputs.D)) };
        decoder = { kind: spec.decoder, inputs: ins, lampTest: at(String(p.lampTest)), blanking: at(String(p.blanking)), outputs };
        inputNodes.push(...Object.values(ins), decoder.lampTest, decoder.blanking);
      }
      chips.push({ ref, code: spec.code, family: info.family, vccNode, gndNode, gates, decoder, inputNodes: inputNodes.filter(Boolean), iccMax: spec.iccMax });
    } else notModelled.push(`${ref} (${value})`);
  }

  const nodeOfNet: Record<string, string> = {};
  for (const [node, net] of Object.entries(netOf)) if (nodeOfNet[net] === undefined) nodeOfNet[net] = node;

  return { devices, ground, pinNodes, netOf, nodeOfNet, chips, notModelled, dtMax: stepCeiling(devices) };
}
