import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, TrashEntry, TrashRestoreResult, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceEntry, WorkspaceStatus } from '../src/types';
import type { EventBus } from './events';
import { ensureDir, isDir, safeDirName, stamp, uniqueDirName } from './fsx';
import { HttpError } from './http';
import { MAX_FOLDER_DEPTH, depth, descendantsOf, folderName, isDescendant, joinPath, parentPath, sanitiseSegment } from '../src/lib/folder-tree';
import { nestError } from '../src/lib/workspace-nesting';
import type { FolderMeta } from '../src/types';
import type { SettingsStore } from './settings';
import type { Watcher } from './watcher';
import { openWorkspace, type WorkspaceFs } from './workspace';
import { createWorkspaceIndex, type WorkspaceIndex } from './workspace-index';
import { restoreDocument, restoreFiles, scanTrash, trashDocument, type MoveOps, type TrashItem } from './trash';

export interface ServiceDeps {
  settings: SettingsStore;
  bus: EventBus;
  watcher: Watcher | null;
  dataDir: string;
  workspacesDir: string;
  /** Source of a new workspace's main.typ when none is given. */
  template: string;
  now?: () => number;
  /** The folder index; one is created when not given. */
  index?: WorkspaceIndex;
  /** The moves trash and restore make; only tests replace them (to simulate another drive). */
  trashOps?: Partial<MoveOps>;
}

const MAX_ENTRIES = 5000;

export interface WorkspaceService {
  list(): WorkspaceStatus[];
  entry(id: string): WorkspaceEntry;
  fs(id: string): WorkspaceFs;
  /** Served from the in-memory index. `touch` (default) bumps the entry's openedAt lazily; a prefetch passes false. */
  detail(id: string, opts?: { touch?: boolean }): Promise<WorkspaceDetail>;
  create(input: { name: string; group: string | null; source: string | undefined }): WorkspaceEntry;
  openFolder(absPath: string, name: string | undefined): WorkspaceEntry;
  rename(id: string, name: string): WorkspaceEntry;
  /** Files the document in a folder (null = top level), un-nests it, and moves its nested documents along. */
  setGroup(id: string, group: string | null): WorkspaceEntry;
  /** Nests the document under another (adopting that one's folder), or un-nests it with `null`. Throws 400 for a cycle or a fifth level. */
  setParent(id: string, parent: string | null): WorkspaceEntry;
  /** Merges icon/colour/logo into the document's row appearance; an explicit `null` clears that field. */
  setAppearance(id: string, patch: FolderMeta): WorkspaceEntry;
  remove(id: string): void;
  /** Everything in `data/trash`, newest first. Read-only. */
  listTrash(): TrashEntry[];
  /** Moves one trash item back out (never overwriting) and re-registers a document. Throws 404 for an id not in the trash, 409 when a files item's document is not in the app. */
  restoreFromTrash(id: string): TrashRestoreResult;
  listGroups(): string[];
  folderMeta(): Record<string, FolderMeta>;
  createGroup(name: string, parent: string | null): string[];
  renameGroup(path: string, name: string): string[];
  moveGroup(path: string, parent: string | null): string[];
  deleteGroup(path: string): string[];
  setFolderAppearance(path: string, patch: FolderMeta): Record<string, FolderMeta>;
  /** Register every library folder not yet known and start watching everything that exists. */
  boot(): void;
  // writes: all emit workspace.changed with `origin`
  writeFile(id: string, rel: string, bytes: Uint8Array, origin: string | null): { etag: string };
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
  const index = deps.index ?? createWorkspaceIndex({ now });

  // Every change, whether the server wrote it or the watcher saw it on disk,
  // reaches the bus; that is the one place the index needs to listen.
  bus.subscribe((ev) => {
    if (ev.type !== 'workspace.changed') return;
    const e = settings.getWorkspace(ev.id);
    if (!e) return;
    for (const p of ev.paths) index.touch(e.path, p);
  });

