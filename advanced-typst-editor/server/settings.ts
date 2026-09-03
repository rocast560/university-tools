import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings, WorkspaceEntry } from '../src/types';
import { isDir, readJson, writeAtomic } from './fsx';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  workspaces: [],
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
  removeWorkspace(id: string): boolean;
  /** Register every folder under workspacesDir that is not yet known. Returns the new entries. */
  scanLibrary(workspacesDir: string): WorkspaceEntry[];
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function normalise(raw: Partial<Settings>): Settings {
  const b = raw.backup ?? DEFAULT_SETTINGS.backup;
  return {
    version: 1,
    workspaces: Array.isArray(raw.workspaces)
      ? raw.workspaces.filter((w): w is WorkspaceEntry => !!w && typeof w.id === 'string' && typeof w.path === 'string')
      : [],
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

export function createSettingsStore(dataDir: string, opts: { now?: () => number } = {}): SettingsStore {
  const now = opts.now ?? (() => Date.now());
  const file = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const get = (): Settings => normalise(readJson<Partial<Settings>>(file, {}));
  const write = (s: Settings): Settings => { const n = normalise(s); writeAtomic(file, JSON.stringify(n, null, 2)); return n; };
  const update = (fn: (s: Settings) => Settings): Settings => write(fn(get()));

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
    removeWorkspace(id) {
      let removed = false;
      update((s) => ({ ...s, workspaces: s.workspaces.filter((w) => { if (w.id === id) { removed = true; return false; } return true; }) }));
      return removed;
    },
    scanLibrary(workspacesDir) {
      if (!isDir(workspacesDir)) return [];
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
  };
  return store;
}
