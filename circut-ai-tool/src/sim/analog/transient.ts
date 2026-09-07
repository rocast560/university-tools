// Stepping the circuit through time.
//
// Capacitors and inductors are replaced each step by a companion model -
// a conductance plus a current source that carries the element's state - so
// the same DC machinery solves each instant and nothing below here needs to
// know that time is passing.
//
// The integrator is backward Euler, deliberately. Trapezoidal is more
// accurate on smooth waveforms and rings badly on the square-edged ones this
// tool produces all day: logic outputs, clocks, 555s, relay contacts. Backward
// Euler's numerical damping is the right trade here, not a shortcoming, so
// please do not "improve" it to trapezoidal.

import { solveDC, type Device } from './dc.ts';
import type { OpResult } from './nonlinear.ts';
import { operatingPoint } from './nonlinear.ts';

export type SourceSpec =
  | { wave: 'dc'; volts: number }
  | { wave: 'clock'; hz: number; duty: number; low: number; high: number }
  | { wave: 'pulse'; v1: number; v2: number; delay: number; width: number; period: number }
  | { wave: 'sine'; offset: number; amp: number; hz: number; phase: number };

/** The value a source has at time `t`, in volts. */
export function sourceValue(s: SourceSpec, t: number): number {
  switch (s.wave) {
    case 'dc':
      return s.volts;
    case 'clock': {
      const period = 1 / s.hz;
      const phase = ((t % period) + period) % period;
      return phase < period * s.duty ? s.high : s.low;
    }
    case 'pulse': {
      if (t < s.delay) return s.v1;
      const phase = ((t - s.delay) % s.period + s.period) % s.period;
      return phase < s.width ? s.v2 : s.v1;
    }
    case 'sine':
      return s.offset + s.amp * Math.sin(2 * Math.PI * s.hz * t + s.phase);
  }
}

/** Everything that carries over from one timestep to the next. */
export interface ReactiveState {
  t: number;
  /** Capacitor ref -> the voltage across it at the end of the last step. */
  capV: Record<string, number>;
  /** Inductor ref -> the current through it at the end of the last step. */
  indI: Record<string, number>;
}

export function createReactiveState(devices: Device[]): ReactiveState {
  const state: ReactiveState = { t: 0, capV: {}, indI: {} };
  for (const d of devices) {
    if (d.kind === 'capacitor') state.capV[d.ref] = 0;
    else if (d.kind === 'inductor') state.indI[d.ref] = 0;
  }
  return state;
}

/**
 * Replace every reactive element and time-varying source with its value at
 * time `t`, given a step of `h`.
 *
 * Backward Euler for a capacitor is I = (C/h)(V - Vprev), which is a
 * conductance C/h in parallel with a current source carrying (C/h)*Vprev.
 * For an inductor it is I = Iprev + (h/L)V, a conductance h/L in parallel
 * with a source carrying Iprev - so neither element needs a branch row.
 */
export function companionDevices(devices: Device[], state: ReactiveState, h: number, t: number): Device[] {
  const out: Device[] = [];
  for (const d of devices) {
    if (d.kind === 'capacitor') {
      const g = d.farads / h;
      out.push({ kind: 'conductance', ref: d.ref + ':g', a: d.a, b: d.b, siemens: g });
      out.push({ kind: 'isource', ref: d.ref + ':i', from: d.b, to: d.a, amps: g * (state.capV[d.ref] ?? 0) });
    } else if (d.kind === 'inductor') {
      out.push({ kind: 'conductance', ref: d.ref + ':g', a: d.a, b: d.b, siemens: h / Math.max(d.henries, 1e-12) });
      out.push({ kind: 'isource', ref: d.ref + ':i', from: d.a, to: d.b, amps: state.indI[d.ref] ?? 0 });
    } else if (d.kind === 'vsource' && d.source) {
      out.push({ ...d, volts: sourceValue(d.source, t) });
    } else out.push(d);
  }
  return out;
}

/** Read the new element states out of a solved step. */
export function commitReactive(devices: Device[], state: ReactiveState, nodes: Record<string, number>, h: number): void {
  for (const d of devices) {
    if (d.kind === 'capacitor') state.capV[d.ref] = (nodes[d.a] ?? 0) - (nodes[d.b] ?? 0);
    else if (d.kind === 'inductor') {
      const v = (nodes[d.a] ?? 0) - (nodes[d.b] ?? 0);
      state.indI[d.ref] = (state.indI[d.ref] ?? 0) + (h / Math.max(d.henries, 1e-12)) * v;
    }
  }
}

/**
 * Advance one timestep. Returns the solved instant, or null if the circuit
 * could not be solved at all.
 */
export function stepTransient(devices: Device[], ground: string, state: ReactiveState, h: number): OpResult | null {
  state.t += h;
  const out = operatingPoint(companionDevices(devices, state, h, state.t), ground);
  if (!out) return null;
  commitReactive(devices, state, out.nodes, h);
  return out;
}

/** A purely linear step, for circuits with no junctions. Used by the tests. */
export function stepLinear(devices: Device[], ground: string, state: ReactiveState, h: number) {
  state.t += h;
  const out = solveDC(companionDevices(devices, state, h, state.t), ground);
  if (!out) return null;
  commitReactive(devices, state, out.nodes, h);
  return out;
}
