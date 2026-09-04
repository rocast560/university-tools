// Pull one symbol out of a .kicad_sym library as text suitable for a
// schematic's lib_symbols section. Derived symbols ((extends "PARENT")) are
// flattened: the parent's body with the child's properties, sub-symbols
// renamed from PARENT_u_s to NAME_u_s.

import { atom, child, children, isList, parse, type List } from '../sexpr.ts';

export class LibSymbolError extends Error {}

function topSymbol(root: List, name: string): List | undefined {
  const lib = root.items[0];
  if (!isList(lib)) return undefined;
  return children(lib, 'symbol').find((s) => atom(s, 1) === name);
}

export function extractLibSymbol(libText: string, name: string, nickname: string): string {
  const root = parse(libText);
  const node = topSymbol(root, name);
  if (!node) throw new LibSymbolError(`symbol "${name}" is not in the ${nickname} library`);
  const ext = child(node, 'extends');
  let text: string;
  let baseName = name;
  if (ext) {
    const parentName = atom(ext, 1) ?? '';
    const parent = topSymbol(root, parentName);
    if (!parent) throw new LibSymbolError(`symbol "${name}" extends "${parentName}", which is missing from the ${nickname} library`);
    baseName = parentName;
    text = libText.slice(parent.start, parent.end);
    // Override or add the child's properties, editing from the end so spans stay valid.
    const parentProps = children(parent, 'property');
    const childProps = children(node, 'property');
    const edits: { start: number; end: number; repl: string }[] = [];
    const firstSub = children(parent, 'symbol')[0];
    for (const cp of childProps) {
      const pname = atom(cp, 1);
      const repl = libText.slice(cp.start, cp.end);
      const pp = parentProps.find((x) => atom(x, 1) === pname);
      if (pp) edits.push({ start: pp.start - parent.start, end: pp.end - parent.start, repl });
      else edits.push({ start: (firstSub ? firstSub.start : parent.end - 1) - parent.start, end: (firstSub ? firstSub.start : parent.end - 1) - parent.start, repl: repl + '\n\t\t' });
    }
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) text = text.slice(0, e.start) + e.repl + text.slice(e.end);
  } else {
    text = libText.slice(node.start, node.end);
  }
  text = text.replace(/^\(symbol\s+"[^"]*"/, `(symbol "${nickname}:${name}"`);
  const sub = new RegExp(`\\(symbol\\s+"${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)_(\\d+)"`, 'g');
  text = text.replace(sub, `(symbol "${name}_$1_$2"`);
  return text;
}
