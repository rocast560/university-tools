// Which sidebar folders the user has collapsed. Per browser, never synced:
// it is a viewing preference, not workspace data.

export const COLLAPSED_GROUPS_KEY = 'tfs-collapsed-groups';

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadCollapsedGroups(storage: Storage | null = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(groups: Set<string>, storage: Storage | null = defaultStorage()): void {
  try { storage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups])); } catch { /* private mode, quota: a preference is not worth an error */ }
}

/** A new set with `group` flipped; the input is left untouched. */
export function toggleGroup(groups: Set<string>, group: string): Set<string> {
  const next = new Set(groups);
  if (next.has(group)) next.delete(group); else next.add(group);
  return next;
}
