import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import {
  FolderPlus, Plus, Settings,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useAppStore } from '@/stores';
import { FolderTree } from '@/components/sidebar/FolderTree';
import { subtreeCount, workspacesByFolder } from '@/lib/workspace-groups';
import { docKey, loadCollapsedGroups, saveCollapsedGroups, toggleGroup } from '@/lib/collapsed-groups';
import { loadSidebarCollapsed, saveSidebarCollapsed } from '@/lib/sidebar-collapse';
import { canDrop, parseDrag, SIDEBAR_DRAG_MIME, type DragPayload, type DropTarget } from '@/lib/sidebar-dnd';
import { buildNesting, orphansMovedUp } from '@/lib/workspace-nesting';
import { folderName } from '@/lib/folder-tree';
import {
  EMPTY_SELECTION, pruneSelection, rangeTo, resetTo, selectedList, toggle as toggleSelected, visibleOrder,
  type ClickMods, type Selection,
} from '@/lib/sidebar-selection';
import type { BackupState, WorkspaceStatus } from '@/types';

// All three only appear on a deliberate action (locating a moved workspace,
// confirming a destructive one, picking a folder's look), so they stay off
// the app's first-paint chunk.
const FolderBrowserDialog = lazy(() => import('@/components/ui/FolderBrowserDialog').then((m) => ({ default: m.FolderBrowserDialog })));
const ConfirmDialog = lazy(() => import('@/components/ui/ConfirmDialog').then((m) => ({ default: m.ConfirmDialog })));
const FolderAppearance = lazy(() => import('@/components/sidebar/FolderAppearance').then((m) => ({ default: m.FolderAppearance })));

/**
 * Whether a keystroke belongs to something the user is typing into, so the
 * collapse shortcut doesn't fire while they are naming a workspace (or, in a
 * browser that doesn't claim Ctrl+B for bold, editing text anywhere).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** CodeMirror's root, for browsers/jsdom where isContentEditable alone can't tell the editor apart. */
function inEditor(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('.cm-editor');
}

/** How many names a bulk-delete dialog spells out before collapsing the rest into "+N more". */
const LISTED_NAMES = 5;

/**
 * The body of the bulk-delete dialog: which documents, then how many go to the
 * app trash (recoverable) versus how many are only unregistered (external
 * folders are never touched on disk), so the user can tell the two apart.
 */
function bulkMessage(targets: WorkspaceStatus[], movedUp = 0): string {
  const names = targets.slice(0, LISTED_NAMES).map((w) => w.name);
  if (targets.length > LISTED_NAMES) names.push(`+${targets.length - LISTED_NAMES} more`);
  const lib = targets.filter((w) => w.library).length;
  const ext = targets.length - lib;
  const parts = [`${names.join(', ')}.`];
  if (lib) parts.push(`${lib} ${lib === 1 ? 'moves' : 'move'} to the app trash folder (data/trash) and can be restored from there.`);
  if (ext) parts.push(`${ext} ${ext === 1 ? 'is' : 'are'} only removed from the sidebar; ${ext === 1 ? 'its folder stays' : 'their folders stay'} on disk.`);
  if (movedUp) parts.push(movedUpNote(movedUp));
  return parts.join(' ');
}

/** Deleting a parent never takes its nested documents with it. */
function movedUpNote(n: number): string {
  return `${n} nested ${n === 1 ? 'document moves' : 'documents move'} up a level.`;
}

