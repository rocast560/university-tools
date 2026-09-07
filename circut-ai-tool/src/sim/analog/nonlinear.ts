// Diodes and LEDs: Shockley junctions solved by Newton-Raphson on top of the
// linear MNA kernel.
//
// Each junction gets a real internal node so its bulk series resistance is a
// genuine element rather than something folded into the companion model. That
// costs one unknown per diode and buys convergence in the case that otherwise
// breaks a naive solver: an LED straight across a stiff supply with no
// current-limiting resistor. That is exactly the mistake this tool exists to
// catch, so it has to converge rather than blow up.

import { ledSpec, type LedSpec } from '../../parts/led.ts';
import { solveDC, type Device } from './dc.ts';

/** Thermal voltage kT/q at 27 C. */
export const VT = 0.025852;

/**
 * Ceiling on the Shockley exponent, purely so a wild iterate cannot reach
 * Infinity. pnjlim is what actually limits the junction voltage, so this must
 * sit well above anything physical: a 4 V junction is x = 81 for the red
 * family and x = 62 for InGaN. A clamp tuned to the red family (40) silently
 * caps blue below the voltage it needs and the LED reads as nearly open.
 */
const EXP_CLAMP = 200;

export interface DiodeSpec {
  kind: 'diode';
  /** Saturation current, amps. */
  is: number;
  /** Emission coefficient. */
  n: number;
  /** Bulk series resistance, ohms. */
  rs: number;
  /** Present when the junction is an LED, and then it carries the optics too. */
  led?: LedSpec;
}

export interface DiodeDevice extends DiodeSpec {
  ref: string;
  anode: string;
  cathode: string;
  led?: LedSpec;
}

export interface Fault {
  kind: string;
  level: 'error' | 'warning' | 'info';
  ref: string;
  message: string;
}

export interface OpResult {
  nodes: Record<string, number>;
  /** Supply refs and diode refs -> amps. */
  currents: Record<string, number>;
  /** LED ref -> 0..1. */
  brightness: Record<string, number>;
  faults: Fault[];
  converged: boolean;
  iterations: number;
}

/** Below this an LED reads as dark; at NOMINAL_MA it reads as fully lit. */
const ON_MA = 0.5;
const NOMINAL_MA = 15;

const SILICON: Record<string, Omit<DiodeSpec, 'kind'>> = {
  '1N4148': { is: 2.52e-9, n: 1.752, rs: 0.568 },
  '1N4001': { is: 1.4e-8, n: 1.98, rs: 0.033 },
  generic: { is: 1e-9, n: 1.8, rs: 0.5 },
};

/**
 * The saturation current that puts the junction at `vf` when `iRated` flows,
 * once the bulk resistance has taken its share of the drop.
 */
function saturationCurrent(vf: number, iRated: number, n: number, rs: number): number {
  const vJunction = Math.max(vf - iRated * rs, 0.05);
  return iRated / (Math.exp(vJunction / (n * VT)) - 1);
}

/** Blue, white and UV are InGaN and run at a markedly higher ideality. */
const isInGaN = (key: string) => key === 'blue' || key === 'white' || key === 'uv';

/** Build a junction model from a schematic value: an LED colour, or a part number. */
export function diodeFor(value: string): DiodeSpec {
  const s = String(value ?? '');
  if (/LED|\b(red|green|blue|white|yellow|amber|orange|uv|ir)\b/i.test(s)) {
    const led = ledSpec(s);
    const n = isInGaN(led.key) ? 2.5 : 1.9;
    const rs = isInGaN(led.key) ? 12 : 15;
    return { kind: 'diode', is: saturationCurrent(led.vf, led.ifRated, n, rs), n, rs, led };
  }
  const key = Object.keys(SILICON).find((k) => k !== 'generic' && s.toUpperCase().includes(k));
  return { kind: 'diode', ...SILICON[key ?? 'generic'] };
}

/**
 * SPICE's pnjlim. Newton on an exponential overshoots wildly from a cold
 * start; this damps each step to something the next exponential survives.
 */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}

const internalNode = (ref: string) => ref + '#rs';

const rsBranch = (d: DiodeDevice): Device => ({ kind: 'resistor', ref: d.ref + ':rs', a: internalNode(d.ref), b: d.cathode, ohms: Math.max(d.rs, 1e-3) });

