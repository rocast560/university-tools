// The running simulation, and the loop that drives it.
//
// The Simulator lives here at module scope and never goes into the store.
// Every change that goes through store.set() re-renders the panels, and a
// frame at 60 Hz must not do that - nor should a live solver object end up
// inside a state snapshot. Frames are published on a tiny bus of their own
// instead, and only discrete facts (running or not) live in the store.

import { buildAnalogModel } from '../src/sim/analog/model.ts';
import { Simulator, type AnalogState } from '../src/sim/analog/simulator.ts';
import type { SourceSpec } from '../src/sim/analog/transient.ts';
import type { ProjectState } from './state.ts';

type Listener = (s: AnalogState) => void;

let sim: Simulator | null = null;
/** The doc the current simulator was built from, by identity. */
let builtFrom: unknown = null;
let raf = 0;
let lastFrame = 0;
let running = false;
let latest: AnalogState | null = null;
const listeners = new Set<Listener>();

/** Longest frame we will believe. A backgrounded tab produces huge deltas. */
const MAX_FRAME_S = 0.05;

function publish(s: AnalogState) {
  latest = s;
  for (const fn of listeners) fn(s);
}

/**
 * The simulator for this project, rebuilt only when the layout actually
 * changes. buildLayoutDoc is pure and returns a fresh object every time, so
 * identity is a free and exact key.
 */
function ensure(p: ProjectState): Simulator {
  if (sim && builtFrom === p.doc) return sim;
  sim = new Simulator(buildAnalogModel(p.design, p.doc));
  builtFrom = p.doc;
  return sim;
}

/** Push the board's switch positions into the solver and re-solve. */
function sync(p: ProjectState): AnalogState {
  const s = ensure(p);
  for (const [ref, closed] of Object.entries(p.switches)) s.setSwitch(ref, closed);
  return s.solveDC();
}

function frame(now: number) {
  if (!running || !sim) return;
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, MAX_FRAME_S) : 1 / 60;
  lastFrame = now;
  publish(sim.step(dt));
  raf = requestAnimationFrame(frame);
}

export const analog = {
  /** Solve once for the current board and publish it. */
  refresh(p: ProjectState): AnalogState {
    const s = sync(p);
    publish(s);
    return s;
  },

  start(p: ProjectState) {
    sync(p);
    if (running) return;
    running = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  },

  stop() {
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  },

  /** One frame's worth of time, while stopped. */
  stepOnce(p: ProjectState) {
    const s = ensure(p);
    for (const [ref, closed] of Object.entries(p.switches)) s.setSwitch(ref, closed);
    publish(s.step(1 / 60));
  },

  reset(p: ProjectState) {
    publish(ensure(p).reset());
  },

  setSource(ref: string, spec: SourceSpec, p: ProjectState) {
    ensure(p).setSource(ref, spec);
  },

  isRunning: () => running,
  latest: () => latest,

  /** Throw away the solver and everything it knew: a different project. */
  invalidate() {
    analog.stop();
    sim = null;
    builtFrom = null;
    latest = null;
  },

  /**
   * Rebuild the solver for a changed board - a new part value, a new LED
   * colour - without interrupting a run. Dropping the loop here would freeze
   * the board on the numbers it had before the change, which reads as the
   * change having had no effect.
   */
  rebuild(p: ProjectState) {
    const wasRunning = running;
    sim = null;
    builtFrom = null;
    const s = sync(p);
    publish(s);
    if (wasRunning) {
      lastFrame = 0;
      if (!raf) raf = requestAnimationFrame(frame);
    }
  },

  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
