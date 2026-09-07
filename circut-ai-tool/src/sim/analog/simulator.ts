// The stateful object a running board is driven through.
//
// Everything below this is pure: a model, a device list, a solve. This holds
// the parts that persist between frames - switch positions, capacitor
// voltages, inductor currents, logic levels and the clock - and turns them
// into a readout the UI and the MCP tools can display.

import { displayName } from '../../netlist.ts';
import type { Device } from './dc.ts';
import type { AnalogModel } from './model.ts';
import { solveMixed, type MixedResult } from './mixed.ts';
import type { Fault } from './nonlinear.ts';
import { commitReactive, companionDevices, createReactiveState, type ReactiveState, type SourceSpec } from './transient.ts';
import { operatingPoint } from './nonlinear.ts';

export interface AnalogState {
  /** Seconds since the run started. */
  time: number;
  /** Node id -> volts. */
  nodes: Record<string, number>;
  /** Display net name -> volts, for the readout table. */
  netVolts: Record<string, number>;
  /** Part reference -> amps through it. */
  currents: Record<string, number>;
  /** Part reference -> watts. */
  power: Record<string, number>;
  /** LED reference -> 0..1. */
  brightness: Record<string, number>;
  /** LED reference -> true once it is lit at all, for the flat renderer. */
  leds: Record<string, boolean>;
  /** Gate or decoder output -> level. */
  digitalState: Record<string, 0 | 1>;
  switches: Record<string, boolean>;
  faults: Fault[];
  converged: boolean;
  outerPasses: number;
}

export interface SimulatorOptions {
  /** Largest timestep to take, in seconds. */
  maxStep?: number;
  /** Most steps to run inside a single step() call. */
  maxStepsPerCall?: number;
}

/**
 * Ceiling on a single integration step. A frame that asks for more time than
 * this is broken into several, so a slow solver degrades into slow motion
 * rather than into a wrong answer.
 */
const DEFAULT_MAX_STEP = 1e-3;
const DEFAULT_MAX_STEPS = 200;

export class Simulator {
  readonly model: AnalogModel;
  private opts: Required<SimulatorOptions>;
  private switches: Record<string, boolean> = {};
  private sources: Record<string, SourceSpec> = {};
  private reactive: ReactiveState;
  private levels: Record<string, 0 | 1> = {};
  private last: AnalogState;
  /** True when nothing in the circuit varies with time. */
  private stepless = false;

  constructor(model: AnalogModel, opts: SimulatorOptions = {}) {
    this.model = model;
    // The circuit decides how finely it has to be stepped. A board with no
    // reactive elements and no clock has no dynamics, so its ceiling is
    // Infinity and one solve per frame is the exact answer.
    const ceiling = Math.min(model.dtMax ?? Infinity, opts.maxStep ?? Infinity);
    this.opts = { maxStep: Number.isFinite(ceiling) ? ceiling : DEFAULT_MAX_STEP, maxStepsPerCall: opts.maxStepsPerCall ?? DEFAULT_MAX_STEPS };
    this.stepless = !Number.isFinite(model.dtMax ?? Infinity) && opts.maxStep === undefined;
    for (const d of model.devices) if (d.kind === 'switch') this.switches[d.ref] = d.closed;
    this.reactive = createReactiveState(model.devices);
    this.last = this.solveDC();
  }

  /** Back to power-up: clock at zero, capacitors empty, levels forgotten. */
  reset(): AnalogState {
    this.reactive = createReactiveState(this.model.devices);
    this.levels = {};
    this.last = this.solveDC();
    return this.last;
  }

  setSwitch(ref: string, closed: boolean): void {
    this.switches[ref] = closed;
  }

  toggleSwitch(ref: string): void {
    this.switches[ref] = !this.switches[ref];
  }

  setSource(ref: string, spec: SourceSpec): void {
    this.sources[ref] = spec;
  }

  /** The operating point with capacitors open and inductors shorted. */
  solveDC(): AnalogState {
    const out = solveMixed(this.model, { devices: this.devices(), levels: this.levels });
    this.last = this.readout(out, this.reactive.t);
    if (out) this.levels = out.levels;
    return this.last;
  }

  /**
   * Advance by `dt` seconds of simulated time, in as many internal steps as
   * the step ceiling requires.
   */
  step(dt: number): AnalogState {
    const steps = this.stepless ? 1 : Math.max(1, Math.min(Math.ceil(dt / this.opts.maxStep), this.opts.maxStepsPerCall));
    const h = dt / steps;
    let out: MixedResult | null = null;
    for (let i = 0; i < steps; i++) {
      this.reactive.t += h;
      const base = companionDevices(this.devices(), this.reactive, h, this.reactive.t);
      out = solveMixed(this.model, { devices: base, levels: this.levels });
      if (!out) break;
      this.levels = out.levels;
      commitReactive(this.devices(), this.reactive, out.nodes, h);
    }
    this.last = this.readout(out, this.reactive.t);
    return this.last;
  }

  state(): AnalogState {
    return this.last;
  }

  /** The device list with the current switch positions and sources applied. */
  private devices(): Device[] {
    return this.model.devices.map((d) => {
      if (d.kind === 'switch') return { ...d, closed: !!this.switches[d.ref] };
      const spec = this.sources[d.ref];
      if (spec && d.kind === 'vsource') return { ...d, source: spec };
      return d;
    });
  }

  private readout(out: MixedResult | null, time: number): AnalogState {
    if (!out) {
      return {
        time, nodes: {}, netVolts: {}, currents: {}, power: {}, brightness: {}, leds: {}, digitalState: {},
        switches: { ...this.switches },
        faults: [{ kind: 'analog-unsolvable', level: 'error', ref: '', message: 'the circuit as wired cannot be solved; check for a short across the supply' }],
        converged: false,
        outerPasses: 0,
      };
    }
    const netVolts: Record<string, number> = {};
    for (const [node, net] of Object.entries(this.model.netOf)) {
      const v = out.nodes[node];
      if (v !== undefined) netVolts[displayName(net)] = v;
    }
    const power: Record<string, number> = {};
    const leds: Record<string, boolean> = {};
    for (const d of this.model.devices) {
      const i = out.currents[d.ref];
      if (i === undefined) continue;
      if (d.kind === 'resistor') power[d.ref] = i * i * d.ohms;
    }
    for (const [ref, b] of Object.entries(out.brightness)) leds[ref] = b > 0;
    // Resistor currents are not solved directly; derive them from the drop.
    for (const d of this.model.devices) {
      if (d.kind !== 'resistor') continue;
      const v = (out.nodes[d.a] ?? 0) - (out.nodes[d.b] ?? 0);
      out.currents[d.ref] = v / d.ohms;
      power[d.ref] = (v * v) / d.ohms;
    }
    return {
      time,
      nodes: out.nodes,
      netVolts,
      currents: out.currents,
      power,
      brightness: out.brightness,
      leds,
      digitalState: out.digitalState,
      switches: { ...this.switches },
      faults: out.faults,
      converged: out.converged,
      outerPasses: out.outerPasses,
    };
  }
}

/** Solve one operating point without keeping a simulator around. */
export function operatingPointOf(model: AnalogModel): AnalogState {
  return new Simulator(model).state();
}

export { operatingPoint };
