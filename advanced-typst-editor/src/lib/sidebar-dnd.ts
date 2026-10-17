// What the sidebar allows to be dropped where. Pure and DOM-free, so the rules
// are unit-tested directly and the components only render the verdict.

import { MAX_FOLDER_DEPTH, depth, descendantsOf, folderName, isDescendant, joinPath, parentPath } from '@/lib/folder-tree';
import { nestError } from '@/lib/workspace-nesting';

/**
 * Where a drag can land: a folder path, null for the list background (the top
 * level), or `{ workspace }` for a document row, which nests the drag under it.
 */
export type DropTarget = string | null | { workspace: string };
export type DragPayload = { kind: 'workspace'; id: string } | { kind: 'folder'; path: string };

/**
 * `text/plain` rather than a custom type: the browser sets it for free on a
 * plain drag, and jsdom's DataTransfer stand-in in the tests keeps it simple.
 */
export const SIDEBAR_DRAG_MIME = 'text/plain';

export function encodeDrag(p: DragPayload): string {
  return p.kind === 'workspace' ? `workspace:${p.id}` : `folder:${p.path}`;
}

/** The payload, or null for a drag that did not start in this sidebar. */
export function parseDrag(raw: string): DragPayload | null {
  const i = raw.indexOf(':');
  if (i === -1) return null;
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (!rest) return null;
  if (kind === 'workspace') return { kind: 'workspace', id: rest };
  if (kind === 'folder') return { kind: 'folder', path: rest };
  return null;
}

/**
 * `workspaces` is the document list (only `id` and `parent` are read); it is
 * needed to judge a drop on a document row, and may be left out otherwise.
 */
export function canDrop(payload: DragPayload, target: DropTarget, groups: string[], workspaces: ReadonlyArray<{ id: string; parent?: string | null }> = []): boolean {
  if (target !== null && typeof target === 'object') {
    // Nesting is a document-on-document move. A folder dropped on a row is resolved
    // by the caller to that row's folder, so it is not a legal nest.
    return payload.kind === 'workspace' && nestError(workspaces, payload.id, target.workspace) === null;
  }
  // A workspace belongs to exactly one folder; every folder is a valid home.
  // Dropping on a folder also un-nests it, so even its own folder is a real move.
  if (payload.kind === 'workspace') return true;

  const { path } = payload;
  // Into itself or its own subtree would orphan the subtree.
  if (target !== null && isDescendant(target, path)) return false;
  // Already there: nothing to do, so nothing to highlight.
  if (parentPath(path) === target) return false;
  // A sibling of that name at the destination would collide.
  if (groups.includes(joinPath(target, folderName(path)))) return false;
  // The whole subtree travels, so its deepest folder sets the limit.
  const subtree = [path, ...descendantsOf(groups, path)];
  const deepest = Math.max(...subtree.map(depth));
  return deepest - depth(path) + depth(joinPath(target, folderName(path))) <= MAX_FOLDER_DEPTH;
}
