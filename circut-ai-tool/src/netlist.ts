// kicad-cli "kicadsexpr" netlist -> Design. The netlist is the source of
// truth for connectivity: KiCad has already merged multi-unit symbols,
// resolved labels and power symbols, and named every net.

import { atom, child, children, isList, parse, type List } from './sexpr.ts';

export interface DesignPin {
  num: string;
  name: string;
  type: string;
  net: string;
}

export interface Component {
  ref: string;
  value: string;
  lib: string;
  part: string;
  pins: Map<string, DesignPin>;
}

export interface Design {
  components: Map<string, Component>;
  nets: Map<string, { ref: string; pin: string }[]>;
}

export class NetlistError extends Error {}

const val = (l: List | undefined, key: string, fallback = ''): string => {
  const c = l ? child(l, key) : undefined;
  return c ? (atom(c, 1) ?? fallback) : fallback;
};

export function parseNetlist(text: string): Design {
  const root = parse(text).items[0];
  if (!isList(root) || atom(root, 0) !== 'export') throw new NetlistError('not a KiCad netlist (expected (export ...))');
  const components = new Map<string, Component>();
  for (const c of children(child(root, 'components') ?? root, 'comp')) {
    const ref = val(c, 'ref');
    const ls = child(c, 'libsource');
    components.set(ref, { ref, value: val(c, 'value'), lib: val(ls, 'lib'), part: val(ls, 'part'), pins: new Map() });
  }
  const nets = new Map<string, { ref: string; pin: string }[]>();
  for (const n of children(child(root, 'nets') ?? root, 'net')) {
    const name = val(n, 'name');
    const members: { ref: string; pin: string }[] = [];
    for (const node of children(n, 'node')) {
      const ref = val(node, 'ref');
      const pin = val(node, 'pin');
      members.push({ ref, pin });
      const comp = components.get(ref);
      if (comp) comp.pins.set(pin, { num: pin, name: val(node, 'pinfunction', '~'), type: val(node, 'pintype', 'unspecified'), net: name });
    }
    nets.set(name, members);
  }
  // Pins of unused units never appear in the nets section: take them from libparts.
  const libpins = new Map<string, { num: string; name: string; type: string }[]>();
  for (const lp of children(child(root, 'libparts') ?? root, 'libpart')) {
    const pins = children(child(lp, 'pins') ?? lp, 'pin').map((p) => ({ num: val(p, 'num'), name: val(p, 'name', '~'), type: val(p, 'type', 'unspecified') }));
    libpins.set(`${val(lp, 'lib')}:${val(lp, 'part')}`, pins);
  }
  for (const comp of components.values()) {
    for (const p of libpins.get(`${comp.lib}:${comp.part}`) ?? []) {
      if (comp.pins.has(p.num)) continue;
      const net = `unconnected-(${comp.ref}-Pad${p.num})`;
      comp.pins.set(p.num, { num: p.num, name: p.name, type: p.type, net });
      nets.set(net, [{ ref: comp.ref, pin: p.num }]);
    }
  }
  return { components, nets };
}

export function displayName(net: string): string {
  return net.startsWith('/') ? net.slice(1) : net;
}

export function isUnconnected(net: string): boolean {
  return net.startsWith('unconnected-');
}

export function isAutoNamed(net: string): boolean {
  return net.startsWith('Net-(');
}

export type DesignSpec = Record<string, { lib: string; part: string; value: string; pins: Record<string, [name: string, type: string, net: string]> }>;

/** Test helper: a Design from a compact literal. */
export function makeDesign(spec: DesignSpec): Design {
  const components = new Map<string, Component>();
  const nets = new Map<string, { ref: string; pin: string }[]>();
  for (const [ref, c] of Object.entries(spec)) {
    const pins = new Map<string, DesignPin>();
    for (const [num, [name, type, net]] of Object.entries(c.pins)) {
      pins.set(num, { num, name, type, net });
      const list = nets.get(net) ?? [];
      list.push({ ref, pin: num });
      nets.set(net, list);
    }
    components.set(ref, { ref, value: c.value, lib: c.lib, part: c.part, pins });
  }
  return { components, nets };
}
