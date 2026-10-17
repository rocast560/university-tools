// Documents nested under documents, in the sidebar only: a workspace entry's
// `parent` names another entry, and nothing moves on disk. Pure and DOM-free,
// shared by the sidebar (drop rules, rendering) and the server (validation).

/** A root document is level 1, so a chain holds at most four documents. */
export const MAX_DOC_DEPTH = 4;

interface Node { id: string; name?: string; parent?: string | null; openedAt?: number }

function parentOf(list: readonly Node[], id: string): string | null {
  return list.find((w) => w.id === id)?.parent ?? null;
}

/** 1 for a root; counts the document itself. A cycle in bad data stops at the first repeat. */
export function docDepth(list: readonly Node[], id: string): number {
  const seen = new Set<string>([id]);
  let n = 1;
  for (let p = parentOf(list, id); p && !seen.has(p) && list.some((w) => w.id === p); p = parentOf(list, p)) { seen.add(p); n += 1; }
  return n;
}

/** Every document beneath `id`, excluding it. */
export function subtreeIds(list: readonly Node[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const w of list) {
      if (w.parent === cur && !seen.has(w.id)) { seen.add(w.id); out.push(w.id); stack.push(w.id); }
    }
  }
  return out;
}

/** Levels in the subtree rooted at `id`: 1 for a leaf. */
export function subtreeHeight(list: readonly Node[], id: string): number {
  const seen = new Set<string>([id]);
  let level = [id];
  let h = 0;
  while (level.length) {
    h += 1;
    const next: string[] = [];
    for (const cur of level) for (const w of list) if (w.parent === cur && !seen.has(w.id)) { seen.add(w.id); next.push(w.id); }
    level = next;
  }
  return h;
}

/** Why `id` cannot be nested under `parentId`, or null when it can. */
export function nestError(list: readonly Node[], id: string, parentId: string): string | null {
  if (id === parentId) return 'a document cannot be nested under itself';
  if (!list.some((w) => w.id === parentId)) return `no document ${parentId}`;
  if (subtreeIds(list, id).includes(parentId)) return 'a document cannot be nested inside its own children';
  if (parentOf(list, id) === parentId) return 'already nested there';
  if (docDepth(list, parentId) + subtreeHeight(list, id) > MAX_DOC_DEPTH) return `documents nest at most ${MAX_DOC_DEPTH} levels deep`;
  return null;
}

export interface Nesting<T extends Node> {
  /** Direct children by parent id, most recently opened first, then by name (the order roots use). */
  childrenOf: Map<string, T[]>;
  /** True for a document that sits at the top of its folder: no parent, or a parent that is not in the list. */
  isRoot(ws: Node): boolean;
}

export function buildNesting<T extends Node>(list: readonly T[]): Nesting<T> {
  const ids = new Set(list.map((w) => w.id));
  const childrenOf = new Map<string, T[]>();
  for (const w of list) {
    if (!w.parent || !ids.has(w.parent) || w.parent === w.id) continue;
    const arr = childrenOf.get(w.parent) ?? [];
    arr.push(w);
    childrenOf.set(w.parent, arr);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''));
  return { childrenOf, isRoot: (ws) => !ws.parent || !ids.has(ws.parent) || ws.parent === ws.id };
}

/**
 * How many documents that are staying would move up a level if `removed` were
 * deleted: every survivor whose parent is being removed (it is re-parented to
 * the nearest surviving ancestor, or to the folder).
 */
export function orphansMovedUp(list: readonly Node[], removed: readonly string[]): number {
  const gone = new Set(removed);
  return list.filter((w) => !gone.has(w.id) && w.parent && gone.has(w.parent)).length;
}