  const entry = (id: string): WorkspaceEntry => {
    const e = settings.getWorkspace(id);
    if (!e) throw new HttpError(404, `workspace not found: ${id}`);
    return e;
  };
  const trashDir = path.join(deps.dataDir, 'trash');
  const liveFs = (id: string): WorkspaceFs => {
    const e = entry(id);
    if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
    return openWorkspace(e.path, { now, trash: { dir: trashDir, name: path.basename(e.path), id } });
  };
  const status = (e: WorkspaceEntry): WorkspaceStatus => ({ ...e, status: isDir(e.path) ? 'ok' : 'missing' });
  const registryChanged = () => bus.emit({ type: 'workspaces.changed' });
  const changed = (id: string, paths: string[], origin: string | null) => {
    for (const p of paths) watcher?.markOwnWrite(id, p);
    watcher?.markOwnWrite(id, 'workspace.json');
    bus.emit({ type: 'workspace.changed', id, paths, origin });
  };

  /**
   * An asset/folder rename, move or delete that also rewrote `.typ` sources.
   *
   * It announces two things, and they need different origins:
   *
   * - `meta` (the asset ids, the `assets/<rel>` folder paths) keeps `origin`.
   *   Only the asset/folder list listens for those, and it refreshes without
   *   looking at the origin at all, so this half behaves exactly as before.
   * - `files` (the `.typ` sources the server rewrote) goes out as `origin: null`.
   *   An open editor ignores `workspace.changed` events carrying its own client
   *   id -- that filter is what stops its autosave writes echoing back as
   *   external changes -- so attributing the server's own reference rewrite to
   *   the tab that asked for the move would leave that tab's buffer holding the
   *   pre-rewrite path, break its preview, and let its next autosave put the
   *   stale path straight back over the rewrite. Nobody typed those bytes, so
   *   the rewrite belongs to no client and every tab treats it as external.
   *
   * Order matters: a client keeps a single "last change" slot, so the rewrite
   * goes out last and is the notice an editor is guaranteed to act on. Own-write
   * marks for both sets land before either emit, so the watcher never races the
   * fs echo of a path it has not been told about yet.
   */
  const rewrote = (id: string, meta: string[], files: string[], origin: string | null) => {
    for (const p of files) watcher?.markOwnWrite(id, p);
    changed(id, [...new Set(meta)], origin);
    if (files.length) bus.emit({ type: 'workspace.changed', id, paths: [...new Set(files)], origin: null });
  };

