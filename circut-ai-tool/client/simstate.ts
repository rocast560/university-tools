// Switch positions on the board -> input levels -> LED and segment states.

import type { SimState } from '../src/render/index.ts';
import { simulate, type SimModel } from '../src/sim/index.ts';

export function levelsFromSwitches(model: SimModel, switches: Record<string, boolean>): Record<string, 0 | 1> {
  const levels: Record<string, 0 | 1> = {};
  for (const inp of model.inputs) {
    const closed = !!switches[inp.key];
    levels[inp.net] = closed ? (inp.activeLow ? 0 : 1) : inp.activeLow ? 1 : 0;
  }
  return levels;
}

export function simState(model: SimModel, switches: Record<string, boolean>): SimState {
  const r = simulate(model, levelsFromSwitches(model, switches));
  return { leds: r.leds, segments: r.segments, switches: { ...switches } };
}
