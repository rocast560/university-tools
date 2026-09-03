import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceEntry, WorkspaceStatus } from '../src/types';
import type { EventBus } from './events';
import { ensureDir, isDir, safeDirName, stamp, uniqueDirName } from './fsx';
import { HttpError } from './http';
import type { SettingsStore } from './settings';
import type { Watcher } from './watcher';
import { openWorkspace, type WorkspaceFs } from './workspace';

export interface ServiceDeps {
  settings: SettingsStore;
  bus: EventBus;
  watcher: Watcher | null;
  dataDir: string;
  workspacesDir: string;
  /** Source of a new workspace's main.typ when none is given. */
  template: string;
  now?: () => number;
}

const MAX_ENTRIES = 5000;

export interface WorkspaceService {
  list(): WorkspaceStatus[];
  entry(id: string): WorkspaceEntry;
  fs(id: string): WorkspaceFs;
  detail(id: string): WorkspaceDetail;
  create(input: { name: string; group: string | null; source: string | undefined }): WorkspaceEntry;
  openFolder(absPath: string, name: string | undefined): WorkspaceEntry;
  rename(id: string, name: string): WorkspaceEntry;
  setGroup(id: string, group: string | null): WorkspaceEntry;
  remove(id: string): void;
  /** Register every library folder not yet known and start watching everything that exists. */
  boot(): void;
  // writes: all emit workspace.changed with `origin`
  writeFile(id: string, rel: string, bytes: Uint8Array, origin: string | null): void;
  deleteFile(id: string, rel: string, origin: string | null): boolean;
  addAsset(id: string, input: { kind: TypstAssetKind; filename: string; bytes: Uint8Array; folder: string | null; family?: string | null }, origin: string | null): TypstAsset;
  patchAsset(id: string, assetId: string, patch: Record<string, unknown>, origin: string | null): TypstAsset;
  renameAsset(id: string, assetId: string, stem: string, origin: string | null): { asset: TypstAsset; references: number };
  moveAsset(id: string, assetId: string, folder: string | null, origin: string | null): { asset: TypstAsset; references: number };
  deleteAsset(id: string, assetId: string, origin: string | null): void;
  createFolder(id: string, rel: string, origin: string | null): AssetFolder;
  renameFolder(id: string, rel: string, newRel: string, origin: string | null): { references: number };
  deleteFolder(id: string, rel: string, origin: string | null): { references: number; moved: number };
}