  const NO_HOME = "its document isn't in the app; restore the document first";
  /** The live workspace a files item belongs to: the id written when it was deleted, else the one whose folder name matches. */
  const trashHome = (item: TrashItem): WorkspaceEntry | null => {
    const byId = item.record?.kind === 'files' && item.record.workspaceId ? settings.getWorkspace(item.record.workspaceId) : null;
    if (byId && isDir(byId.path)) return byId;
    return settings.listWorkspaces().find((w) => safeDirName(path.basename(w.path)) === item.name && isDir(w.path)) ?? null;
  };

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
    async detail(id, opts) {
      const e = entry(id);
      if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
      const snap = await index.get(e.path);
      const patched = (opts?.touch ?? true) ? settings.touchWorkspace(id) ?? e : e;
      return { entry: patched, files: snap.files, meta: snap.meta, assets: snap.assets, folders: snap.folders, etag: snap.etag };
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
      // R9: an already-registered path always returns its entry; the entry walk below
      // guards new registrations only, so a known workspace is never blocked by it.
      const existing = settings.findByPath(p);
      if (existing) return existing;
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
      const inLibrary = p.startsWith(path.resolve(deps.workspacesDir) + path.sep);
      return register({ path: p, name: name?.trim() || path.basename(p), group: null, library: inLibrary });
    },
    rename(id, name) {
      const e = entry(id);
      const clean = name.trim();
      if (!clean) throw new HttpError(400, 'name cannot be empty');
      let newPath = e.path;
      // R10: a no-op rename (or a case-only change on Windows) must not move the
      // folder -- uniqueDirName would otherwise see the folder itself as a
      // collision and rename it to "<name> (2)". Only the display name changes.
      if (e.library && isDir(e.path) && safeDirName(clean).toLowerCase() !== path.basename(e.path).toLowerCase()) {
        const parent = path.dirname(e.path);
        const target = path.join(parent, uniqueDirName(parent, safeDirName(clean)));
        if (target !== e.path) {
          watcher?.unwatch(id);
          index.invalidate(e.path);
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
      // Filing a document in a folder takes it out of any nesting, and its nested documents go with it.
      const out = settings.moveWorkspace(id, group, null)!;
      registryChanged();
      return out;
    },
    setParent(id, parent) {
      const e = entry(id);
      if (parent === null) {
        if (!e.parent) return e;
        const out = settings.moveWorkspace(id, e.group, null)!;
        registryChanged();
        return out;
      }
      const p = settings.getWorkspace(parent);
      if (!p) throw new HttpError(404, `workspace not found: ${parent}`);
      if (e.parent === parent) return e;
      const problem = nestError(settings.listWorkspaces(), id, parent);
      if (problem) throw new HttpError(400, problem);
      // A child always lives in its parent's folder.
      const out = settings.moveWorkspace(id, p.group, parent)!;
      registryChanged();
      return out;
    },
    setAppearance(id, patch) {
      entry(id);
      const out = settings.setWorkspaceAppearance(id, patch)!;
      registryChanged();
      return out;
    },
    listGroups: () => settings.listGroups(),
    folderMeta: () => settings.folderMeta(),
    createGroup(name, parent) {
      const target = joinPath(parent, name);
      if (!sanitiseSegment(name)) throw new HttpError(400, 'folder name cannot be empty');
      if (depth(target) > MAX_FOLDER_DEPTH) throw new HttpError(400, `folders nest at most ${MAX_FOLDER_DEPTH} levels deep`);
      if (settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${sanitiseSegment(name)}" already exists here`);
      const out = settings.addGroup(target);
      registryChanged();
      return out;
    },
    renameGroup(path, name) {
      const clean = sanitiseSegment(name);
      if (!clean) throw new HttpError(400, 'folder name cannot be empty');
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      const target = joinPath(parentPath(path), clean);
      if (target !== path && settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${clean}" already exists here`);
      const out = settings.renameGroup(path, target);
      registryChanged();
      return out;
    },
    moveGroup(path, parent) {
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      if (parent !== null && !settings.listGroups().includes(parent)) throw new HttpError(404, `no folder at "${parent}"`);
      if (parent !== null && isDescendant(parent, path)) throw new HttpError(400, 'a folder cannot move inside itself');
      const target = joinPath(parent, folderName(path));
      if (target === path) return settings.listGroups();
      if (settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${folderName(path)}" already exists there`);
      // The subtree travels with it, so the deepest descendant sets the limit.
      const deepest = Math.max(...[path, ...descendantsOf(settings.listGroups(), path)].map(depth));
      if (deepest - depth(path) + depth(target) > MAX_FOLDER_DEPTH) throw new HttpError(400, `folders nest at most ${MAX_FOLDER_DEPTH} levels deep`);
      const out = settings.moveGroup(path, parent);
      registryChanged();
      return out;
    },
    deleteGroup(path) {
      const out = settings.removeGroup(path);
      registryChanged();
      return out;
    },
    setFolderAppearance(path, patch) {
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      const out = settings.setFolderMeta(path, patch);
      registryChanged();
      return out;
    },
    remove(id) {
      const e = entry(id);
      watcher?.unwatch(id);
      index.invalidate(e.path);
      if (e.library && isDir(e.path)) {
        trashDocument(trashDir, stamp(now()), e.path, {
          kind: 'document',
          name: path.basename(e.path),
          originalPath: e.path,
          deletedAt: now(),
          entry: { id: e.id, name: e.name, group: e.group, ...(e.parent ? { parent: e.parent } : {}), ...(e.appearance ? { appearance: e.appearance } : {}), library: e.library },
        }, deps.trashOps);
      }
      settings.removeWorkspace(id);
      registryChanged();
    },
    listTrash() {
      return scanTrash(trashDir).map((item): TrashEntry => {
        if (item.kind === 'document') {
          return { id: item.id, kind: 'document', name: item.record?.kind === 'document' ? item.record.entry.name : item.name, workspace: null, deletedAt: item.deletedAt, size: item.size, fileCount: item.fileCount, canRestore: true, reason: null };
        }
        const home = trashHome(item);
        return {
          id: item.id,
          kind: 'files',
          name: item.files.length === 1 ? item.files[0]!.original : `${item.files.length} files`,
          workspace: home?.name ?? item.name,
          deletedAt: item.deletedAt,
          size: item.size,
          fileCount: item.fileCount,
          canRestore: !!home,
          reason: home ? null : NO_HOME,
        };
      });
    },
    restoreFromTrash(id) {
      const item = scanTrash(trashDir).find((i) => i.id === id);
      if (!item) throw new HttpError(404, 'that item is not in the trash');
      if (item.kind === 'files') {
        const home = trashHome(item);
        if (!home) throw new HttpError(409, NO_HOME);
        const moved = restoreFiles(trashDir, item, home.path, deps.trashOps);
        // Put back the crop, blur and font family the asset had, under the name it came back with.
        const withMeta = moved.filter((m) => m.meta);
        if (withMeta.length) {
          const ws = liveFs(home.id);
          const meta = ws.readMeta();
          for (const m of withMeta) (m.meta!.kind === 'fonts' ? meta.fonts : meta.assets)[m.to] = m.meta!.record as never;
          ws.writeMeta(meta);
        }
        changed(home.id, moved.map((m) => m.to), null);
        const renamed = moved.some((m) => m.renamed);
        const message = moved.length === 1 && renamed
          ? `Restored as '${moved[0]!.to}'`
          : `Restored ${moved.length === 1 ? moved[0]!.to : `${moved.length} files`} to ${home.name}${renamed ? ` (${moved.filter((m) => m.renamed).length} under a "(restored)" name)` : ''}`;
        return { id, kind: 'files', location: home.name, renamed, message, workspaceId: home.id };
      }
      const rec = item.record?.kind === 'document' ? item.record.entry : null;
      const back = restoreDocument(trashDir, item, deps.workspacesDir, deps.trashOps);
      const name = (rec?.name ?? back.folderName.slice(0, back.folderName.length - back.suffix.length)) + back.suffix;
      const e = settings.findByPath(back.dir) ?? settings.addWorkspace({ path: back.dir, name, group: rec?.group ?? null, library: true });
      if (rec?.group) settings.addGroup(rec.group);
      if (rec?.appearance) settings.setWorkspaceAppearance(e.id, rec.appearance);
      const parent = rec?.parent ? settings.getWorkspace(rec.parent) : null;
      if (parent && parent.id !== e.id && !nestError(settings.listWorkspaces(), e.id, parent.id)) settings.moveWorkspace(e.id, parent.group, parent.id);
      watcher?.watch(e.id, e.path);
      registryChanged();
      const final = settings.getWorkspace(e.id) ?? e;
      const location = final.group ? `${final.group}/${final.name}` : final.name;
      const renamed = back.suffix !== '';
      return { id, kind: 'document', location, renamed, message: renamed ? `Restored as '${final.name}'` : `Restored to ${location}`, workspaceId: final.id };
    },
    boot() {
      ensureDir(deps.workspacesDir);
      settings.scanLibrary(deps.workspacesDir);
      for (const e of settings.listWorkspaces()) {
        if (!isDir(e.path)) continue;
        watcher?.watch(e.id, e.path);
        // Warm the index so the first click after a start is as fast as the rest.
        void index.get(e.path).catch(() => { /* the request path reports it */ });
      }
    },
    writeFile(id, rel, bytes, origin) {
      const ws = liveFs(id);
      const f = ws.writeFile(rel, bytes);
      changed(id, [f.path], origin);
      return { etag: `${f.mtime}-${f.size}` };
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
      rewrote(id, [assetId, r.asset.id], r.files, origin);
      return r;
    },
    moveAsset(id, assetId, folder, origin) {
      const ws = liveFs(id);
      const r = ws.moveAsset(assetId, folder);
      rewrote(id, [assetId, r.asset.id], r.files, origin);
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
      rewrote(id, [`assets/${rel}`, `assets/${newRel}`], r.files, origin);
      return r;
    },
    deleteFolder(id, rel, origin) {
      const ws = liveFs(id);
      const r = ws.deleteFolder(rel);
      rewrote(id, [`assets/${rel}`], r.files, origin);
      return r;
    },
  };
}
