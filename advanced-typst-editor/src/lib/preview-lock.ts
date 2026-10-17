// Which documents have their preview locked. A locked preview ignores clicks
// for navigation: no jump to the code, no asset flash, so text can be
// selected and copied freely (typically while an AI edits over MCP and the
// operator only reads). Per browser, never synced: a viewing preference, not
// workspace data.
//
// A "document" is a workspace, and every .typ file in it shares its lock.
// `all` is the default for every workspace; `overrides` records the ones that
// differ from it, so "Lock all" followed by one "Unlock" stays expressible.

export const PREVIEW_LOCK_KEY = 'tfs-preview-lock';

export interface PreviewLock {
  all: boolean;
  /** Workspace id -> locked, only where it differs from `all`. */
  overrides: Record<string, boolean>;
}

const UNLOCKED: PreviewLock = { all: false, overrides: {} };

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadPreviewLock(storage: Storage | null = defaultStorage()): PreviewLock {
  try {
    const raw = storage?.getItem(PREVIEW_LOCK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...UNLOCKED, overrides: {} };
    const { all, overrides } = parsed as { all?: unknown; overrides?: unknown };
    const clean: Record<string, boolean> = {};
    if (typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)) {
      for (const [id, v] of Object.entries(overrides)) if (typeof v === 'boolean') clean[id] = v;
    }
    return { all: all === true, overrides: clean };
  } catch {
    return { ...UNLOCKED, overrides: {} };
  }
}

export function savePreviewLock(lock: PreviewLock, storage: Storage | null = defaultStorage()): void {
  try { storage?.setItem(PREVIEW_LOCK_KEY, JSON.stringify(lock)); } catch { /* private mode, quota: a preference is not worth an error */ }
}

/** A workspace's own override wins; otherwise the global flag decides. */
export function isLocked(lock: PreviewLock, id: string): boolean {
  return lock.overrides[id] ?? lock.all;
}

/**
 * A new lock with `id`'s effective state flipped. The override is dropped when
 * the new state equals `all`, so storage only holds real exceptions.
 */
export function toggleWorkspaceLock(lock: PreviewLock, id: string): PreviewLock {
  const next = !isLocked(lock, id);
  const overrides = { ...lock.overrides };
  if (next === lock.all) delete overrides[id]; else overrides[id] = next;
  return { all: lock.all, overrides };
}

/** Lock or unlock everything; overrides are cleared so "Lock all" really locks all. */
export function setAllLocked(_lock: PreviewLock, locked: boolean): PreviewLock {
  return { all: locked, overrides: {} };
}

/**
 * Drop the overrides of workspaces that no longer exist, so storage doesn't
 * accumulate ids of deleted documents. Returns the same object when none of
 * `ids` had an override, letting the caller skip a save and a state update.
 */
export function forgetWorkspaceLocks(lock: PreviewLock, ids: readonly string[]): PreviewLock {
  if (!ids.some((id) => id in lock.overrides)) return lock;
  const overrides = { ...lock.overrides };
  for (const id of ids) delete overrides[id];
  return { all: lock.all, overrides };
}
