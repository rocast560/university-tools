// Span-level edits to a schematic's text plus builders for new nodes.
// Every function returns the new text; re-parse before the next edit.

import { q, round4, serialize, type B } from '../sexpr.ts';
import type { Point, Schematic, SymbolInstance } from './schematic.ts';

export const GRID = 1.27;

export function newUuid(): string {
  return crypto.randomUUID();
}

export function snap(v: number, grid = GRID): number {
  return round4(Math.round(v / grid) * grid);
}

export function contentBounds(sch: Schematic): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Point[] = [...sch.symbols.map((s) => s.at), ...sch.labels.map((l) => l.at), ...sch.wires.flatMap((w) => w.pts), ...sch.junctions];
  if (!pts.length) return { minX: 25.4, minY: 25.4, maxX: 25.4, maxY: 25.4 };
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
}

/** A grid to the right of the drawing: four rows per column, 25.4 mm pitch. */
export function freeSpot(sch: Schematic, index: number): Point {
  const b = contentBounds(sch);
  const x0 = snap(b.maxX + 25.4 * 2, 25.4);
  const y0 = snap(b.minY, 25.4);
  return { x: round4(x0 + Math.floor(index / 4) * 25.4), y: round4(y0 + (index % 4) * 25.4) };
}

export function nextReference(sch: Schematic, prefix: string): string {
  let max = 0;
  for (const s of sch.symbols) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(s.ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function nextLabelName(sch: Schematic, prefix = 'N'): string {
  const used = new Set(sch.labels.map((l) => l.text));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function labelRotation(away: Point): 0 | 90 | 180 | 270 {
  if (away.x > 0) return 0;
  if (away.x < 0) return 180;
  return away.y < 0 ? 90 : 270;
}

/** power:* symbols draw upward at 0; rotate so the bar points away from the pin's body. */
export function powerRotation(away: Point): 0 | 90 | 180 | 270 {
  if (away.y < 0) return 0;
  if (away.y > 0) return 180;
  return away.x < 0 ? 90 : 270;
}

const indentBlock = (text: string, tabs: number) => text.split('\n').map((l, i) => (i === 0 ? l : '\t'.repeat(tabs) + l)).join('\n');

export function insertLibSymbol(sch: Schematic, symbolText: string): string {
  const id = /^\(symbol\s+"([^"]+)"/.exec(symbolText)?.[1] ?? '';
  if (sch.libSymbols.has(id)) return sch.text;
  const block = '\n\t\t' + indentBlock(symbolText.trim(), 2);
  if (sch.libSymbolsNode) {
    const at = sch.libSymbolsNode.end - 1;
    return sch.text.slice(0, at) + block + '\n\t' + sch.text.slice(at);
  }
  const top = sch.root.items[0];
  const paper = /\(paper\s+"[^"]*"\)/.exec(sch.text);
  const at = paper ? paper.index + paper[0].length : (top as { start: number }).start + '(kicad_sch'.length;
  return sch.text.slice(0, at) + '\n\t(lib_symbols' + block + '\n\t)' + sch.text.slice(at);
}

const hiddenProp = (name: string, value: string, at: Point): B => ['property', q(name), q(value), ['at', at.x, at.y, 0], ['effects', ['font', ['size', 1.27, 1.27]], ['hide', 'yes']]];

export function symbolNode(o: { libId: string; at: Point; rot?: number; unit: number; ref: string; value: string; pinNumbers: string[]; project: string; rootUuid: string; hideReference?: boolean; uuid?: string }): string {
  const { at } = o;
  const refProp: B = o.hideReference ? hiddenProp('Reference', o.ref, { x: at.x, y: round4(at.y - 2.54) }) : ['property', q('Reference'), q(o.ref), ['at', round4(at.x + 2.54), round4(at.y - 1.27), 0], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']]];
  const node: B = [
    'symbol',
    ['lib_id', q(o.libId)],
    ['at', at.x, at.y, o.rot ?? 0],
    ['unit', o.unit],
    ['exclude_from_sim', 'no'],
    ['in_bom', o.hideReference ? 'no' : 'yes'],
    ['on_board', o.hideReference ? 'no' : 'yes'],
    ['dnp', 'no'],
    ['uuid', q(o.uuid ?? newUuid())],
    refProp,
    ['property', q('Value'), q(o.value), ['at', round4(at.x + 2.54), round4(at.y + 1.27), 0], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', 'left']]],
    hiddenProp('Footprint', '', at),
    hiddenProp('Datasheet', '', at),
    hiddenProp('Description', '', at),
    ...o.pinNumbers.map((p): B => ['pin', q(p), ['uuid', q(newUuid())]]),
    ['instances', ['project', q(o.project), ['path', q(`/${o.rootUuid}`), ['reference', q(o.ref)], ['unit', o.unit]]]],
  ];
  return serialize(node);
}

export function labelNode(o: { kind: 'label' | 'global_label'; text: string; at: Point; rot: number; uuid?: string }): string {
  const justify = o.rot === 180 ? 'right' : 'left';
  const node: B = [o.kind, q(o.text)];
  if (o.kind === 'global_label') node.push(['shape', 'input']);
  node.push(['at', o.at.x, o.at.y, o.rot]);
  if (o.kind === 'global_label') node.push(['fields_autoplaced', 'yes']);
  node.push(['effects', ['font', ['size', 1.27, 1.27]], ['justify', justify, 'bottom']]);
  node.push(['uuid', q(o.uuid ?? newUuid())]);
  if (o.kind === 'global_label') node.push(['property', q('Intersheetrefs'), q('${INTERSHEET_REFS}'), ['at', o.at.x, o.at.y, 0], ['effects', ['font', ['size', 1.27, 1.27]], ['hide', 'yes']]]);
  return serialize(node);
}

export function appendTopLevel(sch: Schematic, nodeText: string): string {
  const top = sch.root.items[0] as { end: number };
  const at = top.end - 1;
  return sch.text.slice(0, at) + '\t' + indentBlock(nodeText.trim(), 1) + '\n' + sch.text.slice(at);
}

export function removeByUuid(sch: Schematic, uuids: string[]): string {
  const want = new Set(uuids);
  const spans: { start: number; end: number }[] = [];
  for (const s of sch.symbols) if (want.has(s.uuid)) spans.push({ start: s.node.start, end: s.node.end });
  for (const l of sch.labels) if (want.has(l.uuid)) spans.push({ start: l.node.start, end: l.node.end });
  for (const w of sch.wires) if (want.has(w.uuid)) spans.push({ start: w.node.start, end: w.node.end });
  spans.sort((a, b) => b.start - a.start);
  let text = sch.text;
  for (const sp of spans) {
    let start = sp.start;
    while (start > 0 && (text[start - 1] === '\t' || text[start - 1] === ' ')) start--;
    if (start > 0 && text[start - 1] === '\n') start--;
    text = text.slice(0, start) + text.slice(sp.end);
  }
  return text;
}

export function setPropertyValue(sch: Schematic, sym: SymbolInstance, name: string, value: string): string {
  const props = sym.node.items.filter((it) => it.type === 'list' && it.items[0]?.type === 'atom' && it.items[0].value === 'property');
  for (const p of props) {
    if (p.type !== 'list') continue;
    const key = p.items[1];
    const val = p.items[2];
    if (key?.type === 'atom' && key.value === name && val?.type === 'atom') {
      const quoted = '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      return sch.text.slice(0, val.start) + quoted + sch.text.slice(val.end);
    }
  }
  const at = sym.node.end - 1;
  return sch.text.slice(0, at) + '\t\t' + serialize(hiddenProp(name, value, sym.at), 2) + '\n\t' + sch.text.slice(at);
}
