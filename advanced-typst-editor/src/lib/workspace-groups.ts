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
