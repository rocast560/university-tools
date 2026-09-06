import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FolderPlus, Plus, Settings, Circle } from 'lucide-react';
import { useAppStore } from '@/stores';
import { groupWorkspaces } from '@/lib/workspace-groups';
import { loadCollapsedGroups, saveCollapsedGroups, toggleGroup } from '@/lib/collapsed-groups';
import { FolderBrowserDialog } from '@/components/ui/FolderBrowserDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { BackupState, WorkspaceStatus } from '@/types';

/** The dragged workspace's id, as a browser drag-and-drop payload. */
const DRAG_MIME = 'text/plain';

function backupLabel(b: BackupState | null): string {
  if (!b?.destinations.length) return 'Backup: not set up';
  if (b.lastError) return `Backup: error (${b.lastError})`;
  if (b.lastRunAt) return `Backup: ${new Date(b.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return 'Backup: pending';
}

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const knownGroups = useAppStore((s) => s.groups);
  const active = useAppStore((s) => s.activeWorkspaceId);
  const select = useAppStore((s) => s.selectWorkspace);
  const create = useAppStore((s) => s.createWorkspace);
  const openFolder = useAppStore((s) => s.openFolder);
  const rename = useAppStore((s) => s.renameWorkspace);
  const setGroup = useAppStore((s) => s.setWorkspaceGroup);
  const remove = useAppStore((s) => s.removeWorkspace);
  const createGroup = useAppStore((s) => s.createGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const backup = useAppStore((s) => s.backup);
  const mcp = useAppStore((s) => s.mcp);
  const online = useAppStore((s) => s.online);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [browsing, setBrowsing] = useState<{ locate: WorkspaceStatus } | null>(null);
  const [removing, setRemoving] = useState<WorkspaceStatus | null>(null);
  const [menu, setMenu] = useState<{ ws: WorkspaceStatus; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedGroups());
  const toggle = (group: string) => setCollapsed((prev) => { const next = toggleGroup(prev, group); saveCollapsedGroups(next); return next; });

  const mcpConnected = !!mcp?.clients.some((c) => c.connected);
  const grouped = groupWorkspaces(workspaces, knownGroups);
  const dropOnGroup = (e: React.DragEvent, group: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(DRAG_MIME);
    if (id) void setGroup(id, group);
  };

  return (
    <aside data-ui="sidebar" className="flex h-full w-[280px] shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-widest">Typst Studio</span>
        <div className="flex gap-1">
          <button type="button" title="New workspace" onClick={() => { setCreating(true); setDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Plus size={14} /></button>
          <button type="button" title="New folder" onClick={() => { setCreatingFolder(true); setFolderDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><FolderPlus size={14} /></button>
          <button type="button" title="Settings" onClick={() => setSettingsOpen(true)} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Settings size={14} /></button>
        </div>
      </div>
      {creating && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void create(draft.trim()); setCreating(false); }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setCreating(false)} placeholder="Workspace name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      {creatingFolder && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (folderDraft.trim()) void createGroup(folderDraft.trim()); setCreatingFolder(false); }}>
          <input autoFocus value={folderDraft} onChange={(e) => setFolderDraft(e.target.value)} onBlur={() => setCreatingFolder(false)} placeholder="Folder name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      <div data-testid="sidebar-workspace-list" className="min-h-0 flex-1 overflow-auto px-2 pb-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnGroup(e, null)}>
        {grouped.map(({ group, items }) => {
          const isCollapsed = group !== null && collapsed.has(group);
          return (
            <div key={group ?? '__loose'} className="mb-2">
              {group && (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOnGroup(e, group)}
                  onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ name: group, x: e.clientX, y: e.clientY }); }}
                >
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group)}
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
                  >
                    {isCollapsed ? <ChevronRight size={12} className="shrink-0" aria-hidden="true" /> : <ChevronDown size={12} className="shrink-0" aria-hidden="true" />}
                    <span className="flex-1 truncate">{group}</span>
                    {isCollapsed && <span className="text-[9px] font-normal normal-case tracking-normal">{items.length}</span>}
                  </button>
                </div>
              )}
              {!isCollapsed && items.map((ws) => (
                <button key={ws.id} type="button" draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, ws.id)} onClick={() => void select(ws.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ ws, x: e.clientX, y: e.clientY }); }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${ws.id === active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}>
                  {ws.status === 'missing' ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" /> : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
                  <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
                </button>
              ))}
            </div>
          );
        })}
        {workspaces.length === 0 && <div className="px-2 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">No workspaces yet. Create one to get started.</div>}
      </div>
      <div className="shrink-0 border-t border-[hsl(var(--border))] px-2 py-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
        <button type="button" onClick={() => setSettingsOpen(true)} title="MCP status · open Settings" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[hsl(var(--accent))]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${mcpConnected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />
          <span className="truncate">MCP: {mcpConnected ? `connected (${mcp!.clients.filter((c) => c.connected).map((c) => c.name).join(', ')})` : 'no client'}</span>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} title="Backup status · open Settings" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[hsl(var(--accent))]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} />
          <span className="truncate">{backupLabel(backup)}</span>
        </button>
      </div>

      {menu && (
        <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="absolute w-44 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1 text-xs shadow-lg" style={{ left: menu.x, top: menu.y }}>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename workspace', menu.ws.name); if (n) void rename(menu.ws.id, n); }}>Rename</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const g = window.prompt('Group (empty for none)', menu.ws.group ?? ''); if (g !== null) void setGroup(menu.ws.id, g.trim() || null); }}>Set group</button>
            {menu.ws.status === 'missing' && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => setBrowsing({ locate: menu.ws })}>Locate folder</button>}
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => setRemoving(menu.ws)}>{menu.ws.library ? 'Move to trash' : 'Forget'}</button>
          </div>
        </div>
      )}
      {folderMenu && (
        <div className="fixed inset-0 z-40" onClick={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }}>
          <div className="absolute w-44 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1 text-xs shadow-lg" style={{ left: folderMenu.x, top: folderMenu.y }}>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename folder', folderMenu.name); if (n && n.trim()) void renameGroup(folderMenu.name, n.trim()); }}>Rename folder</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => void deleteGroup(folderMenu.name)}>Delete folder</button>
          </div>
        </div>
      )}
      {browsing && <FolderBrowserDialog title={`Locate ${browsing.locate.name}`} onClose={() => setBrowsing(null)} onPick={(p) => { const ws = browsing.locate; setBrowsing(null); void remove(ws.id).then(() => openFolder(p)); }} />}
      {removing && (
        <ConfirmDialog
          title={removing.library ? 'Move workspace to trash?' : 'Forget this workspace?'}
          message={removing.library ? `${removing.name} moves to the app trash folder; nothing is deleted.` : `${removing.name} stays on disk at ${removing.path}; it is only removed from the list.`}
          confirmLabel={removing.library ? 'Move to trash' : 'Forget'}
          destructive
          onConfirm={() => { void remove(removing.id); setRemoving(null); }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </aside>
  );
}
