import { create } from 'zustand';
import { api } from '@/api/client';
import { folderPathFor, movedFolderPath, renamedFolderPath } from '@/lib/folder-paths';
import { switchTrace } from '@/lib/perf';
import { forgetWorkspaceLocks, loadPreviewLock, savePreviewLock, setAllLocked as lockAll, toggleWorkspaceLock as toggleLock, type PreviewLock } from '@/lib/preview-lock';
import { detailCache, forgetWorkspace, mergeDetail } from '@/lib/workspace-cache';
import type { AssetFolder, BackupState, BlurRegion, CropRect, FolderMeta, ID, McpStatus, RedactionDefaults, ServerEvent, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceStatus } from '@/types';

export interface ChangeNotice { id: ID; paths: string[]; origin: string | null; seq: number }

export interface AppState {
  workspaces: WorkspaceStatus[];
  groups: string[];
  folderMeta: Record<string, FolderMeta>;
  activeWorkspaceId: ID | null;
  detail: WorkspaceDetail | null;
  typstAssets: TypstAsset[];
  assetFolders: AssetFolder[];
  redaction: RedactionDefaults;
  typstCli: string | null;
  backup: BackupState | null;
  mcp: McpStatus | null;
  online: boolean;
  lastChange: ChangeNotice | null;
  settingsOpen: boolean;
  /** Which documents ignore preview clicks (see lib/preview-lock); per browser. */
  previewLock: PreviewLock;

  loadWorkspaces(): Promise<void>;
  selectWorkspace(id: ID | null): Promise<void>;
  createWorkspace(name: string, group?: string | null): Promise<WorkspaceStatus | null>;
  openFolder(path: string): Promise<void>;
  renameWorkspace(id: ID, name: string): Promise<void>;
  /** File in a folder (null = top level). Also un-nests, and nested documents move with it. */
  setWorkspaceGroup(id: ID, group: string | null): Promise<void>;
  /** Nest under another document, or un-nest with null. */
  setWorkspaceParent(id: ID, parent: ID | null): Promise<void>;
  setWorkspaceAppearance(id: ID, patch: FolderMeta): Promise<void>;
  /** Upload an image for use as a logo; resolves to its stored file name. */
  uploadLogo(file: File): Promise<string>;
  removeWorkspace(id: ID): Promise<void>;
  /** Delete many; never throws for a single failure, reports it in `failed`. */
  removeWorkspaces(ids: ID[]): Promise<{ removed: ID[]; failed: Array<{ id: ID; message: string }> }>;
  loadGroups(): Promise<void>;
  createGroup(name: string, parent?: string | null): Promise<void>;
  renameGroup(path: string, name: string): Promise<void>;
  moveGroup(path: string, parent: string | null): Promise<void>;
  deleteGroup(path: string): Promise<void>;
  setFolderAppearance(path: string, patch: FolderMeta): Promise<void>;

  // BTCT-compatible asset slice
  loadTypstAssets(): Promise<void>;
  addTypstAsset(file: File, kind: TypstAssetKind, folderId?: ID | null): Promise<TypstAsset>;
  /** Moves the file and rewrites every reference on disk; returns the asset's new id. */
  moveTypstAssetToFolder(assetId: ID, folderId: ID | null): Promise<ID>;
  createAssetFolder(name: string, parentId?: ID | null): Promise<AssetFolder>;
  renameAssetFolder(id: ID, name: string): Promise<void>;
  moveAssetFolder(id: ID, parentId: ID | null): Promise<void>;
  deleteAssetFolder(id: ID): Promise<void>;
  setTypstAssetCrop(id: ID, crop: CropRect | null, blurs?: BlurRegion[] | null): Promise<void>;
  renameTypstAsset(id: ID, stem: string): Promise<string>;
  deleteTypstAsset(id: ID): Promise<void>;

  loadSettings(): Promise<void>;
  saveSettings(patch: { typstCli?: string | null; redaction?: Partial<RedactionDefaults> }): Promise<void>;
  loadBackup(): Promise<void>;
  loadMcp(): Promise<void>;
  setSettingsOpen(open: boolean): void;
  toggleWorkspaceLock(id: ID): void;
  setAllLocked(locked: boolean): void;
  handleEvent(ev: ServerEvent): void;
  setOnline(online: boolean): void;
}

