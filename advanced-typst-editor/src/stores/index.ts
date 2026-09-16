import { create } from 'zustand';
import { api } from '@/api/client';
import { folderPathFor, movedFolderPath, renamedFolderPath } from '@/lib/folder-paths';
import { switchTrace } from '@/lib/perf';
import { detailCache, forgetWorkspace, mergeDetail } from '@/lib/workspace-cache';
import type { AssetFolder, BackupState, BlurRegion, CropRect, ID, McpStatus, RedactionDefaults, ServerEvent, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceStatus } from '@/types';

export interface ChangeNotice { id: ID; paths: string[]; origin: string | null; seq: number }

export interface AppState {
  workspaces: WorkspaceStatus[];
  groups: string[];
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

  loadWorkspaces(): Promise<void>;
  selectWorkspace(id: ID | null): Promise<void>;
  createWorkspace(name: string, group?: string | null): Promise<WorkspaceStatus | null>;
  openFolder(path: string): Promise<void>;
  renameWorkspace(id: ID, name: string): Promise<void>;
  setWorkspaceGroup(id: ID, group: string | null): Promise<void>;
  removeWorkspace(id: ID): Promise<void>;
  loadGroups(): Promise<void>;
  createGroup(name: string): Promise<void>;
  renameGroup(name: string, newName: string): Promise<void>;
  deleteGroup(name: string): Promise<void>;

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
    workspaces: [], groups: [], activeWorkspaceId: null, detail: null, typstAssets: [], assetFolders: [],
    redaction: { style: 'gaussian', strength: 1 }, typstCli: null, backup: null, mcp: null, online: false, lastChange: null, settingsOpen: false,

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
    async setWorkspaceGroup(id, group) { await api.patchWorkspace(id, { group }); detailCache.delete(id); await get().loadWorkspaces(); },
    async removeWorkspace(id) { await api.deleteWorkspace(id); forgetWorkspace(id); if (get().activeWorkspaceId === id) await get().selectWorkspace(null); await get().loadWorkspaces(); },
    async loadGroups() { set({ groups: await api.listGroups() }); },
    async createGroup(name) { set({ groups: await api.createGroup(name) }); },
    async renameGroup(name, newName) { set({ groups: await api.renameGroup(name, newName) }); await get().loadWorkspaces(); },
    async deleteGroup(name) { set({ groups: await api.deleteGroup(name) }); await get().loadWorkspaces(); },

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
