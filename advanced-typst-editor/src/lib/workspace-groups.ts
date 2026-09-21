import { isDescendant } from '@/lib/folder-tree';
import type { WorkspaceStatus } from '@/types';
/** `knownGroups` (e.g. from settings) are included even with no member workspaces yet. */
export function groupWorkspaces(list: WorkspaceStatus[], knownGroups: string[] = []): Array<{ group: string | null; items: WorkspaceStatus[] }> {
  const by = new Map<string | null, WorkspaceStatus[]>();
  for (const ws of list) { const k = ws.group ?? null; const arr = by.get(k) ?? []; arr.push(ws); by.set(k, arr); }
  const byRecent = (a: WorkspaceStatus, b: WorkspaceStatus) => b.openedAt - a.openedAt || a.name.localeCompare(b.name);
  const fromWorkspaces = [...by.keys()].filter((g): g is string => g !== null);
  const groups = [...new Set([...fromWorkspaces, ...knownGroups])].sort((a, b) => a.localeCompare(b));
  return [...(by.has(null) ? [null] : []), ...groups].map((group) => ({ group, items: (by.get(group) ?? []).sort(byRecent) }));
}

/**
 * Workspaces keyed by their exact folder path; '' holds the top level. Each
 * list is sorted most-recently-opened first, then by name, which is the order
 * the flat sidebar already used.
 */
export function workspacesByFolder(list: WorkspaceStatus[]): Map<string, WorkspaceStatus[]> {
  const by = new Map<string, WorkspaceStatus[]>();
  for (const ws of list) {
    const k = ws.group ?? '';
    const arr = by.get(k) ?? [];
    arr.push(ws);
    by.set(k, arr);
  }
  for (const arr of by.values()) arr.sort((a, b) => b.openedAt - a.openedAt || a.name.localeCompare(b.name));
  return by;
}

/** How many workspaces sit in `path` or anywhere beneath it. */
export function subtreeCount(by: Map<string, WorkspaceStatus[]>, path: string): number {
  let n = 0;
  for (const [k, arr] of by) if (k && isDescendant(k, path)) n += arr.length;
  return n;
}
