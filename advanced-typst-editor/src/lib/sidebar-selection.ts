// Multi-select for the sidebar's workspace rows. Pure and immutable so the
// click rules (plain / Ctrl-Cmd / Shift) can be tested without a DOM; the
// Sidebar keeps one Selection in state and feeds it the visible row order.

import { docKey } from '@/lib/collapsed-groups';
import { childPaths } from '@/lib/folder-tree';
import type { Nesting } from '@/lib/workspace-nesting';
import type { WorkspaceStatus } from '@/types';

export interface Selection {
  ids: ReadonlySet<string>;
  /** The row a Shift-click range grows from; the last row clicked without Shift. */
  anchor: string | null;
}

/** Modifier keys of a row click: Ctrl/Cmd toggles, Shift ranges, neither is a plain click. */
export interface ClickMods { toggle: boolean; range: boolean }

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

/** A plain click, or a right-click outside the selection: just this row. */
export function resetTo(id: string): Selection {
  return { ids: new Set([id]), anchor: id };
}

/**
 * Ctrl/Cmd+click. The anchor moves to the clicked row even when it was just
 * deselected, as file managers do, so a following Shift-click ranges from here.
 */
export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift+click: replace the selection with every row between the anchor and
 * `id` in `order` (the sidebar's visible order, so rows hidden by a collapsed
 * folder are never swept in). The anchor stays put so the range can be
 * re-extended. With no anchor, or one that is no longer visible, it degrades
 * to selecting just `id`.
 */
export function rangeTo(sel: Selection, order: readonly string[], id: string): Selection {
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return resetTo(id);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { ids: new Set(order.slice(lo, hi + 1)), anchor: sel.anchor };
}

/** Drop ids that are gone (deleted, or removed by another client). Returns the same object when nothing changed. */
export function pruneSelection(sel: Selection, existing: ReadonlySet<string>): Selection {
  let changed = false;
  const ids = new Set<string>();
  for (const id of sel.ids) { if (existing.has(id)) ids.add(id); else changed = true; }
  if (!changed) return sel;
  return { ids, anchor: sel.anchor !== null && existing.has(sel.anchor) ? sel.anchor : null };
}

/** The selected ids in the order the rows appear, which is the order dialogs list them. */
export function selectedList(sel: Selection, order: readonly string[]): string[] {
  return order.filter((id) => sel.ids.has(id));
}

/**
 * Workspace ids in the order the sidebar renders them (mirrors FolderTree):
 * each folder's subfolders A-Z with their contents, then the workspaces filed
 * directly in it. A collapsed folder contributes nothing.
 *
 * With `nesting`, a document is followed by its children (depth first) unless
 * the document is collapsed (`docKey`); only top-level documents start a list.
 * Without it every document is a flat row, as before nesting existed.
 */
export function visibleOrder(
  groups: string[],
  byFolder: Map<string, WorkspaceStatus[]>,
  collapsed: ReadonlySet<string>,
  parent: string | null = null,
  nesting?: Nesting<WorkspaceStatus>,
): string[] {
  const out: string[] = [];
  for (const path of childPaths(groups, parent)) {
    if (!collapsed.has(path)) out.push(...visibleOrder(groups, byFolder, collapsed, path, nesting));
  }
  const pushDoc = (w: WorkspaceStatus, seen: Set<string>) => {
    out.push(w.id);
    seen.add(w.id);
    if (!nesting || collapsed.has(docKey(w.id))) return;
    for (const c of nesting.childrenOf.get(w.id) ?? []) if (!seen.has(c.id)) pushDoc(c, seen);
  };
  for (const w of byFolder.get(parent ?? '') ?? []) if (!nesting || nesting.isRoot(w)) pushDoc(w, new Set());
  return out;
}
