import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { descendantsOf, folderName, renamePath, withAncestors } from '../src/lib/folder-tree';
import { isLogoName } from '../src/lib/logo';
import { subtreeIds } from '../src/lib/workspace-nesting';
import type { FolderMeta, Settings, WorkspaceEntry } from '../src/types';
import { isDir, stamp, writeAtomic } from './fsx';

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
  /** Removes the entry. Its nested documents move up to its own parent (or the top of its folder) in the same write. */
  removeWorkspace(id: string): boolean;
  /**
   * Files a document: sets its folder and its parent (`null` = not nested).
   * Its whole subtree takes the same folder, in one registry write.
   */
  moveWorkspace(id: string, group: string | null, parent: string | null): WorkspaceEntry | null;
  /** Merges icon/color/logo for a document's row; an explicit `null` clears that field. */
  setWorkspaceAppearance(id: string, patch: FolderMeta): WorkspaceEntry | null;
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

/** The valid part of a stored appearance, or null when nothing in it is usable. A logo is only kept under a safe file name. */
function cleanMeta(v: unknown): FolderMeta | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as FolderMeta;
  const meta: FolderMeta = {};
  if (typeof o.icon === 'string' && o.icon) meta.icon = o.icon;
  if (typeof o.color === 'string' && o.color) meta.color = o.color;
  if (isLogoName(o.logo)) meta.logo = o.logo;
  return meta.icon || meta.color || meta.logo ? meta : null;
}

/** `cur` with `patch` applied (a `null` clears a field); null when nothing is left. */
function mergeMeta(cur: FolderMeta | undefined, patch: FolderMeta): FolderMeta | null {
  const next: FolderMeta = { ...cur };
  for (const key of ['icon', 'color', 'logo'] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v) next[key] = v; else delete next[key];
  }
  return next.icon || next.color || next.logo ? next : null;
}

