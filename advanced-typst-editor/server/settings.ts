import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { descendantsOf, folderName, renamePath, withAncestors } from '../src/lib/folder-tree';
import type { FolderMeta, Settings, WorkspaceEntry } from '../src/types';
import { isDir, readJson, writeAtomic } from './fsx';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  workspaces: [],
  groups: [],
  folderMeta: {},
  backup: { destinations: [], snapshotIntervalMin: 60, keepSnapshots: 30 },
  typstCli: null,
  redaction: { style: 'gaussian', strength: 1 },
};

export interface SettingsStore {
  get(): Settings;
  update(fn: (s: Settings) => Settings): Settings;
  listWorkspaces(): WorkspaceEntry[];
  getWorkspace(id: string): WorkspaceEntry | null;
  findByPath(p: string): WorkspaceEntry | null;
  addWorkspace(input: { path: string; name: string; group: string | null; library: boolean }): WorkspaceEntry;
  patchWorkspace(id: string, patch: Partial<Pick<WorkspaceEntry, 'name' | 'group' | 'path' | 'openedAt'>>): WorkspaceEntry | null;
  /**
   * Record that a workspace was opened. The new `openedAt` is visible to every
   * reader at once; the file is written after a quiet period, so a read path
   * that calls this never pays for a disk write.
   */
  touchWorkspace(id: string): WorkspaceEntry | null;
  /** Write any pending touch now. */
  flush(): void;
  removeWorkspace(id: string): boolean;
  /** Register every folder under workspacesDir that is not yet known. Returns the new entries. */
  scanLibrary(workspacesDir: string): WorkspaceEntry[];
  listGroups(): string[];
  /** Appearance by folder path; only folders that have one appear. */
  folderMeta(): Record<string, FolderMeta>;
  /** Adds a folder path and every missing ancestor. Idempotent. */
  addGroup(path: string): string[];
  /** Renames `from` to the full path `to`, cascading to its subtree, its member workspaces and its appearance. No-op if `from` is unknown. */
  renameGroup(from: string, to: string): string[];
  /** Re-parents a folder, keeping its own name. `null` moves it to the top level. */
  moveGroup(path: string, newParent: string | null): string[];
  /** Removes the folder and its subtree; members become loose. No-op if unknown. */
  removeGroup(path: string): string[];
  /** Merges icon/color for a folder; an explicit `null` clears that field. */
  setFolderMeta(path: string, patch: FolderMeta): Record<string, FolderMeta>;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** The same per-segment trim/blank-drop cleanup applied to any raw group path, from settings.json or from a workspace's own `group` field. */
const cleanGroups = (raw: unknown[]): string[] =>
  raw
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.split('/').map((s) => s.trim()).filter(Boolean).join('/'))
    .filter((g) => g.length > 0);

function normalise(raw: Partial<Settings>): Settings {
  const b = raw.backup ?? DEFAULT_SETTINGS.backup;
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.filter((w): w is WorkspaceEntry => !!w && typeof w.id === 'string' && typeof w.path === 'string')
    : [];
  const groups = withAncestors([
    ...cleanGroups(Array.isArray(raw.groups) ? raw.groups : []),
    // A group a workspace references must exist, or that workspace would
    // render in no folder at all and silently vanish from the sidebar.
    ...cleanGroups(workspaces.map((w) => w.group)),
  ]);
  const known = new Set(groups);
  const folderMeta: Record<string, FolderMeta> = {};
  for (const [k, v] of Object.entries(raw.folderMeta ?? {})) {
    // Appearance for a folder that no longer exists is dropped, so a hand
    // edit or a crashed rename cannot leave the map growing forever.
    if (!known.has(k) || !v || typeof v !== 'object') continue;
    const meta: FolderMeta = {};
    if (typeof v.icon === 'string' && v.icon) meta.icon = v.icon;
    if (typeof v.color === 'string' && v.color) meta.color = v.color;
    if (meta.icon || meta.color) folderMeta[k] = meta;
  }
  return {
    version: 1,
    workspaces,
    groups,
    folderMeta,
    backup: {
      destinations: Array.isArray(b.destinations) ? b.destinations.filter((d) => d && typeof d.path === 'string' && typeof d.id === 'string') : [],
      snapshotIntervalMin: Number.isFinite(b.snapshotIntervalMin) && b.snapshotIntervalMin >= 1 ? Math.round(b.snapshotIntervalMin) : 60,
      keepSnapshots: Number.isFinite(b.keepSnapshots) && b.keepSnapshots >= 1 ? Math.round(b.keepSnapshots) : 30,
    },
    typstCli: typeof raw.typstCli === 'string' && raw.typstCli ? raw.typstCli : null,
    redaction: {
      style: raw.redaction?.style === 'pixelate' ? 'pixelate' : 'gaussian',
      strength: Number.isFinite(raw.redaction?.strength) ? Math.min(3, Math.max(0.25, raw.redaction!.strength)) : 1,
    },
  };
}

