// Verify a layout: hole use, physical connectivity versus the netlist, supply
// reach, LED polarity, driver conflicts, floating inputs, fan-out and LED
// current. Checks read the hole map, not the schematic, so they prove the
// wiring the user will build.

import { holeKey, holeName, isRail, stripOf } from '../layout/board.ts';
import type { EngineResult } from '../layout/engine.ts';
import type { BoardSpec, Hole } from '../layout/types.ts';
import type { Design } from '../netlist.ts';
import { displayName, isUnconnected } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { DC, icInfo } from '../parts/gates.ts';
import { parseOhms } from '../parts/values.ts';

export interface Check {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  refs: string[];
}

export const LED_VF = 2.0;

export class UnionFind {
  private p = new Map<string, string>();

  find(x: string): string {
    let r = this.p.get(x);
    if (r === undefined) {
      this.p.set(x, x);
      return x;
    }
    while (r !== this.p.get(r)) r = this.p.get(r)!;
    let cur = x;
    while (cur !== r) {
      const next = this.p.get(cur)!;
      this.p.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

export function holeNode(h: Hole, board: BoardSpec): string {
  if (!isRail(h.row)) return stripOf(h);
  if (!board.splitCol) return h.row;
  return h.col > board.splitCol ? `${h.row}R` : `${h.row}L`;
}

export function connectivity(res: EngineResult): UnionFind {
  const uf = new UnionFind();
  for (const w of res.wires) uf.union(holeNode(w.a, res.board), holeNode(w.b, res.board));
  for (const lead of res.supply?.leads ?? []) uf.union(`PSU:${lead.net}`, holeNode(lead.hole, res.board));
  return uf;
}

export function hasErrors(checks: Check[]): boolean {
  return checks.some((c) => c.level === 'error');
}

export function supplyVolts(name: string): number {
  const m = /^\+?(\d+(?:\.\d+)?)\s*V/i.exec(displayName(name));
  if (m) return Number(m[1]);
  if (/3V3/i.test(name)) return 3.3;
  return 5;
}

export function runChecks(design: Design, res: EngineResult): Check[] {
  const out: Check[] = [];
  const add = (id: string, level: Check['level'], message: string, refs: string[] = []) => out.push({ id, level, message, refs });
  const placed = (ref: string) => !!res.pinHoles[ref];
  const holeOf = (ref: string, pin: string): Hole | undefined => res.pinHoles[ref]?.[pin];

  if (res.error) add('layout', 'error', res.error);
  for (const u of res.unplaced) add('unplaced', 'warning', `${u.ref} not placed: ${u.reason}`, [u.ref]);
  for (const w of res.warnings) add('layout', 'warning', w);

  // hole conflicts
  const owners = new Map<string, string[]>();
  const own = (h: Hole, who: string) => owners.set(holeKey(h), [...(owners.get(holeKey(h)) ?? []), who]);
  for (const [ref, pins] of Object.entries(res.pinHoles)) for (const [pin, h] of Object.entries(pins)) own(h, `${ref} pin ${pin}`);
  res.wires.forEach((w, i) => {
    own(w.a, `wire ${i + 1} (${displayName(w.net)})`);
    own(w.b, `wire ${i + 1} (${displayName(w.net)})`);
  });
  for (const l of res.supply?.leads ?? []) own(l.hole, l.label);
  for (const [k, who] of owners) if (who.length > 1) add('hole-conflict', 'error', `hole ${k} is used by ${who.join(' and ')}`);

  // connectivity
  const uf = connectivity(res);
  const rootOfNet = new Map<string, string>();
  let joined = 0;
  for (const [net, members] of design.nets) {
    if (isUnconnected(net)) continue;
    const nodes = members.filter((m) => placed(m.ref) && holeOf(m.ref, m.pin)).map((m) => ({ m, node: holeNode(holeOf(m.ref, m.pin)!, res.board) }));
    const kind = powerKind(net);
    if (kind && res.supply?.leads.some((l) => l.net === net)) nodes.push({ m: { ref: 'supply', pin: net }, node: `PSU:${net}` });
    if (!nodes.length) continue;
    const roots = new Set(nodes.map((n) => uf.find(n.node)));
    if (roots.size > 1) {
      const groups = [...roots].map((r) => nodes.filter((n) => uf.find(n.node) === r).map((n) => (n.m.ref === 'supply' ? 'the supply' : `${n.m.ref} pin ${n.m.pin}`)).join(', '));
      add('connectivity', 'error', `net ${displayName(net)} is not fully connected: [${groups.join('] and [')}] are separate`, nodes.map((n) => n.m.ref).filter((r) => r !== 'supply'));
    } else {
      joined++;
      rootOfNet.set(net, [...roots][0]);
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const [net, root] of rootOfNet) byRoot.set(root, [...(byRoot.get(root) ?? []), net]);
  for (const nets of byRoot.values()) {
    const distinct = nets.filter((n, i) => !(powerKind(n) === 'gnd' && nets.slice(0, i).some((m) => powerKind(m) === 'gnd')));
    if (distinct.length > 1) add('short', 'error', `nets ${distinct.map(displayName).join(' and ')} are joined on the board`);
  }
  if (!out.some((c) => c.id === 'connectivity')) add('connectivity', 'info', `${joined} nets match the schematic`);

  // pins by net
  const pinsOnNet = (net: string) => (design.nets.get(net) ?? []).map((m) => ({ ...m, pin: design.components.get(m.ref)!.pins.get(m.pin)! }));
  const outputsOn = (net: string) => pinsOnNet(net).filter((p) => p.pin.type === 'output' || p.pin.type === 'open_collector' || p.pin.type === 'tri_state');
  const inputsOn = (net: string) => pinsOnNet(net).filter((p) => p.pin.type === 'input');

  // driver conflicts
  for (const net of design.nets.keys()) {
    const outs = outputsOn(net).filter((p) => p.pin.type === 'output');
    if (outs.length > 1) add('driver-conflict', 'error', `net ${displayName(net)} is driven by ${outs.map((p) => `${p.ref} pin ${p.pin.num}`).join(' and ')}`, outs.map((p) => p.ref));
  }

  // floating inputs on used gates, fan-out, supply current
  let icc = 0;
  for (const pkg of res.packages) {
    if (pkg.kind !== 'dip') continue;
    const comp = design.components.get(pkg.id);
    if (!comp) continue;
    const info = icInfo(res.values[pkg.id] ?? comp.value, pkg.pins);
    if (!info) continue;
    icc += info.spec?.iccMax ?? 0;
    const dc = DC[info.family];
    for (const gate of info.spec?.gates ?? []) {
      const outPin = comp.pins.get(String(gate.output));
      if (!outPin || isUnconnected(outPin.net)) continue;
      const floating = gate.inputs.filter((i) => isUnconnected(comp.pins.get(String(i))?.net ?? 'unconnected-'));
      if (floating.length) add('floating-input', 'warning', `${pkg.id} gate with output pin ${gate.output} is used but input pin${floating.length > 1 ? 's' : ''} ${floating.join(', ')} float${floating.length > 1 ? '' : 's'}; tie unused inputs high or low`, [pkg.id]);
      const loads = inputsOn(outPin.net).filter((p) => p.ref !== pkg.id || p.pin.num !== outPin.num).length;
      if (loads > dc.fanout) add('fanout', 'warning', `${pkg.id} pin ${gate.output} drives ${loads} inputs; 74${info.family} fan-out is ${dc.fanout}`, [pkg.id]);
    }
  }
  if (icc > 0) add('supply-current', 'info', `chips draw up to about ${Math.round(icc * 1000)} mA from ${displayName(res.power.plusName)}`);

  // LEDs: polarity and current
  const volts = supplyVolts(res.power.plusName);
  for (const part of res.parts) {
    if (part.style !== 'LED') continue;
    const [kNet, aNet] = part.nets;
    const kKind = powerKind(kNet);
    const aKind = powerKind(aNet);
    const sinks = outputsOn(kNet);
    const sources = outputsOn(aNet);
    if (kKind === '+' || aKind === 'gnd') add('led-polarity', 'error', `${part.id} is reversed: the cathode (flat side) is on ${displayName(kNet)} and the anode on ${displayName(aNet)}`, [part.id]);
    else if (sinks.length) add('led-polarity', 'info', `${part.id} lights when ${sinks[0].ref} pin ${sinks[0].pin.num} is low`, [part.id]);
    else if (sources.length) add('led-polarity', 'info', `${part.id} lights when ${sources[0].ref} pin ${sources[0].pin.num} is high`, [part.id]);
    else add('led-polarity', 'info', `${part.id}: cathode on ${displayName(kNet)}, anode on ${displayName(aNet)}`, [part.id]);
    const series = res.parts.find((r) => {
      if (r.style !== 'R' || r.id === part.id) return false;
      const sharesK = r.nets.includes(kNet) && !powerKind(kNet);
      const sharesA = r.nets.includes(aNet) && !powerKind(aNet);
      return sharesK !== sharesA;
    });
    if (!series) {
      add('led-current', 'warning', `${part.id} has no series resistor on either side`, [part.id]);
      continue;
    }
    const ohms = parseOhms(series.value);
    if (ohms === null || ohms <= 0) {
      add('led-current', 'warning', `${part.id}: cannot read the value "${series.value}" of series resistor ${series.id}`, [part.id, series.id]);
      continue;
    }
    const mA = ((volts - LED_VF) / ohms) * 1000;
    add('led-current', mA > 25 ? 'warning' : 'info', `${part.id} through ${series.id} (${series.value}): about ${Math.round(mA)} mA${mA > 25 ? ', above the usual 20 mA limit' : ''}`, [part.id, series.id]);
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}
