// KiCad S-expression reader and writer.
//
// parse() keeps the byte span of every node so the schematic writer can
// replace or delete exact ranges of the original text without reformatting
// anything it did not touch. serialize() produces KiCad-style text for new
// nodes (one child list per line, tab indented); KiCad accepts any whitespace.

export interface Atom {
  type: 'atom';
  value: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface List {
  type: 'list';
  items: Node[];
  start: number;
  end: number;
}

export type Node = Atom | List;

export class SexprError extends Error {}

export function isList(n: Node | undefined): n is List {
  return !!n && n.type === 'list';
}

export function parse(text: string): List {
  const root: List = { type: 'list', items: [], start: 0, end: text.length };
  const stack: List[] = [root];
  const n = text.length;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      stack.push({ type: 'list', items: [], start: i, end: -1 });
      i++;
      continue;
    }
    if (c === ')') {
      if (stack.length < 2) throw new SexprError(`unexpected ')' at offset ${i}`);
      const done = stack.pop()!;
      done.end = i + 1;
      top().items.push(done);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < n) {
          const e = text[j + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          v += text[j];
          j++;
        }
      }
      if (j >= n) throw new SexprError(`unterminated string at offset ${i}`);
      top().items.push({ type: 'atom', value: v, quoted: true, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !isDelimiter(text[j])) j++;
    top().items.push({ type: 'atom', value: text.slice(i, j), quoted: false, start: i, end: j });
    i = j;
  }
  if (stack.length !== 1) throw new SexprError('unbalanced input: missing ")"');
  return root;
}

function isDelimiter(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '(' || c === ')' || c === '"';
}

export function head(l: List): string | undefined {
  const first = l.items[0];
  return first && first.type === 'atom' ? first.value : undefined;
}

export function child(l: List, key: string): List | undefined {
  for (const it of l.items) if (isList(it) && head(it) === key) return it;
  return undefined;
}

export function children(l: List, key: string): List[] {
  return l.items.filter((it): it is List => isList(it) && head(it) === key);
}

export function atom(l: List, i: number): string | undefined {
  const it = l.items[i];
  return it && it.type === 'atom' ? it.value : undefined;
}

export function num(l: List, i: number): number {
  const v = Number(atom(l, i));
  if (Number.isNaN(v)) throw new SexprError(`expected a number at item ${i} of (${head(l)} ...)`);
  return v;
}

// ---------- writer ----------

export type B = string | number | { q: string } | B[];

export const q = (s: string): { q: string } => ({ q: s });

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** KiCad-style text: atoms of a list on the head line, child lists on their own lines. */
export function serialize(b: B, indent = 0): string {
  if (typeof b === 'number') return formatNumber(b);
  if (typeof b === 'string') return b;
  if (!Array.isArray(b)) return quote(b.q);
  const pad = '\t'.repeat(indent);
  const inner = '\t'.repeat(indent + 1);
  const atoms: string[] = [];
  const lists: B[] = [];
  for (const it of b) (Array.isArray(it) ? lists : atoms).push(Array.isArray(it) ? it : serialize(it));
  if (!lists.length) return `(${atoms.join(' ')})`;
  return `(${atoms.join(' ')}\n${lists.map((l) => inner + serialize(l, indent + 1)).join('\n')}\n${pad})`;
}

export function formatNumber(v: number): string {
  const r = Math.round(v * 10000) / 10000;
  return Number.isInteger(r) ? String(r) : String(r);
}

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