function backupLabel(b: BackupState | null): string {
  if (!b?.destinations.length) return 'Backup: not set up';
  if (b.lastError) return `Backup: error (${b.lastError})`;
  if (b.lastRunAt) return `Backup: ${new Date(b.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return 'Backup: pending';
}

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const knownGroups = useAppStore((s) => s.groups);
  const folderMeta = useAppStore((s) => s.folderMeta);
  const active = useAppStore((s) => s.activeWorkspaceId);
  const select = useAppStore((s) => s.selectWorkspace);
  const create = useAppStore((s) => s.createWorkspace);
  const openFolder = useAppStore((s) => s.openFolder);
  const rename = useAppStore((s) => s.renameWorkspace);
  const setGroup = useAppStore((s) => s.setWorkspaceGroup);
  const setParent = useAppStore((s) => s.setWorkspaceParent);
  const setWorkspaceAppearance = useAppStore((s) => s.setWorkspaceAppearance);
  const uploadLogo = useAppStore((s) => s.uploadLogo);
  const remove = useAppStore((s) => s.removeWorkspace);
  const removeMany = useAppStore((s) => s.removeWorkspaces);
  const createGroup = useAppStore((s) => s.createGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const moveGroup = useAppStore((s) => s.moveGroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const setFolderAppearance = useAppStore((s) => s.setFolderAppearance);
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
  // The appearance popover is shared: a folder (by path) or a document (by id).
  const [appearance, setAppearance] = useState<({ path: string } | { id: string }) & { x: number; y: number } | null>(null);
  const [subfolderOf, setSubfolderOf] = useState<string | null>(null);
  const [subfolderDraft, setSubfolderDraft] = useState('');
  const [movingWs, setMovingWs] = useState<WorkspaceStatus | null>(null);
  const [removingFolder, setRemovingFolder] = useState<string | null>(null);
  const [removingMany, setRemovingMany] = useState<WorkspaceStatus[] | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const asideRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedGroups());
  const toggle = (group: string) => setCollapsed((prev) => { const next = toggleGroup(prev, group); saveCollapsedGroups(next); return next; });

  // Whole-sidebar collapse: the workspace list folds down to an icon rail so a
  // long document gets the width back. The rail keeps the expand chevron, the
  // settings gear and the two status dots, so nothing here becomes unreachable
  // while it is shut.
  const [railed, setRailed] = useState(loadSidebarCollapsed);
  const toggleRail = useCallback(() => setRailed((prev) => { saveSidebarCollapsed(!prev); return !prev; }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'b' && e.key !== 'B') return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleRail]);

  const mcpConnected = !!mcp?.clients.some((c) => c.connected);
  const byFolder = workspacesByFolder(workspaces);
  const nesting = buildNesting(workspaces);

  // The selection as the user can see it: ids that were deleted elsewhere are
  // pruned, and rows hidden inside a collapsed folder or under a collapsed
  // document don't count, so a bulk delete never reaches something that isn't on screen.
  const order = visibleOrder(knownGroups, byFolder, collapsed, null, nesting);
  const sel = pruneSelection(selection, new Set(workspaces.map((w) => w.id)));
  const selIds = selectedList(sel, order);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const targetsOf = (ids: string[]) => ids.map((id) => byId.get(id)).filter((w): w is WorkspaceStatus => !!w);

  /** Plain click opens and resets; Ctrl/Cmd toggles; Shift ranges over the visible order. */
  const onRowSelect = (id: string, mods: ClickMods) => {
    if (mods.range) setSelection(rangeTo(sel, order, id));
    else if (mods.toggle) setSelection(toggleSelected(sel, id));
    else { setSelection(resetTo(id)); void select(id); }
  };

  /**
   * Delete a batch through the one store action. A thrown error or a partial
   * failure ends up in the sidebar's alert; the successes are already gone.
   * The selection is dropped either way: the rows it pointed at are gone or
   * the list was just reloaded.
   */
  const deleteTargets = async (targets: WorkspaceStatus[]) => {
    setSelection(EMPTY_SELECTION);
    setRemoveError(null);
    try {
      const { failed } = await removeMany(targets.map((w) => w.id));
      if (failed.length) {
        const nameOf = (id: string) => byId.get(id)?.name ?? id;
        setRemoveError(`Could not remove ${failed.length} of ${targets.length}. ${failed.map((f) => `${nameOf(f.id)}: ${f.message}`).join('; ')}`);
      }
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    }
  };

  const anyOverlayOpen = !!(menu || folderMenu || removing || removingMany || removingFolder || browsing || appearance);
  // Delete / Escape on the selection, plus a click anywhere outside the sidebar
  // dropping it, so a selection left behind after opening a document can't make
  // a later Delete press (focus in the preview, say) open a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || anyOverlayOpen) return;
      if (isTypingTarget(e.target) || inEditor(e.target)) return;
      if (e.key === 'Escape') { if (sel.ids.size) setSelection(EMPTY_SELECTION); return; }
      if (e.key !== 'Delete' || !selIds.length) return;
      e.preventDefault();
      const targets = targetsOf(selIds);
      if (targets.length === 1 && targets[0]) setRemoving(targets[0]); else if (targets.length) setRemovingMany(targets);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (asideRef.current?.contains(t) || t?.closest?.('[role="dialog"]')) return;
      setSelection((cur) => (cur.ids.size ? EMPTY_SELECTION : cur));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  });

  // What is being dragged right now. Held here rather than read back from the
  // DataTransfer because browsers only expose its data on drop, never on
  // dragover -- and dragover is what decides the highlight.
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSpring = () => { if (springTimer.current) { clearTimeout(springTimer.current); springTimer.current = null; } };

  /**
   * Apply a drop onto `target`, if the rules allow it: a folder path or null
   * (the top level) files it there (a document is also un-nested), and a
   * document row nests a dragged document under that row.
   */
  const applyDrop = (e: React.DragEvent, target: DropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    clearSpring();
    setDropTarget(null);
    // On drop the DataTransfer is readable, so prefer it; `dragging` covers a
    // drag whose payload another handler already consumed.
    const payload = parseDrag(e.dataTransfer.getData(SIDEBAR_DRAG_MIME)) ?? dragging;
    setDragging(null);
    if (!payload) return;
    if (target !== null && typeof target === 'object') {
      if (payload.kind === 'workspace') {
        if (canDrop(payload, target, knownGroups, workspaces)) void setParent(payload.id, target.workspace);
        return;
      }
      // A folder dropped on a document row is filed in that row's folder, as it always was.
      const folder = byId.get(target.workspace)?.group ?? null;
      if (canDrop(payload, folder, knownGroups)) void moveGroup(payload.path, folder);
      return;
    }
    if (!canDrop(payload, target, knownGroups)) return;
    if (payload.kind === 'workspace') void setGroup(payload.id, target);
    else void moveGroup(payload.path, target);
  };

  /** Hovering a document row: a legal nest lights the row; a folder drag is let through to file into the row's folder. */
  const onRowDragOver = (e: React.DragEvent, id: string) => {
    if (!dragging) { e.preventDefault(); return; }
    if (dragging.kind === 'folder') {
      if (!canDrop(dragging, byId.get(id)?.group ?? null, knownGroups)) return;
      e.preventDefault();
      return;
    }
    if (!canDrop(dragging, { workspace: id }, knownGroups, workspaces)) return; // no preventDefault: refuses the drop
    e.preventDefault();
    e.stopPropagation();
    const key = docKey(id);
    if (dropTarget === key) return;
    setDropTarget(key);
    clearSpring();
    // Spring-loaded like folders: resting on a collapsed parent opens it.
    if (collapsed.has(key)) springTimer.current = setTimeout(() => toggle(key), 600);
  };

  const onRowDragLeave = (id: string) => {
    clearSpring();
    const key = docKey(id);
    setDropTarget((cur) => (cur === key ? null : cur));
  };

  const onFolderDragOver = (e: React.DragEvent, path: string) => {
    if (dragging && !canDrop(dragging, path, knownGroups)) return; // no preventDefault: refuses the drop
    e.preventDefault();
    e.stopPropagation();
    if (dropTarget === path) return;
    setDropTarget(path);
    clearSpring();
    // Spring-loaded: resting on a shut folder opens it, so a drag can reach a
    // subfolder without being dropped first.
    if (collapsed.has(path)) springTimer.current = setTimeout(() => toggle(path), 600);
  };

  const onFolderDragLeave = (path: string) => {
    clearSpring();
    setDropTarget((cur) => (cur === path ? null : cur));
  };

  // A drag that never drops -- Esc mid-hover, or a release outside any wired
  // target -- still fires `dragend` on its source, which always bubbles to
  // window. One listener here catches every case (folder or workspace source,
  // dropped inside or outside the sidebar) without threading a new prop
  // through FolderTree/FolderRow/WorkspaceRow, and runs the same cleanup a
  // completed drop already does -- otherwise a pending spring timer would
  // still fire and expand a folder the user never actually dropped into.
  useEffect(() => {
    const onDragEnd = () => { clearSpring(); setDropTarget(null); setDragging(null); };
    window.addEventListener('dragend', onDragEnd);
    return () => { window.removeEventListener('dragend', onDragEnd); clearSpring(); };
  }, []);

  if (railed) {
    return (
      <aside data-ui="sidebar" data-collapsed="true" className="flex h-full w-11 shrink-0 flex-col items-center pane-float bg-[hsl(var(--card))] py-2">
        <button type="button" title="Expand sidebar (Ctrl/⌘+B)" aria-label="Expand sidebar" aria-expanded={false} onClick={toggleRail} className="rounded p-1.5 hover:bg-[hsl(var(--accent))]">
          <PanelLeftOpen size={15} />
        </button>
        <button type="button" title="Settings" onClick={() => setSettingsOpen(true)} className="mt-1 rounded p-1.5 hover:bg-[hsl(var(--accent))]">
          <Settings size={15} />
        </button>
        <div className="flex-1" />
        {/* The footer's two status readouts, reduced to their dots: the label
            moves into the tooltip, and both still open Settings. */}
        <button type="button" onClick={() => setSettingsOpen(true)} title={`MCP: ${mcpConnected ? `connected (${mcp!.clients.filter((c) => c.connected).map((c) => c.name).join(', ')})` : 'no client'}`} className="rounded p-1.5 hover:bg-[hsl(var(--accent))]">
          <span className={`block h-2 w-2 rounded-full ${mcpConnected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} title={backupLabel(backup)} className="rounded p-1.5 hover:bg-[hsl(var(--accent))]">
          <span className={`block h-2 w-2 rounded-full ${online ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} />
        </button>
      </aside>
    );
  }

  return (
    <aside ref={asideRef} data-ui="sidebar" data-collapsed="false" className="flex h-full w-[280px] shrink-0 flex-col pane-float bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-widest">Typst Studio</span>
        <div className="flex gap-1">
          <button type="button" title="New workspace" onClick={() => { setCreating(true); setDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Plus size={14} /></button>
          <button type="button" title="New folder" onClick={() => { setCreatingFolder(true); setFolderDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><FolderPlus size={14} /></button>
          <button type="button" title="Settings" onClick={() => setSettingsOpen(true)} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Settings size={14} /></button>
          <button type="button" title="Collapse sidebar (Ctrl/⌘+B)" aria-label="Collapse sidebar" aria-expanded onClick={toggleRail} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><PanelLeftClose size={14} /></button>
        </div>
      </div>
      {creating && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void create(draft.trim()); setCreating(false); }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setCreating(false)} placeholder="Workspace name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      {creatingFolder && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (folderDraft.trim()) void createGroup(folderDraft.trim(), null); setCreatingFolder(false); }}>
          <input autoFocus value={folderDraft} onChange={(e) => setFolderDraft(e.target.value)} onBlur={() => setCreatingFolder(false)} placeholder="Folder name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      {subfolderOf && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (subfolderDraft.trim()) void createGroup(subfolderDraft.trim(), subfolderOf); setSubfolderOf(null); }}>
          <input autoFocus value={subfolderDraft} onChange={(e) => setSubfolderDraft(e.target.value)} onBlur={() => setSubfolderOf(null)} placeholder="Subfolder name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      <div data-testid="sidebar-workspace-list" className="min-h-0 flex-1 overflow-auto px-2 pb-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => applyDrop(e, null)}>
        <FolderTree
          parent={null}
          depth={0}
          groups={knownGroups}
          folderMeta={folderMeta}
          byFolder={byFolder}
          nesting={nesting}
          collapsed={collapsed}
          activeId={active}
          selectedIds={sel.ids}
          onToggle={toggle}
          onSelect={onRowSelect}
          onFolderMenu={(name, x, y) => setFolderMenu({ name, x, y })}
          // Right-click outside the selection re-targets it to that row first, as file managers do.
          onWorkspaceMenu={(w, x, y) => { if (!sel.ids.has(w.id)) setSelection(resetTo(w.id)); setMenu({ ws: w, x, y }); }}
          dropTarget={dropTarget}
          onDragStart={setDragging}
          onDragOver={onFolderDragOver}
          onDragLeave={onFolderDragLeave}
          onRowDragOver={onRowDragOver}
          onRowDragLeave={onRowDragLeave}
          onDrop={applyDrop}
        />
        {workspaces.length === 0 && <div className="px-2 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">No workspaces yet. Create one to get started.</div>}
      </div>
      {removeError && (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-t border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-[hsl(var(--status-red))]">
          <span className="min-w-0 flex-1 break-words">{removeError}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setRemoveError(null)} className="shrink-0 rounded px-1 hover:bg-[hsl(var(--accent))]">×</button>
        </div>
      )}
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
        <div className="fixed inset-0 z-40" onClick={() => { setMenu(null); setMovingWs(null); }} onContextMenu={(e) => { e.preventDefault(); setMenu(null); setMovingWs(null); }}>
          <div className="pop-shadow absolute w-44 rounded-md bg-[hsl(var(--popover))] p-1 text-xs" style={{ left: menu.x, top: menu.y }}>
            {/* Rename and Move act on one document; with several selected only the bulk delete is offered. */}
            {!(selIds.length >= 2) && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename workspace', menu.ws.name); if (n) void rename(menu.ws.id, n); }}>Rename</button>}
            {!(selIds.length >= 2) && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={(e) => { e.stopPropagation(); setMovingWs(menu.ws); }}>Move to…</button>}
            {!(selIds.length >= 2) && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { setAppearance({ id: menu.ws.id, x: menu.x, y: menu.y }); setMenu(null); setMovingWs(null); }}>Appearance…</button>}
            {movingWs?.id === menu.ws.id && selIds.length < 2 && (
              <div className="max-h-48 overflow-auto border-t border-[hsl(var(--border))] pt-1">
                <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { void setGroup(menu.ws.id, null); setMovingWs(null); setMenu(null); }}>Top level</button>
                {knownGroups.map((g) => (
                  <button key={g} type="button" className="block w-full truncate rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { void setGroup(menu.ws.id, g); setMovingWs(null); setMenu(null); }}>{g}</button>
                ))}
              </div>
            )}
            {menu.ws.status === 'missing' && selIds.length < 2 && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => setBrowsing({ locate: menu.ws })}>Locate folder</button>}
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => { if (selIds.length >= 2) setRemovingMany(targetsOf(selIds)); else setRemoving(menu.ws); }}>{selIds.length >= 2 ? `Delete ${selIds.length} documents…` : menu.ws.library ? 'Delete…' : 'Remove from sidebar'}</button>
          </div>
        </div>
      )}
      {folderMenu && (
        <div className="fixed inset-0 z-40" onClick={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }}>
          <div className="pop-shadow absolute w-44 rounded-md bg-[hsl(var(--popover))] p-1 text-xs" style={{ left: folderMenu.x, top: folderMenu.y }}>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { setSubfolderOf(folderMenu.name); setSubfolderDraft(''); setFolderMenu(null); }}>New subfolder</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename folder', folderName(folderMenu.name)); if (n && n.trim()) void renameGroup(folderMenu.name, n.trim()); }}>Rename folder</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { setAppearance({ path: folderMenu.name, x: folderMenu.x, y: folderMenu.y }); setFolderMenu(null); }}>Appearance…</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => { setRemovingFolder(folderMenu.name); setFolderMenu(null); }}>Delete folder</button>
          </div>
        </div>
      )}
      {appearance && (
        <Suspense fallback={null}>
          <FolderAppearance
            meta={'path' in appearance ? folderMeta[appearance.path] : byId.get(appearance.id)?.appearance}
            x={appearance.x}
            y={appearance.y}
            onPick={(patch) => void ('path' in appearance ? setFolderAppearance(appearance.path, patch) : setWorkspaceAppearance(appearance.id, patch))}
            onUploadLogo={uploadLogo}
            onClose={() => setAppearance(null)}
          />
        </Suspense>
      )}
      {browsing && (
        <Suspense fallback={null}>
          <FolderBrowserDialog title={`Locate ${browsing.locate.name}`} onClose={() => setBrowsing(null)} onPick={(p) => { const ws = browsing.locate; setBrowsing(null); void remove(ws.id).then(() => openFolder(p)); }} />
        </Suspense>
      )}
      {removing && (
        <Suspense fallback={null}>
          <ConfirmDialog
            title={removing.library ? 'Delete this document?' : 'Remove from sidebar?'}
            message={`${removing.library ? `${removing.name} moves to the app trash folder (data/trash) and can be restored from there.` : `${removing.name} stays on disk at ${removing.path}; it is only removed from the sidebar.`}${orphansMovedUp(workspaces, [removing.id]) ? ` ${movedUpNote(orphansMovedUp(workspaces, [removing.id]))}` : ''}`}
            confirmLabel={removing.library ? 'Delete' : 'Remove'}
            destructive
            onConfirm={() => { void deleteTargets([removing]); setRemoving(null); }}
            onCancel={() => setRemoving(null)}
          />
        </Suspense>
      )}
      {removingMany && (
        <Suspense fallback={null}>
          <ConfirmDialog
            title={`Delete ${removingMany.length} documents?`}
            message={bulkMessage(removingMany, orphansMovedUp(workspaces, removingMany.map((w) => w.id)))}
            confirmLabel={`Delete ${removingMany.length}`}
            destructive
            onConfirm={() => { void deleteTargets(removingMany); setRemovingMany(null); }}
            onCancel={() => setRemovingMany(null)}
          />
        </Suspense>
      )}
      {removingFolder && (
        <Suspense fallback={null}>
          <ConfirmDialog
            title="Delete this folder?"
            message={`${folderName(removingFolder)} and its subfolders are removed from the sidebar. ${subtreeCount(byFolder, removingFolder)} workspaces move to the top level. Nothing on disk is deleted.`}
            confirmLabel="Delete folder"
            destructive
            onConfirm={() => { void deleteGroup(removingFolder); setRemovingFolder(null); }}
            onCancel={() => setRemovingFolder(null)}
          />
        </Suspense>
      )}
    </aside>
  );
}