/** The entry with `parent` set, or without the key at all when it is null, so un-nested entries stay as they were before nesting existed. */
function withParent(w: WorkspaceEntry, parent: string | null): WorkspaceEntry {
  const { parent: _drop, ...rest } = w;
  void _drop;
  return parent ? { ...rest, parent } : rest;
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
  const loaded = Array.isArray(raw.workspaces)
    ? raw.workspaces.filter((w): w is WorkspaceEntry => !!w && typeof w.id === 'string' && typeof w.path === 'string')
    : [];
  // Nesting. A parent must name another entry and must not lead back to the
  // entry itself; a cycle is cut at the link that would close it.
  const ids = new Set(loaded.map((w) => w.id));
  const parentOf = new Map<string, string>();
  for (const w of loaded) {
    const p: unknown = w.parent;
    if (typeof p !== 'string' || p === w.id || !ids.has(p)) continue;
    let cur: string | undefined = p;
    while (cur && cur !== w.id) cur = parentOf.get(cur);
    if (!cur) parentOf.set(w.id, p);
  }
  const byId = new Map(loaded.map((w) => [w.id, w]));
  const rootOf = (id: string): string => { let cur = id; for (let p = parentOf.get(cur); p; p = parentOf.get(cur)) cur = p; return cur; };
  const workspaces = loaded.map((w): WorkspaceEntry => {
    const { parent: _p, appearance: _a, ...rest } = w;
    void _p; void _a;
    const out: WorkspaceEntry = { ...rest };
    const parent = parentOf.get(w.id);
    // A child lives in its parent's folder, so the backup mirror tree (which follows `group`) stays coherent.
    if (parent) { out.parent = parent; out.group = byId.get(rootOf(w.id))!.group; }
    const appearance = cleanMeta(w.appearance);
    if (appearance) out.appearance = appearance;
    return out;
  });
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
    const meta = cleanMeta(v);
    if (meta) folderMeta[k] = meta;
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

/** Whether a stored registry holds at least one workspace, folder or backup destination. */
function holdsAnything(r: Partial<Settings>): boolean {
  return (Array.isArray(r.workspaces) && r.workspaces.length > 0)
    || (Array.isArray(r.groups) && r.groups.length > 0)
    || (Array.isArray(r.backup?.destinations) && r.backup!.destinations.length > 0);
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

  const parsesAsObject = (p: string): Partial<Settings> | null => {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
      return v && typeof v === 'object' ? (v as Partial<Settings>) : null;
    } catch { return null; }
  };
  // A missing file is a fresh install. An unreadable one is kept aside, then
  // the rolling backup is tried, so a bad edit never turns into an empty write.
  const load = (): Partial<Settings> => {
    if (!fs.existsSync(file)) return {};
    const good = parsesAsObject(file);
    if (good) return good;
    const kept = `${file}.corrupt-${stamp()}`;
    try { fs.copyFileSync(file, kept); } catch (err) { console.warn(`settings.json is unreadable and could not be copied aside: ${err instanceof Error ? err.message : err}`); }
    const bak = parsesAsObject(`${file}.bak`);
    console.warn(`settings.json is unreadable; kept a copy at ${kept}. ${bak ? 'Recovered the registry from settings.json.bak.' : 'No usable settings.json.bak, starting with an empty registry.'}`);
    return bak ?? {};
  };

  const get = (): Settings => {
    const t = clock();
    if (cache && t - lastStat < STAT_EVERY_MS) return cache;
    lastStat = t;
    const m = fileMtime();
    if (cache && m === cachedMtime) return cache;
    cache = normalise(load());
    cachedMtime = m;
    return cache;
  };
  const write = (s: Settings): Settings => {
    const n = normalise(s);
    // One rolling backup, only of a file that still parses, so a corrupt file never replaces it.
    // An empty registry (no documents, folders or destinations) is not worth
    // keeping over a good copy; it only becomes the .bak when there is none yet.
    const current = parsesAsObject(file);
    if (current && (holdsAnything(current) || !fs.existsSync(`${file}.bak`))) { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ } }
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
      update((s) => {
        const up = s.workspaces.find((w) => w.id === id)?.parent ?? null;
        return {
          ...s,
          workspaces: s.workspaces
            .filter((w) => { if (w.id === id) { removed = true; return false; } return true; })
            .map((w) => (w.parent === id ? withParent(w, up) : w)),
        };
      });
      return removed;
    },
    moveWorkspace(id, group, parent) {
      let out: WorkspaceEntry | null = null;
      update((s) => {
        if (!s.workspaces.some((w) => w.id === id)) return s;
        const g = group?.trim() || null;
        const sub = new Set(subtreeIds(s.workspaces, id));
        return {
          ...s,
          workspaces: s.workspaces.map((w) => {
            if (w.id === id) { out = withParent({ ...w, group: g }, parent); return out; }
            return sub.has(w.id) ? { ...w, group: g } : w;
          }),
        };
      });
      return out ? (get().workspaces.find((w) => w.id === id) ?? out) : null;
    },
    setWorkspaceAppearance(id, patch) {
      let found = false;
      update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== id) return w;
          found = true;
          const { appearance: _a, ...rest } = w;
          void _a;
          const next = mergeMeta(w.appearance, patch);
          return next ? { ...rest, appearance: next } : rest;
        }),
      }));
      return found ? (get().workspaces.find((w) => w.id === id) ?? null) : null;
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
            let merged: WorkspaceEntry = owner;
            if (owner.group === null && w.group !== null) merged = { ...merged, group: w.group };
            if (!owner.appearance && w.appearance) merged = { ...merged, appearance: w.appearance };
            // Nesting follows the owner too. A parent that points at the owner itself is dropped; normalise's cycle cut covers longer loops.
            if (!owner.parent && w.parent && w.parent !== owner.id) merged = { ...merged, parent: w.parent };
            workspaces[ownerIndex] = merged;
            workspaces.splice(i, 1);
            for (let k = 0; k < workspaces.length; k++) {
              if (workspaces[k]!.parent === w.id) workspaces[k] = { ...workspaces[k]!, parent: owner.id };
            }
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
        const next = mergeMeta(s.folderMeta[path], patch);
        const folderMeta = { ...s.folderMeta };
        if (next) folderMeta[path] = next; else delete folderMeta[path];
        return { ...s, folderMeta };
      });
      return get().folderMeta;
    },
  };
  return store;
}
