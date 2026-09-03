// The five schematic operations, pure: they take a parsed Schematic and the
// current Design and return new text plus what was placed.

import type { Design } from '../netlist.ts';
import { displayName, isAutoNamed } from '../netlist.ts';
import { powerKind } from '../parts/catalog.ts';
import { parseLibSymbol, parseSchematic, pinsOfUnit, powerUnit, type Point, type Schematic, type SymbolInstance } from './schematic.ts';
import { pinBodyDirection, pinPosition } from './transform.ts';
import { appendTopLevel, freeSpot, insertLibSymbol, labelNode, labelRotation, newUuid, nextLabelName, nextReference, powerRotation, removeByUuid, setPropertyValue, symbolNode } from './writer.ts';
import { isList, parse } from '../sexpr.ts';

export type LibProvider = (libId: string) => Promise<string>;

export interface NetTarget {
  kind: 'local' | 'global' | 'power';
  name: string;
}

export interface OpResult {
  text: string;
  placed: Record<string, Record<string, string[]>>;
  notes: string[];
  ref?: string;
  unit?: number;
}

export class OpError extends Error {}

const REVERT = 'KiCad does not reload files changed on disk: use File > Revert if the project is open in KiCad.';

export function netTarget(netName: string, design: Design): NetTarget | 'auto' {
  if (isAutoNamed(netName)) return 'auto';
  const exact = design.nets.has(netName) ? netName : [...design.nets.keys()].find((n) => displayName(n) === netName);
  const name = exact ?? netName;
  if (powerKind(name)) return { kind: 'power', name: displayName(name) };
  if (name.startsWith('/')) return { kind: 'local', name: name.slice(1) };
  if (exact) return { kind: 'global', name };
  return { kind: 'local', name };
}

export function pinEnd(sch: Schematic, ref: string, pin: string): { sym: SymbolInstance; at: Point; away: Point } | null {
  for (const sym of sch.symbols) {
    if (sym.ref !== ref) continue;
    const lib = sch.libSymbols.get(sym.libId);
    if (!lib) continue;
    const p = pinsOfUnit(lib, sym.unit).find((x) => x.number === pin);
    if (!p) continue;
    const dir = pinBodyDirection(sym, p);
    return { sym, at: pinPosition(sym, p), away: { x: -dir.x, y: -dir.y } };
  }
  return null;
}

const merge = (into: Record<string, Record<string, string[]>>, ref: string, pin: string, uuid: string) => {
  ((into[ref] ??= {})[pin] ??= []).push(uuid);
};

/** Place a label or power symbol on a pin end. Returns new text and the uuid placed. */
async function attach(sch: Schematic, ref: string, pin: string, target: NetTarget, libs: LibProvider): Promise<{ text: string; uuid: string }> {
  const end = pinEnd(sch, ref, pin);
  if (!end) throw new OpError(`${ref} has no pin ${pin} in the schematic`);
  const uuid = newUuid();
  if (target.kind === 'power') {
    const libId = `power:${target.name}`;
    let text = sch.text;
    if (!sch.libSymbols.has(libId)) text = insertLibSymbol(sch, await libs(libId));
    const s2 = parseSchematic(text, sch.project);
    const node = symbolNode({ libId, at: end.at, rot: powerRotation(end.away), unit: 1, ref: nextReference(s2, '#PWR0'), value: target.name, pinNumbers: ['1'], project: s2.project, rootUuid: s2.uuid, hideReference: true, uuid });
    return { text: appendTopLevel(s2, node), uuid };
  }
  const node = labelNode({ kind: target.kind === 'global' ? 'global_label' : 'label', text: target.name, at: end.at, rot: labelRotation(end.away), uuid });
  return { text: appendTopLevel(sch, node), uuid };
}

export async function connectPin(sch: Schematic, design: Design, ref: string, pin: string, net: string, libs: LibProvider): Promise<OpResult> {
  if (!sch.symbols.some((s) => s.ref === ref)) throw new OpError(`no component ${ref} in the schematic`);
  if (!pinEnd(sch, ref, pin)) throw new OpError(`${ref} has no pin ${pin}`);
  const placed: OpResult['placed'] = {};
  const notes: string[] = [];
  let target = netTarget(net, design);
  let cur = sch;
  if (target === 'auto') {
    const members = design.nets.get(net) ?? [];
    const anchor = members.find((m) => pinEnd(cur, m.ref, m.pin));
    if (!anchor) throw new OpError(`net ${net} has no pin to attach a name to`);
    const name = nextLabelName(cur);
    const a = await attach(cur, anchor.ref, anchor.pin, { kind: 'local', name }, libs);
    merge(placed, anchor.ref, anchor.pin, a.uuid);
    notes.push(`net ${net} had only an automatic name; named ${name} with a label on ${anchor.ref} pin ${anchor.pin}`);
    cur = parseSchematic(a.text, sch.project);
    target = { kind: 'local', name };
  }
  const r = await attach(cur, ref, pin, target, libs);
  merge(placed, ref, pin, r.uuid);
  notes.push(`${ref} pin ${pin} joined to ${target.name} with a ${target.kind === 'power' ? 'power symbol' : target.kind + ' label'}`, REVERT);
  return { text: r.text, placed, notes };
}