let seq = 0;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState>((set, get) => {
  const applyDetail = (detail: WorkspaceDetail) => {
    if (get().detail === detail) return;
    set({ detail, typstAssets: detail.assets, assetFolders: detail.folders });
  };
  /**
   * Fetch the active workspace's detail, conditionally: the server answers
   * 304 when the cached copy is still current. The result is merged into the
   * cached one so unchanged records keep their identity. A response that
   * lands after the user moved on updates the cache but not the screen.
   */
  const reloadDetail = async () => {
    const id = get().activeWorkspaceId;
    if (!id) return;
    const cached = detailCache.get(id);
    let fresh: WorkspaceDetail | null;
    try { fresh = await api.getWorkspace(id, cached?.etag ?? null); } catch { return; /* missing: the sidebar shows it */ }
    const merged = fresh ? mergeDetail(cached, fresh) : cached;
    if (!merged) return;
    detailCache.set(id, merged);
    if (get().activeWorkspaceId !== id) return;
    applyDetail(merged);
    switchTrace.mark('detail');
  };
  return {
    workspaces: [], groups: [], folderMeta: {}, activeWorkspaceId: null, detail: null, typstAssets: [], assetFolders: [],
    redaction: { style: 'gaussian', strength: 1 }, typstCli: null, backup: null, mcp: null, online: false, lastChange: null, settingsOpen: false, previewLock: loadPreviewLock(),

    async loadWorkspaces() { set({ workspaces: await api.listWorkspaces() }); },
    async selectWorkspace(id) {
      switchTrace.start(id ?? 'none');
      // A workspace seen before is on screen at once; the server is only
      // asked whether anything changed.
      const cached = id ? detailCache.get(id) : undefined;
      set({ activeWorkspaceId: id, detail: cached ?? null, typstAssets: cached?.assets ?? [], assetFolders: cached?.folders ?? [] });
      if (cached) switchTrace.mark('detail');
      try { localStorage.setItem('tfs-active-workspace', id ?? ''); } catch { /* ignore */ }
      if (id) await reloadDetail();
    },
    async createWorkspace(name, group) {
      const w = await api.createWorkspace({ name, group: group ?? null });
      await get().loadWorkspaces();
      await get().selectWorkspace(w.id);
      return get().workspaces.find((x) => x.id === w.id) ?? null;
    },
    async openFolder(path) { const w = await api.openFolder(path); await get().loadWorkspaces(); await get().selectWorkspace(w.id); },
    async renameWorkspace(id, name) { await api.patchWorkspace(id, { name }); detailCache.delete(id); await get().loadWorkspaces(); if (get().activeWorkspaceId === id) await reloadDetail(); },
    // Filing in a folder also un-nests and carries the document's nested ones along (the server does both).
    async setWorkspaceGroup(id, group) { await api.patchWorkspace(id, { group }); detailCache.clear(); await get().loadWorkspaces(); },
    async setWorkspaceParent(id, parent) { await api.patchWorkspace(id, { parent }); detailCache.clear(); await get().loadWorkspaces(); },
    async setWorkspaceAppearance(id, appearance) { await api.patchWorkspace(id, { appearance }); detailCache.delete(id); await get().loadWorkspaces(); },
    uploadLogo: (file) => api.uploadLogo(file),
    // One path for single and bulk delete. Deletes run one after another (the
    // server rewrites settings.json per call, so parallel calls would race) and
    // a failure never aborts the rest: the caller gets both lists and decides
    // how to tell the user. The list is reloaded once at the end, even after a
    // partial failure, so the sidebar shows what is really left.
    async removeWorkspaces(ids) {
      const removed: ID[] = [];
      const failed: Array<{ id: ID; message: string }> = [];
      for (const id of ids) {
        try { await api.deleteWorkspace(id); removed.push(id); } catch (e) { failed.push({ id, message: e instanceof Error ? e.message : String(e) }); }
      }
      for (const id of removed) forgetWorkspace(id);
      // Lock overrides are keyed by workspace id; a deleted one would linger in localStorage forever.
      const previewLock = forgetWorkspaceLocks(get().previewLock, removed);
      if (previewLock !== get().previewLock) { savePreviewLock(previewLock); set({ previewLock }); }
      const active = get().activeWorkspaceId;
      if (active && removed.includes(active)) await get().selectWorkspace(null);
      await get().loadWorkspaces();
      return { removed, failed };
    },
    async removeWorkspace(id) {
      const { failed } = await get().removeWorkspaces([id]);
      if (failed[0]) throw new Error(failed[0].message);
    },
    async loadGroups() { set(await api.listGroups()); },
    async createGroup(name, parent) { set(await api.createGroup(name, parent ?? null)); },
    async renameGroup(path, name) { set(await api.renameGroup(path, name)); await get().loadWorkspaces(); },
    async moveGroup(path, parent) { set(await api.moveGroup(path, parent)); await get().loadWorkspaces(); },
    async deleteGroup(path) { set(await api.deleteGroup(path)); await get().loadWorkspaces(); },
    async setFolderAppearance(path, patch) { set(await api.setFolderAppearance(path, patch)); },

    loadTypstAssets: reloadDetail,
    async addTypstAsset(file, kind, folderId) {
      const id = get().activeWorkspaceId!;
      const asset = await api.uploadAsset(id, file, { kind, filename: file.name, folder: folderId ?? null });
      await reloadDetail();
      return get().typstAssets.find((a) => a.id === asset.id) ?? asset;
    },
    async moveTypstAssetToFolder(assetId, folderId) { const r = await api.moveAsset(get().activeWorkspaceId!, assetId, folderId); await reloadDetail(); return r.asset.id; },
    async createAssetFolder(name, parentId) { const f = await api.createFolder(get().activeWorkspaceId!, folderPathFor(parentId ?? null, name)); await reloadDetail(); return f; },
    async renameAssetFolder(id, name) { await api.renameFolder(get().activeWorkspaceId!, id, renamedFolderPath(id, name)); await reloadDetail(); },
    async moveAssetFolder(id, parentId) { await api.renameFolder(get().activeWorkspaceId!, id, movedFolderPath(id, parentId)); await reloadDetail(); },
    async deleteAssetFolder(id) { await api.deleteFolder(get().activeWorkspaceId!, id); await reloadDetail(); },
    async setTypstAssetCrop(id, crop, blurs) {
      const patch: Record<string, unknown> = { crop };
      if (blurs !== undefined) patch.blurs = blurs;
      const asset = await api.patchAsset(get().activeWorkspaceId!, id, patch);
      set((s) => ({ typstAssets: s.typstAssets.map((a) => (a.id === id ? asset : a)) }));
    },
    async renameTypstAsset(id, stem) { const r = await api.renameAsset(get().activeWorkspaceId!, id, stem); await reloadDetail(); return r.asset.filename; },
    async deleteTypstAsset(id) { await api.deleteAsset(get().activeWorkspaceId!, id); await reloadDetail(); },

    async loadSettings() { const s = await api.getSettings(); set({ redaction: s.redaction, typstCli: s.typstCli }); },
    async saveSettings(patch) { const s = await api.patchSettings(patch); set({ redaction: s.redaction, typstCli: s.typstCli }); },
    async loadBackup() { try { set({ backup: await api.getBackup() }); } catch { set({ backup: null }); } },
    async loadMcp() { try { set({ mcp: await api.mcpStatus() }); } catch { set({ mcp: null }); } },
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    toggleWorkspaceLock: (id) => { const previewLock = toggleLock(get().previewLock, id); savePreviewLock(previewLock); set({ previewLock }); },
    setAllLocked: (locked) => { const previewLock = lockAll(get().previewLock, locked); savePreviewLock(previewLock); set({ previewLock }); },
    setOnline: (online) => set({ online }),
    handleEvent(ev) {
      switch (ev.type) {
        case 'workspaces.changed':
          // Names and groups live in the cached entries; cheaper to refetch than to patch.
          detailCache.clear();
          void get().loadWorkspaces(); void get().loadGroups(); void reloadDetail();
          break;
        case 'backup.state': set({ backup: ev.state }); break;
        case 'mcp.clients': set((s) => ({ mcp: { endpoint: s.mcp?.endpoint ?? '/mcp', authRequired: s.mcp?.authRequired ?? false, stdioBridge: s.mcp?.stdioBridge ?? null, clients: ev.clients } })); break;
        case 'workspace.changed':
          // Not on screen: the caches stay (they are revalidated on the next
          // visit anyway), so switching back is still instant.
          if (ev.id !== get().activeWorkspaceId) return;
          set({ lastChange: { id: ev.id, paths: ev.paths, origin: ev.origin, seq: ++seq } });
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => { reloadTimer = null; void reloadDetail(); }, 150);
          break;
      }
    },
  };
});
