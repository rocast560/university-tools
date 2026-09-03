import { useState } from 'react';
import { AlertTriangle, FolderOpen, Plus, Settings, Circle } from 'lucide-react';
import { useAppStore } from '@/stores';
import { groupWorkspaces } from '@/lib/workspace-groups';
import { FolderBrowserDialog } from '@/components/ui/FolderBrowserDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { WorkspaceStatus } from '@/types';

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const active = useAppStore((s) => s.activeWorkspaceId);
  const select = useAppStore((s) => s.selectWorkspace);
  const create = useAppStore((s) => s.createWorkspace);
  const openFolder = useAppStore((s) => s.openFolder);
  const rename = useAppStore((s) => s.renameWorkspace);
  const setGroup = useAppStore((s) => s.setWorkspaceGroup);
  const remove = useAppStore((s) => s.removeWorkspace);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const backup = useAppStore((s) => s.backup);
  const mcp = useAppStore((s) => s.mcp);
  const online = useAppStore((s) => s.online);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [browsing, setBrowsing] = useState<'open' | { locate: WorkspaceStatus } | null>(null);
  const [removing, setRemoving] = useState<WorkspaceStatus | null>(null);
  const [menu, setMenu] = useState<{ ws: WorkspaceStatus; x: number; y: number } | null>(null);

  const mcpConnected = !!mcp?.clients.some((c) => c.connected);
  const groups = groupWorkspaces(workspaces);

  return (
    <aside data-ui="sidebar" className="flex h-full w-[280px] shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-widest">Typst Studio</span>
        <div className="flex gap-1">
          <button type="button" title="New workspace" onClick={() => { setCreating(true); setDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Plus size={14} /></button>
          <button type="button" title="Open folder as workspace" onClick={() => setBrowsing('open')} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><FolderOpen size={14} /></button>
          <button type="button" title="Settings" onClick={() => setSettingsOpen(true)} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Settings size={14} /></button>
        </div>
      </div>
      {creating && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void create(draft.trim()); setCreating(false); }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setCreating(false)} placeholder="Workspace name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {groups.map(({ group, items }) => (
          <div key={group ?? '__loose'} className="mb-2">
            {group && <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{group}</div>}
            {items.map((ws) => (
              <button key={ws.id} type="button" onClick={() => void select(ws.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ ws, x: e.clientX, y: e.clientY }); }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${ws.id === active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}>
                {ws.status === 'missing' ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" /> : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
                <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
              </button>
            ))}
          </div>
        ))}
        {workspaces.length === 0 && <div className="px-2 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">No workspaces yet. Create one or open a folder.</div>}
      </div>
      <div className="border-t border-[hsl(var(--border))] px-3 py-2 text-[10px] text-[hsl(var(--muted-foreground))]">
        <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${mcpConnected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />MCP {mcpConnected ? `connected (${mcp!.clients.filter((c) => c.connected).map((c) => c.name).join(', ')})` : 'no client'}</div>
        <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${online ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} />{backup?.destinations.length ? (backup.lastError ? `backup error: ${backup.lastError}` : backup.lastRunAt ? `backed up ${new Date(backup.lastRunAt).toLocaleTimeString()}` : 'backup pending') : 'no backup destination'}</div>
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
      {browsing === 'open' && <FolderBrowserDialog title="Open a folder as a workspace" onClose={() => setBrowsing(null)} onPick={(p) => { setBrowsing(null); void openFolder(p); }} />}
      {browsing && browsing !== 'open' && <FolderBrowserDialog title={`Locate ${browsing.locate.name}`} onClose={() => setBrowsing(null)} onPick={(p) => { const ws = browsing.locate; setBrowsing(null); void remove(ws.id).then(() => openFolder(p)); }} />}
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
