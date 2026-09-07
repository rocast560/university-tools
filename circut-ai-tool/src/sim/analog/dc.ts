// Modified nodal analysis over the physical breadboard graph.
//
// Nodes are strip / rail ids (see holeNode in src/checks/index.ts); the ground
// node is pinned at 0 V and left out of the matrix. Voltage sources add one
// extra row and column each, whose solution value is the branch current.

import { solve, zeros } from './matrix.ts';

export type Device =
  | { kind: 'resistor'; ref: string; a: string; b: string; ohms: number }
  | { kind: 'conductance'; ref: string; a: string; b: string; siemens: number }
  | { kind: 'vsource'; ref: string; pos: string; neg: string; volts: number }
  | { kind: 'isource'; ref: string; from: string; to: string; amps: number }
  | { kind: 'switch'; ref: string; a: string; b: string; closed: boolean }
  // Nonlinear. The linear kernel registers its nodes but stamps nothing;
  // operatingPoint() in nonlinear.ts replaces each one with a companion model
  // before it ever reaches solveDC.
  | { kind: 'diode'; ref: string; anode: string; cathode: string; is: number; n: number; rs: number; led?: unknown };

export interface DcResult {
  /** node id -> volts, including the ground node at 0. */
  nodes: Record<string, number>;
  /** voltage source ref -> amps flowing out of its positive terminal. */
  currents: Record<string, number>;
}

/**
 * Nodes with no conductive path to ground. Their block of the matrix is
 * singular on its own, so each one gets a GMIN leak to ground: enough to make
 * the system solvable, small enough to leave every real node voltage alone.
 * Every device that stamps a conductance counts as a path, including an open
 * switch, whose SWITCH_OFF_OHMS is still a (terrible) connection.
 */
function floating(devices: Device[], nodes: string[], ground: string): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  for (const d of devices) {
    if (d.kind === 'resistor' || d.kind === 'switch' || d.kind === 'conductance') link(d.a, d.b);
    // A raw diode is deliberately NOT a link: this kernel stamps nothing for
    // one, so a node held up only by a diode really is floating here and needs
    // its GMIN leak. Once operatingPoint() swaps in the companion model, the
    // conductance it adds is a link and the leak stops being applied.
    else if (d.kind === 'vsource') link(d.pos, d.neg);
    // A current source is an open circuit at DC and links nothing.
  }
  const reached = new Set<string>([ground]);
  const queue = [ground];
  while (queue.length) {
    for (const next of adj.get(queue.pop()!) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return new Set(nodes.filter((x) => !reached.has(x)));
}

export function solveDC(devices: Device[], ground: string): DcResult | null {
  // Index every node except ground, which is the reference at 0 V.
  const index = new Map<string, number>();
  const seen: string[] = [];
  const note = (node: string) => {
    if (seen.includes(node)) return;
    seen.push(node);
    if (node !== ground) index.set(node, index.size);
  };
  for (const d of devices) {
    if (d.kind === 'vsource') { note(d.pos); note(d.neg); }
    else if (d.kind === 'isource') { note(d.from); note(d.to); }
    else if (d.kind === 'diode') { note(d.anode); note(d.cathode); }
    else { note(d.a); note(d.b); }
  }
  const sources = devices.filter((d): d is Extract<Device, { kind: 'vsource' }> => d.kind === 'vsource');
  const n = index.size;
  const m = sources.length;
  const size = n + m;
  if (size === 0) return { nodes: { [ground]: 0 }, currents: {} };

  const A = zeros(size);
  const b = new Array<number>(size).fill(0);
  const at = (node: string): number => index.get(node) ?? -1;

  const conductance = (a: string, b2: string, g: number) => {
    const i = at(a);
    const j = at(b2);
    if (i >= 0) A[i][i] += g;
    if (j >= 0) A[j][j] += g;
    if (i >= 0 && j >= 0) {
      A[i][j] -= g;
      A[j][i] -= g;
    }
  };

  for (const d of devices) {
    if (d.kind === 'resistor') conductance(d.a, d.b, 1 / d.ohms);
    else if (d.kind === 'conductance') conductance(d.a, d.b, d.siemens);
    else if (d.kind === 'switch') conductance(d.a, d.b, d.closed ? 1 / SWITCH_ON_OHMS : 1 / SWITCH_OFF_OHMS);
    else if (d.kind === 'isource') {
      const i = at(d.from);
      const j = at(d.to);
      if (i >= 0) b[i] -= d.amps;
      if (j >= 0) b[j] += d.amps;
    }
  }
  for (const node of floating(devices, seen, ground)) {
    const i = at(node);
    if (i >= 0) A[i][i] += GMIN;
  }
  sources.forEach((s, k) => {
    const row = n + k;
    const p = at(s.pos);
    const q = at(s.neg);
    if (p >= 0) { A[row][p] = 1; A[p][row] = 1; }
    if (q >= 0) { A[row][q] = -1; A[q][row] = -1; }
    b[row] = s.volts;
  });

  const x = solve(A, b);
  if (!x) return null;
  const nodes: Record<string, number> = { [ground]: 0 };
  for (const [node, i] of index) nodes[node] = x[i];
  const currents: Record<string, number> = {};
  sources.forEach((s, k) => (currents[s.ref] = -x[n + k]));
  return { nodes, currents };
}

export const GMIN = 1e-12;
export const SWITCH_ON_OHMS = 0.01;
export const SWITCH_OFF_OHMS = 1e12;
