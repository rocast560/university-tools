// Typed view of a .kicad_sch file. Every model object keeps its List node so
// the writer (part 4) can find the exact text span to edit.

import { atom, child, children, isList, num, parse, type List } from '../sexpr.ts';

export interface Point {
  x: number;
  y: number;
}

export interface LibPin {
  number: string;
  name: string;
  type: string;
  at: Point;
  angle: 0 | 90 | 180 | 270;
  length: number;
}

export interface LibSymbol {
  /** Full id as written in lib_symbols, e.g. "74xx:74LS04". */
  id: string;
  /** Name without the library nickname, e.g. "74LS04". */
  name: string;
  extends: string | null;
  power: boolean;
  /** Unit number -> pins. Unit 0 holds pins common to every unit. */
  units: Map<number, LibPin[]>;
  unitCount: number;
  node: List;
}

export interface SymbolInstance {
  uuid: string;
  libId: string;
  at: Point;
  rot: 0 | 90 | 180 | 270;
  mirror: 'x' | 'y' | null;
  unit: number;
  ref: string;
  value: string;
  properties: Record<string, string>;
  pinUuids: Map<string, string>;
  node: List;
}

export interface Label {
  kind: 'label' | 'global_label' | 'hierarchical_label';
  text: string;
  at: Point;
  rot: number;
  uuid: string;
  node: List;
}

export interface SchWire {
  uuid: string;
  pts: Point[];
  node: List;
}

export interface Schematic {
  text: string;
  root: List;
  uuid: string;
  project: string;
  paper: string;
  libSymbols: Map<string, LibSymbol>;
  libSymbolsNode: List | null;
  symbols: SymbolInstance[];
  labels: Label[];
  wires: SchWire[];
  junctions: Point[];
  noConnects: Point[];
  sheets: number;
  buses: number;
}

export class SchematicError extends Error {}

function pointOf(l: List | undefined, fallback: Point = { x: 0, y: 0 }): Point {
  return l ? { x: num(l, 1), y: num(l, 2) } : fallback;
}

function rotOf(l: List | undefined): 0 | 90 | 180 | 270 {
  const r = l && l.items.length > 3 ? num(l, 3) : 0;
  const n = ((Math.round(r) % 360) + 360) % 360;
  if (n === 0 || n === 90 || n === 180 || n === 270) return n;
  throw new SchematicError(`unsupported rotation ${r}`);
}

function parseLibPin(p: List): LibPin {
  const at = child(p, 'at');
  return {
    number: atom(child(p, 'number')!, 1) ?? '',
    name: atom(child(p, 'name')!, 1) ?? '~',
    type: atom(p, 1) ?? 'unspecified',
    at: pointOf(at),
    angle: rotOf(at),
    length: child(p, 'length') ? num(child(p, 'length')!, 1) : 0,
  };
}

export function parseLibSymbol(node: List): LibSymbol {
  const id = atom(node, 1) ?? '';
  const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const ext = child(node, 'extends');
  const units = new Map<number, LibPin[]>();
  let unitCount = 0;
  for (const sub of children(node, 'symbol')) {
    const subName = atom(sub, 1) ?? '';
    const m = /_(\d+)_(\d+)$/.exec(subName);
    if (!m) continue;
    const unit = Number(m[1]);
    const style = Number(m[2]);
    if (style > 1) continue; // alternate body styles repeat the same pins
    unitCount = Math.max(unitCount, unit);
    const list = units.get(unit) ?? [];
    for (const p of children(sub, 'pin')) {
      const pin = parseLibPin(p);
      if (!list.some((x) => x.number === pin.number)) list.push(pin);
    }
    units.set(unit, list);
  }
  return { id, name, extends: ext ? (atom(ext, 1) ?? null) : null, power: !!child(node, 'power'), units, unitCount, node };
}

export function pinsOfUnit(lib: LibSymbol, unit: number): LibPin[] {
  const common = lib.units.get(0) ?? [];
  const own = unit === 0 ? [] : lib.units.get(unit) ?? [];
  const seen = new Set<string>();
  const out: LibPin[] = [];
  for (const p of [...own, ...common]) {
    if (seen.has(p.number)) continue;
    seen.add(p.number);
    out.push(p);
  }
  return out;
}