export async function addComponent(sch: Schematic, design: Design, a: { libId: string; value?: string; ref?: string; connections?: Record<string, string> }, libs: LibProvider): Promise<OpResult> {
  const notes: string[] = [];
  const placed: OpResult['placed'] = {};
  const libText = await libs(a.libId);
  const libRoot = parse(libText).items[0];
  if (!isList(libRoot)) throw new OpError(`library returned no symbol for ${a.libId}`);
  const lib = parseLibSymbol(libRoot);
  let text = insertLibSymbol(sch, libText);
  let cur = parseSchematic(text, sch.project);
  if (a.ref && cur.symbols.some((s) => s.ref === a.ref)) throw new OpError(`reference ${a.ref} is already used; leave ref empty to get the next free one`);
  const pwrUnit = powerUnit(lib);
  const gateUnits = Array.from({ length: lib.unitCount }, (_, i) => i + 1).filter((u) => u !== pwrUnit);
  const prefix = a.ref ? a.ref.replace(/\d+$/, '') : lib.power ? '#PWR0' : refPrefixOf(libText);
  let ref = a.ref ?? '';
  let unit = 1;
  const value = a.value ?? lib.name;
  let spot = 0;
  const nodes: string[] = [];
  const pinsFor = (u: number) => pinsOfUnit(lib, u).map((p) => p.number);
  if (!a.ref && lib.unitCount > 1 && !lib.power) {
    const byRef = new Map<string, Set<number>>();
    for (const s of cur.symbols) if (s.libId === a.libId || (s.value === value && s.libId.endsWith(`:${lib.name}`))) byRef.set(s.ref, new Set([...(byRef.get(s.ref) ?? []), s.unit]));
    for (const [r, used] of byRef) {
      const free = gateUnits.find((u) => !used.has(u));
      if (free) {
        ref = r;
        unit = free;
        notes.push(`used spare gate: unit ${free} of ${r} (${value})`);
        break;
      }
    }
  }
  if (!ref) ref = nextReference(cur, prefix);
  const at = freeSpot(cur, spot++);
  nodes.push(symbolNode({ libId: a.libId, at, unit, ref, value, pinNumbers: pinsFor(unit), project: cur.project, rootUuid: cur.uuid, hideReference: lib.power }));
  const addedUnits = [unit];
  if (!notes.length && pwrUnit && lib.unitCount > 1) {
    const at2 = { x: at.x, y: at.y + 12.7 };
    nodes.push(symbolNode({ libId: a.libId, at: at2, unit: pwrUnit, ref, value, pinNumbers: pinsFor(pwrUnit), project: cur.project, rootUuid: cur.uuid }));
    addedUnits.push(pwrUnit);
  }
  for (const n of nodes) {
    text = appendTopLevel(cur, n);
    cur = parseSchematic(text, sch.project);
  }
  notes.push(`added ${ref} (${a.libId}${value !== lib.name ? `, ${value}` : ''})${addedUnits.length > 1 ? ` with units ${addedUnits.join(' and ')}` : lib.unitCount > 1 ? ` unit ${unit}` : ''}`);
  const available = new Set(addedUnits.flatMap(pinsFor));
  for (const [pin, net] of Object.entries(a.connections ?? {})) {
    if (!available.has(pin)) {
      notes.push(`pin ${pin} is not part of the placed unit${addedUnits.length > 1 ? 's' : ''} (${[...available].join(', ')}); connect it after adding the unit that has it`);
      continue;
    }
    const r = await connectPin(cur, design, ref, pin, net, libs);
    for (const [rr, pins] of Object.entries(r.placed)) for (const [pp, ids] of Object.entries(pins)) for (const id of ids) merge(placed, rr, pp, id);
    notes.push(...r.notes.filter((n) => n !== REVERT));
    text = r.text;
    cur = parseSchematic(text, sch.project);
  }
  notes.push(REVERT);
  return { text, placed, notes, ref, unit };
}

function refPrefixOf(libText: string): string {
  const m = /\(property\s+"Reference"\s+"([A-Za-z#]+)"/.exec(libText);
  return m ? m[1] : 'U';
}

export function disconnectPin(sch: Schematic, ref: string, pin: string, placed: Record<string, Record<string, string[]>>): OpResult {
  const ids = placed[ref]?.[pin] ?? [];
  if (!ids.length) return { text: sch.text, placed: {}, notes: [`${ref} pin ${pin}: nothing placed by this tool to remove; labels or wires drawn by hand stay (delete them in KiCad)`] };
  const text = removeByUuid(sch, ids);
  return { text, placed: { '-': { [ref]: ids, pin: [pin] } }, notes: [`removed ${ids.length} label${ids.length > 1 ? 's' : ''} from ${ref} pin ${pin}`, REVERT] };
}

export function removeComponent(sch: Schematic, ref: string, placed: Record<string, Record<string, string[]>>): OpResult {
  const units = sch.symbols.filter((s) => s.ref === ref);
  if (!units.length) throw new OpError(`no component ${ref} in the schematic`);
  const ids = [...units.map((u) => u.uuid), ...Object.values(placed[ref] ?? {}).flat()];
  return { text: removeByUuid(sch, ids), placed: { '-': { [ref]: ids, '*': ['*'] } }, notes: [`removed ${ref} (${units.length} unit${units.length > 1 ? 's' : ''}) and ${ids.length - units.length} placed labels; wires drawn by hand to ${ref} remain, delete them in KiCad`, REVERT] };
}

export function setValue(sch: Schematic, ref: string, value: string): OpResult {
  let cur = sch;
  const units = sch.symbols.filter((s) => s.ref === ref);
  if (!units.length) throw new OpError(`no component ${ref} in the schematic`);
  for (let i = 0; i < units.length; i++) {
    const sym = cur.symbols.filter((s) => s.ref === ref)[i];
    cur = parseSchematic(setPropertyValue(cur, sym, 'Value', value), sch.project);
  }
  return { text: cur.text, placed: {}, notes: [`${ref} value set to ${value}`, REVERT] };
}
