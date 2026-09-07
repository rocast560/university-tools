// Whether the workspace sidebar is collapsed to its icon rail. Per browser,
// never synced: a viewing preference, not workspace data. Same shape as
// lib/collapsed-groups.ts, which stores which folders are folded shut.

export const SIDEBAR_COLLAPSED_KEY = 'tfs-sidebar-collapsed';

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * Read the persisted state. Anything that isn't a stored `true` — no value,
 * corrupt JSON, a string where a boolean belongs — means expanded: the
 * sidebar is the app's primary navigation, so an unreadable preference must
 * fail towards it being visible.
 */
export function loadSidebarCollapsed(storage: Storage | null = defaultStorage()): boolean {
  try {
    const raw = storage?.getItem(SIDEBAR_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) === true : false;
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean, storage: Storage | null = defaultStorage()): void {
  try { storage?.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* private mode, quota: a preference is not worth an error */ }
}