/** For multi-unit chips: the unit whose pins are all power pins (74LS00 unit 5, LM358 unit 3). */
export function powerUnit(lib: LibSymbol): number | null {
  if (lib.unitCount < 2) return null;
  for (const [u, pins] of lib.units) {
    if (u === 0 || !pins.length) continue;
    if (pins.every((p) => p.type === 'power_in' || p.type === 'power_out')) return u;
  }
  return null;
}

function parseSymbolInstance(node: List, project: string): SymbolInstance {
  const at = child(node, 'at');
  const mirror = child(node, 'mirror');
  const properties: Record<string, string> = {};
  for (const p of children(node, 'property')) properties[atom(p, 1) ?? ''] = atom(p, 2) ?? '';
  let ref = properties.Reference ?? '';
  let unit = child(node, 'unit') ? num(child(node, 'unit')!, 1) : 1;
  const inst = child(node, 'instances');
  if (inst) {
    const proj = children(inst, 'project').find((p) => atom(p, 1) === project) ?? children(inst, 'project')[0];
    const path = proj ? child(proj, 'path') : undefined;
    if (path) {
      ref = atom(child(path, 'reference') ?? path, 1) ?? ref;
      if (child(path, 'unit')) unit = num(child(path, 'unit')!, 1);
    }
  }
  const pinUuids = new Map<string, string>();
  for (const p of children(node, 'pin')) {
    const u = child(p, 'uuid');
    pinUuids.set(atom(p, 1) ?? '', u ? (atom(u, 1) ?? '') : '');
  }
  return {
    uuid: atom(child(node, 'uuid')!, 1) ?? '',
    libId: atom(child(node, 'lib_id')!, 1) ?? '',
    at: pointOf(at),
    rot: rotOf(at),
    mirror: mirror ? ((atom(mirror, 1) as 'x' | 'y') ?? null) : null,
    unit,
    ref,
    value: properties.Value ?? '',
    properties,
    pinUuids,
    node,
  };
}

export function parseSchematic(text: string, fallbackProject = 'project'): Schematic {
  const root = parse(text);
  const top = root.items[0];
  if (!isList(top) || atom(top, 0) !== 'kicad_sch') throw new SchematicError('not a KiCad schematic (expected (kicad_sch ...))');
  const uuidNode = child(top, 'uuid');
  const paperNode = child(top, 'paper');
  const libSymbolsNode = child(top, 'lib_symbols') ?? null;
  const libSymbols = new Map<string, LibSymbol>();
  if (libSymbolsNode) for (const s of children(libSymbolsNode, 'symbol')) {
    const lib = parseLibSymbol(s);
    libSymbols.set(lib.id, lib);
  }
  let project = fallbackProject;
  for (const s of children(top, 'symbol')) {
    const inst = child(s, 'instances');
    const proj = inst ? children(inst, 'project')[0] : undefined;
    if (proj && atom(proj, 1)) {
      project = atom(proj, 1)!;
      break;
    }
  }
  const symbols = children(top, 'symbol').map((s) => parseSymbolInstance(s, project));
  const labels: Label[] = [];
  for (const kind of ['label', 'global_label', 'hierarchical_label'] as const) {
    for (const l of children(top, kind)) {
      const at = child(l, 'at');
      labels.push({ kind, text: atom(l, 1) ?? '', at: pointOf(at), rot: at && at.items.length > 3 ? num(at, 3) : 0, uuid: atom(child(l, 'uuid') ?? l, 1) ?? '', node: l });
    }
  }
  const wires = children(top, 'wire').map((w) => ({
    uuid: atom(child(w, 'uuid') ?? w, 1) ?? '',
    pts: children(child(w, 'pts') ?? w, 'xy').map((xy) => pointOf(xy)),
    node: w,
  }));
  return {
    text,
    root,
    uuid: uuidNode ? (atom(uuidNode, 1) ?? '') : '',
    project,
    paper: paperNode ? (atom(paperNode, 1) ?? 'A4') : 'A4',
    libSymbols,
    libSymbolsNode,
    symbols,
    labels,
    wires,
    junctions: children(top, 'junction').map((j) => pointOf(child(j, 'at'))),
    noConnects: children(top, 'no_connect').map((j) => pointOf(child(j, 'at'))),
    sheets: children(top, 'sheet').length,
    buses: children(top, 'bus').length + children(top, 'bus_entry').length,
  };
}