export function createWorkspaceService(deps: ServiceDeps): WorkspaceService {
  const now = deps.now ?? (() => Date.now());
  const { settings, bus, watcher } = deps;

  const entry = (id: string): WorkspaceEntry => {
    const e = settings.getWorkspace(id);
    if (!e) throw new HttpError(404, `workspace not found: ${id}`);
    return e;
  };
  const liveFs = (id: string): WorkspaceFs => {
    const e = entry(id);
    if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
    return openWorkspace(e.path, { now });
  };
  const status = (e: WorkspaceEntry): WorkspaceStatus => ({ ...e, status: isDir(e.path) ? 'ok' : 'missing' });
  const registryChanged = () => bus.emit({ type: 'workspaces.changed' });
  const changed = (id: string, paths: string[], origin: string | null) => {
    for (const p of paths) watcher?.markOwnWrite(id, p);
    watcher?.markOwnWrite(id, 'workspace.json');
    bus.emit({ type: 'workspace.changed', id, paths, origin });
  };
  /** Paths whose bytes changed because of a rename/move: the .typ files plus the two asset paths. */
  const touched = (ws: WorkspaceFs, extra: string[]): string[] => [...new Set([...ws.typFiles(), ...extra])];

  const register = (input: { path: string; name: string; group: string | null; library: boolean }): WorkspaceEntry => {
    const e = settings.addWorkspace(input);
    watcher?.watch(e.id, e.path);
    registryChanged();
    return e;
  };

  return {
    list: () => settings.listWorkspaces().map(status),
    entry,
    fs: liveFs,
    detail(id) {
      const e = entry(id);
      if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
      const ws = openWorkspace(e.path, { now });
      settings.patchWorkspace(id, { openedAt: now() });
      return { entry: e, files: ws.listFiles(), meta: ws.readMeta(), assets: ws.listAssets(), folders: ws.listFolders() };
    },
    create({ name, group, source }) {
      const clean = name.trim() || 'Untitled report';
      ensureDir(deps.workspacesDir);
      const dir = path.join(deps.workspacesDir, uniqueDirName(deps.workspacesDir, safeDirName(clean)));
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, 'main.typ'), source ?? deps.template);
      return register({ path: dir, name: clean, group: group?.trim() || null, library: true });
    },
    openFolder(absPath, name) {
      const p = path.resolve(absPath);
      if (!isDir(p)) throw new HttpError(400, `not a folder: ${absPath}`);
      if (path.parse(p).root === p) throw new HttpError(400, 'a drive root cannot be a workspace');
      const rd = path.resolve(deps.dataDir);
      if (p === rd || rd.startsWith(p + path.sep)) throw new HttpError(400, 'the app data folder cannot be a workspace');
      let count = 0;
      const stack = [p];
      while (stack.length && count <= MAX_ENTRIES) {
        const d = stack.pop()!;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          count += 1;
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push(path.join(d, e.name));
          if (count > MAX_ENTRIES) break;
        }
      }
      if (count > MAX_ENTRIES) throw new HttpError(400, `that folder holds more than ${MAX_ENTRIES} entries; pick the report's own folder`);
      const existing = settings.findByPath(p);
      if (existing) return existing;
      const inLibrary = p.startsWith(path.resolve(deps.workspacesDir) + path.sep);
      return register({ path: p, name: name?.trim() || path.basename(p), group: null, library: inLibrary });
    },
    rename(id, name) {
      const e = entry(id);
      const clean = name.trim();
      if (!clean) throw new HttpError(400, 'name cannot be empty');
      let newPath = e.path;
      if (e.library && isDir(e.path)) {
        const parent = path.dirname(e.path);
        const target = path.join(parent, uniqueDirName(parent, safeDirName(clean)));
        if (target !== e.path) {
          watcher?.unwatch(id);
          fs.renameSync(e.path, target);
          newPath = target;
          watcher?.watch(id, target);
        }
      }
      const out = settings.patchWorkspace(id, { name: clean, path: newPath })!;
      registryChanged();
      return out;
    },
    setGroup(id, group) {
      entry(id);
      const out = settings.patchWorkspace(id, { group: group?.trim() || null })!;
      registryChanged();
      return out;
    },
    remove(id) {
      const e = entry(id);
      watcher?.unwatch(id);
      if (e.library && isDir(e.path)) {
        const trash = path.join(deps.dataDir, 'trash', stamp(now()));
        ensureDir(trash);
        fs.renameSync(e.path, path.join(trash, path.basename(e.path)));
      }
      settings.removeWorkspace(id);
      registryChanged();
    },
    boot() {
      ensureDir(deps.workspacesDir);
      settings.scanLibrary(deps.workspacesDir);
      for (const e of settings.listWorkspaces()) if (isDir(e.path)) watcher?.watch(e.id, e.path);
    },
    writeFile(id, rel, bytes, origin) {
      const ws = liveFs(id);
      const f = ws.writeFile(rel, bytes);
      changed(id, [f.path], origin);
    },
    deleteFile(id, rel, origin) {
      const ws = liveFs(id);
      const ok = ws.deleteFile(rel);
      if (ok) changed(id, [rel], origin);
      return ok;
    },
    addAsset(id, input, origin) {
      const a = liveFs(id).addAsset(input);
      changed(id, [a.id], origin);
      return a;
    },
    patchAsset(id, assetId, patch, origin) {
      const a = liveFs(id).patchAsset(assetId, patch);
      changed(id, ['workspace.json'], origin);
      return a;
    },
    renameAsset(id, assetId, stem, origin) {
      const ws = liveFs(id);
      const r = ws.renameAsset(assetId, stem);
      changed(id, touched(ws, [assetId, r.asset.id]), origin);
      return r;
    },
    moveAsset(id, assetId, folder, origin) {
      const ws = liveFs(id);
      const r = ws.moveAsset(assetId, folder);
      changed(id, touched(ws, [assetId, r.asset.id]), origin);
      return r;
    },
    deleteAsset(id, assetId, origin) {
      liveFs(id).deleteAsset(assetId);
      changed(id, [assetId], origin);
    },
    createFolder(id, rel, origin) {
      const f = liveFs(id).createFolder(rel);
      changed(id, [`assets/${f.id}`], origin);
      return f;
    },
    renameFolder(id, rel, newRel, origin) {
      const ws = liveFs(id);
      const r = ws.renameFolder(rel, newRel);
      changed(id, touched(ws, [`assets/${rel}`, `assets/${newRel}`]), origin);
      return r;
    },
    deleteFolder(id, rel, origin) {
      const ws = liveFs(id);
      const r = ws.deleteFolder(rel);
      changed(id, touched(ws, [`assets/${rel}`]), origin);
      return r;
    },
  };
}
