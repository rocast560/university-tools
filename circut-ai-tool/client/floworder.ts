// The order the net legend lists nets in: the order a build flows.

import type { LayoutDoc } from '../src/pipeline.ts';

/**
 * Nets in the order a build flows: supply, then the switch inputs, then each
 * gate's output once everything feeding it is listed, then whatever a
 * resistor carries onward from those (the segment lines into the display),
 * and finally anything the simulator does not model, alphabetically.
 */
export function flowOrder(doc: LayoutDoc): string[] {
  const m = doc.sim.model;
  const out: string[] = [];
  const listed = new Set<string>();
  const known = new Set<string>(Object.keys(m.power));
  const add = (net: string) => {
    known.add(net);
    if (doc.nets[net] && !listed.has(net)) {
      listed.add(net);
      out.push(net);
    }
  };
  for (const [net, info] of Object.entries(doc.nets)) if (info.power) add(net);
  for (const i of m.inputs) add(i.net);
  const pending = [...m.gates];
  let progress = true;
  while (progress) {
    progress = false;
    for (const g of [...pending]) {
      // A net the layout does not know (an internal node of the L3 model) never blocks its gate.
      if (!g.inputs.every((i) => known.has(i) || !doc.nets[i])) continue;
      add(g.output);
      pending.splice(pending.indexOf(g), 1);
      progress = true;
    }
    for (const [a, b] of m.resistors) {
      if (known.has(a) && !known.has(b)) add(b);
      else if (known.has(b) && !known.has(a)) add(a);
      else continue;
      progress = true;
    }
  }
  for (const net of Object.keys(doc.nets).sort((a, b) => doc.nets[a].name.localeCompare(doc.nets[b].name))) add(net);
  return out;
}

