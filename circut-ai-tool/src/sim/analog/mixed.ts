// The bridge between logic and electricity.
//
// Logic levels and node voltages depend on each other: a gate's output level
// decides what voltage it drives, and the voltage on its inputs decides what
// level it reads. Neither can be solved first, so this runs them alternately
// until they stop changing.
//
// Everything a chip does is expressed as ordinary analog devices - an output
// is a Thevenin source, an input is a resistance to Vcc - so the nonlinear
// solver underneath needs to know nothing about logic at all.

import { SEGMENT_DIGITS, evalGate } from '../index.ts';
import { driveOf, inputLoad, initialLevel, readLevel } from './digital.ts';
import type { Device } from './dc.ts';
import type { AnalogChip, AnalogModel } from './model.ts';
import { operatingPoint, type Fault, type OpResult } from './nonlinear.ts';

export interface MixedResult extends OpResult {
  /** Node id -> the logic level a chip reads or drives there. */
  levels: Record<string, 0 | 1>;
  /** "U1.3" -> level, for every pin the logic touches. */
  digitalState: Record<string, 0 | 1>;
  outerPasses: number;
}

/**
 * How many logic/analog rounds to try before giving up. A circuit with
 * feedback that has no stable DC state - a ring oscillator, say - never
 * settles, and that is a real answer about the circuit rather than a bug.
 */
const MAX_OUTER = 20;

/** Fraction of a chip's worst-case Icc to draw from the rail. */
const ICC_SHARE = 0.5;

export interface MixedOptions {
  /**
   * Devices to solve instead of the model's own, for a caller that has
   * already substituted companion models or flipped a switch. The chip list,
   * ground and node names still come from the model.
   */
  devices?: Device[];
  /** Levels carried over from the previous solve, so hysteresis works. */
  levels?: Record<string, 0 | 1>;
  maxOuter?: number;
}

export function solveMixed(model: AnalogModel, opts: MixedOptions = {}): MixedResult | null {
  const maxOuter = opts.maxOuter ?? MAX_OUTER;
  const levels: Record<string, 0 | 1> = { ...(opts.levels ?? {}) };
  const digitalState: Record<string, 0 | 1> = {};
  const faults: Fault[] = [];

  // Input loads and supply draw are linear and never change, so they are
  // stamped once rather than rebuilt every pass.
  const base: Device[] = (opts.devices ?? model.devices).slice();
  for (const chip of model.chips) {
    const { ohmsToVcc } = inputLoad(chip.family);
    chip.inputNodes.forEach((node, i) => {
      if (node === chip.vccNode) return;
      base.push({ kind: 'resistor', ref: `${chip.ref}:in${i}`, a: node, b: chip.vccNode, ohms: ohmsToVcc });
    });
    base.push({ kind: 'isource', ref: `${chip.ref}:icc`, from: chip.vccNode, to: chip.gndNode, amps: chip.iccMax * ICC_SHARE });
  }

  let out = operatingPoint(base, model.ground);
  if (!out) return null;

  // Seed any input we have no history for from where the undriven board
  // settled. Levels handed in by the caller are kept, so a running simulation
  // carries its hysteresis across timesteps.
  for (const chip of model.chips) {
    const vcc = supplyOf(chip, out.nodes);
    for (const node of chip.inputNodes) if (levels[node] === undefined) levels[node] = initialLevel(out.nodes[node] ?? 0, vcc, chip.family);
  }

  let outerPasses = 0;
  let settled = model.chips.length === 0;
  let previous = '';

  for (let pass = 0; pass < maxOuter && !settled; pass++) {
    outerPasses = pass + 1;
    const stamped = base.slice();
    for (const chip of model.chips) {
      const vcc = supplyOf(chip, out!.nodes);
      const level = (node: string): 0 | 1 => {
        const v = out!.nodes[node];
        // A pin on a node the solve never saw is genuinely open; TTL reads
        // that high, which is what the boolean simulator does too.
        if (v === undefined) return 1;
        return readLevel(v, vcc, chip.family, levels[node] ?? 1);
      };
      for (const node of chip.inputNodes) levels[node] = level(node);
      for (const out2 of driveNodes(chip, level)) {
        const d = driveOf(out2.level, chip.family, vcc);
        levels[out2.node] = out2.level;
        stamped.push({ kind: 'conductance', ref: `${out2.ref}:g`, a: out2.node, b: chip.gndNode, siemens: 1 / d.rout });
        stamped.push({ kind: 'isource', ref: `${out2.ref}:d`, from: chip.gndNode, to: out2.node, amps: d.volts / d.rout });
        digitalState[out2.ref] = out2.level;
      }
    }
    const next = operatingPoint(stamped, model.ground);
    if (!next) return null;
    out = next;
    // The discrete state is the whole fixed point: if no level moved, the
    // analog solution underneath it is the answer.
    const key = JSON.stringify(levels);
    if (key === previous) settled = true;
    previous = key;
  }

  if (!settled && model.chips.length) {
    faults.push({
      kind: 'analog-oscillation',
      level: 'warning',
      ref: model.chips[0].ref,
      message: 'the logic has no steady state: something in it oscillates. Run it in time rather than solving for a single operating point.',
    });
  }

  return { ...out, levels, digitalState, outerPasses, faults: [...out.faults, ...faults], converged: out.converged && settled };
}

/** A chip's supply voltage, as actually solved on its Vcc pin. */
function supplyOf(chip: AnalogChip, nodes: Record<string, number>): number {
  const v = (nodes[chip.vccNode] ?? 5) - (nodes[chip.gndNode] ?? 0);
  return v > 0.5 ? v : 5;
}

/** Every output the chip drives this pass, with the level it drives there. */
function driveNodes(chip: AnalogChip, level: (node: string) => 0 | 1): { ref: string; node: string; level: 0 | 1 }[] {
  const out: { ref: string; node: string; level: 0 | 1 }[] = [];
  for (const g of chip.gates) out.push({ ref: g.name, node: g.output, level: evalGate(g.kind, g.inputs.map(level)) });
  const dec = chip.decoder;
  if (dec) {
    const digit = level(dec.inputs.A) + 2 * level(dec.inputs.B) + 4 * level(dec.inputs.C) + 8 * level(dec.inputs.D);
    const lit = level(dec.lampTest) === 0 ? 'abcdefg' : level(dec.blanking) === 0 ? '' : (SEGMENT_DIGITS[digit] ?? '');
    for (const [seg, node] of Object.entries(dec.outputs)) {
      const on = lit.includes(seg);
      // A 7447 drives a common-anode display, so its outputs are active low.
      out.push({ ref: `${chip.ref}.${seg}`, node, level: dec.kind === '7447' ? (on ? 0 : 1) : on ? 1 : 0 });
    }
  }
  return out;
}