/** Junction current at a given junction voltage, with the exponent clamped. */
function junctionCurrent(d: DiodeSpec, v: number): number {
  return d.is * (Math.exp(Math.min(v / (d.n * VT), EXP_CLAMP)) - 1);
}

/** Solve the DC operating point, iterating Newton over every junction. */
export function operatingPoint(devices: Device[], ground: string, maxIter = 100): OpResult | null {
  const diodes = devices.filter((d): d is DiodeDevice => (d as DiodeDevice).kind === 'diode');
  const linear = devices.filter((d) => (d as DiodeDevice).kind !== 'diode');
  const faults: Fault[] = [];

  const vd = new Map<string, number>();
  const vcrit = new Map<string, number>();
  for (const d of diodes) {
    vd.set(d.ref, 0);
    vcrit.set(d.ref, d.n * VT * Math.log((d.n * VT) / (Math.SQRT2 * d.is)));
  }

  let out = solveDC(linear.concat(diodes.map(rsBranch)), ground);
  if (!out) return null;
  let converged = diodes.length === 0;
  let iterations = 0;

  for (let iter = 0; iter < maxIter && !converged; iter++) {
    iterations = iter + 1;
    const stamped: Device[] = linear.slice();
    for (const d of diodes) {
      const v = vd.get(d.ref)!;
      const ex = Math.exp(Math.min(v / (d.n * VT), EXP_CLAMP));
      const id = d.is * (ex - 1);
      // A gmin floor keeps a hard-off junction from leaving its node afloat.
      const gd = (d.is / (d.n * VT)) * ex + 1e-12;
      const mid = internalNode(d.ref);
      stamped.push({ kind: 'conductance', ref: d.ref + ':g', a: d.anode, b: mid, siemens: gd });
      stamped.push({ kind: 'isource', ref: d.ref + ':i', from: d.anode, to: mid, amps: id - gd * v });
      stamped.push(rsBranch(d));
    }
    const next = solveDC(stamped, ground);
    if (!next) return null;
    let maxStep = 0;
    for (const d of diodes) {
      const raw = (next.nodes[d.anode] ?? 0) - (next.nodes[internalNode(d.ref)] ?? 0);
      const limited = pnjlim(raw, vd.get(d.ref)!, d.n * VT, vcrit.get(d.ref)!);
      maxStep = Math.max(maxStep, Math.abs(limited - vd.get(d.ref)!));
      vd.set(d.ref, limited);
    }
    out = next;
    // Never accept the very first iterate: it is built on the cold guess.
    if (iter > 0 && maxStep < 1e-9) converged = true;
  }

  if (!converged && diodes.length) {
    faults.push({ kind: 'analog-convergence', level: 'warning', ref: diodes[0].ref, message: 'the solver did not settle; the numbers shown are approximate' });
  }

  const currents: Record<string, number> = { ...out.currents };
  const brightness: Record<string, number> = {};
  for (const d of diodes) {
    const i = junctionCurrent(d, vd.get(d.ref)!);
    currents[d.ref] = i;
    if (!d.led) continue;
    const mA = i * 1000;
    brightness[d.ref] = mA < ON_MA ? 0 : Math.min(1, Math.sqrt(mA / NOMINAL_MA));
    if (i > d.led.ifRated) faults.push(overcurrent(d, i));
  }
  return { nodes: out.nodes, currents, brightness, faults, converged, iterations };
}

/** E12 values, so the advice names a resistor you can actually buy. */
const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82, 100];

/** Round up to the next E12 value at or above `want`. */
function e12(want: number): number {
  const decade = Math.pow(10, Math.floor(Math.log10(want)));
  const hit = E12.find((e) => e * decade >= want);
  return Math.round((hit ?? 10) * (hit ? decade : decade * 10));
}

function overcurrent(d: DiodeDevice, amps: number): Fault {
  const led = d.led!;
  // The suggestion assumes the branch is fed from a 5 V rail. That is right
  // for the boards this tool builds, and the live table carries the exact
  // numbers either way.
  const want = (5 - led.vf) / (led.ifRated * 0.75);
  return {
    kind: 'led-overcurrent',
    level: 'warning',
    ref: d.ref,
    message: `${d.ref} draws ${Math.round(amps * 1000)} mA (max ${Math.round(led.ifRated * 1000)} mA); add ~${e12(want)}R in series`,
  };
}