/** How often `get` is allowed to stat the file for an edit made by another process. */
const STAT_EVERY_MS = 1000;
/** Quiet period before a `touchWorkspace` reaches the disk. */
const TOUCH_DELAY_MS = 2000;

export function createSettingsStore(
  dataDir: string,
  opts: { now?: () => number; clock?: () => number; touchDelayMs?: number } = {},
): SettingsStore {
  const now = opts.now ?? (() => Date.now());
  // Wall clock for throttling, separate from `now` so tests can pin timestamps
  // without freezing the stat window.
  const clock = opts.clock ?? (() => Date.now());
  const touchDelayMs = opts.touchDelayMs ?? TOUCH_DELAY_MS;
  const file = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true });

  // The parsed file lives here between calls. Every read used to parse the
  // file again, several times per request; on a Docker bind mount each of
  // those reads costs milliseconds. An edit by another process is still
  // picked up: the file's mtime is checked at most once a second.
  let cache: Settings | null = null;
  let cachedMtime = 0;
  let lastStat = -Infinity;
  const fileMtime = (): number => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

  const get = (): Settings => {
    const t = clock();
    if (cache && t - lastStat < STAT_EVERY_MS) return cache;
    lastStat = t;
    const m = fileMtime();
    if (cache && m === cachedMtime) return cache;
    cache = normalise(readJson<Partial<Settings>>(file, {}));
    cachedMtime = m;
    return cache;
  };
  const write = (s: Settings): Settings => {
    const n = normalise(s);
    writeAtomic(file, JSON.stringify(n, null, 2));
    cache = n;
    cachedMtime = fileMtime();
    lastStat = clock();
    return n;
  };
  const update = (fn: (s: Settings) => Settings): Settings => write(fn(get()));

  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  let touchPending = false;
  const flush = (): void => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (!touchPending) return;
    touchPending = false;
    write(get());
  };

  const store: SettingsStore = {
    get,
    update,
    listWorkspaces: () => get().workspaces,
    getWorkspace: (id) => get().workspaces.find((w) => w.id === id) ?? null,
    findByPath: (p) => get().workspaces.find((w) => samePath(w.path, p)) ?? null,
    addWorkspace(input) {
      const t = now();
      const entry: WorkspaceEntry = { id: crypto.randomUUID(), path: path.resolve(input.path), name: input.name, group: input.group, library: input.library, createdAt: t, openedAt: t };
      update((s) => ({ ...s, workspaces: [...s.workspaces, entry] }));
      return entry;
    },
    patchWorkspace(id, patch) {
      let out: WorkspaceEntry | null = null;
      update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== id) return w;
          out = { ...w, ...patch };
          return out;
        }),
      }));
      return out;
    },
    touchWorkspace(id) {
      const s = get();
      const cur = s.workspaces.find((w) => w.id === id);
      if (!cur) return null;
      const entry: WorkspaceEntry = { ...cur, openedAt: now() };
      cache = { ...s, workspaces: s.workspaces.map((w) => (w.id === id ? entry : w)) };
      touchPending = true;
      if (!touchTimer) {
        touchTimer = setTimeout(() => { touchTimer = null; flush(); }, touchDelayMs);
        (touchTimer as { unref?: () => void }).unref?.();
      }
      return entry;
    },
    flush,
    removeWorkspace(id) {
      let removed = false;
      update((s) => ({ ...s, workspaces: s.workspaces.filter((w) => { if (w.id === id) { removed = true; return false; } return true; }) }));
      return removed;
    },
    scanLibrary(workspacesDir) {
      if (!isDir(workspacesDir)) return [];
      // Self-heal first. A library workspace lives at <workspacesDir>/<name>;
      // when the recorded folder is gone but that path exists, the data
      // folder moved (another machine, a container mount) and the entry
      // should follow it. If another entry already owns the folder, fold the
      // stale one into it, keeping the group the user had set.
      update((s) => {
        const workspaces = [...s.workspaces];
        for (let i = workspaces.length - 1; i >= 0; i--) {
          const w = workspaces[i]!;
          if (!w.library || isDir(w.path)) continue;
          const home = path.resolve(workspacesDir, w.name);
          if (!isDir(home)) continue;
          const ownerIndex = workspaces.findIndex((o) => o !== w && samePath(o.path, home));
          if (ownerIndex === -1) {
            workspaces[i] = { ...w, path: home };
          } else {
            const owner = workspaces[ownerIndex]!;
            if (owner.group === null && w.group !== null) workspaces[ownerIndex] = { ...owner, group: w.group };
            workspaces.splice(i, 1);
          }
        }
        return { ...s, workspaces };
      });
      const known = get().workspaces;
      const added: WorkspaceEntry[] = [];
      for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('restored-')) continue;
        const abs = path.join(workspacesDir, entry.name);
        if (known.some((w) => samePath(w.path, abs))) continue;
        added.push(store.addWorkspace({ path: abs, name: entry.name, group: null, library: true }));
      }
      return added;
    },
    listGroups: () => get().groups,
    folderMeta: () => get().folderMeta,
    addGroup(path) {
      update((s) => (s.groups.includes(path) ? s : { ...s, groups: withAncestors([...s.groups, path]) }));
      return get().groups;
    },
    renameGroup(from, to) {
      update((s) => {
        if (!s.groups.includes(from)) return s;
        const map = renamePath(s.groups, from, to);
        const moved = (g: string | null): string | null => (g && map.get(g)) ?? g;
        const folderMeta: Record<string, FolderMeta> = {};
        for (const [k, v] of Object.entries(s.folderMeta)) folderMeta[map.get(k) ?? k] = v;
        return {
          ...s,
          groups: withAncestors(s.groups.map((g) => map.get(g) ?? g)),
          workspaces: s.workspaces.map((w) => (w.group && map.has(w.group) ? { ...w, group: moved(w.group) } : w)),
          folderMeta,
        };
      });
      return get().groups;
    },
    moveGroup(path, newParent) {
      const name = folderName(path);
      return store.renameGroup(path, newParent ? `${newParent}/${name}` : name);
    },
    removeGroup(path) {
      update((s) => {
        const gone = new Set([path, ...descendantsOf(s.groups, path)]);
        return {
          ...s,
          groups: s.groups.filter((g) => !gone.has(g)),
          workspaces: s.workspaces.map((w) => (w.group && gone.has(w.group) ? { ...w, group: null } : w)),
          folderMeta: Object.fromEntries(Object.entries(s.folderMeta).filter(([k]) => !gone.has(k))),
        };
      });
      return get().groups;
    },
    setFolderMeta(path, patch) {
      update((s) => {
        const next: FolderMeta = { ...s.folderMeta[path] };
        if ('icon' in patch) { if (patch.icon) next.icon = patch.icon; else delete next.icon; }
        if ('color' in patch) { if (patch.color) next.color = patch.color; else delete next.color; }
        const folderMeta = { ...s.folderMeta };
        if (next.icon || next.color) folderMeta[path] = next; else delete folderMeta[path];
        return { ...s, folderMeta };
      });
      return get().folderMeta;
    },
  };
  return store;
}
