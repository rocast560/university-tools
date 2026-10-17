import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Circle, Lock } from 'lucide-react';
import { logoUrl } from '@/api/client';
import { folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import { useAppStore } from '@/stores';
import { isLocked } from '@/lib/preview-lock';
import { cancelHoverPrefetch, hoverPrefetch } from '@/lib/prefetch';
import { encodeDrag, SIDEBAR_DRAG_MIME, type DragPayload, type DropTarget } from '@/lib/sidebar-dnd';
import type { ClickMods } from '@/lib/sidebar-selection';
import type { WorkspaceStatus } from '@/types';

export function WorkspaceRow({ ws, active, selected = false, indent, nest, dropActive = false, onSelect, onMenu, onToggleChildren, onDragStart, onDragOver, onDragLeave, onDrop }: {
  ws: WorkspaceStatus;
  active: boolean;
  /** Part of the multi-selection (Ctrl/Shift+click); shown differently from the open document. */
  selected?: boolean;
  /** Folder levels plus nesting levels above this row; each is 12px. */
  indent: number;
  /** Set on a document that has nested documents under it: shows a chevron. */
  nest?: { collapsed: boolean };
  /** A legal drag is hovering this row, so a drop would nest under it. */
  dropActive?: boolean;
  onSelect: (id: string, mods: ClickMods) => void;
  onMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
  onToggleChildren?: (id: string) => void;
  onDragStart: (p: DragPayload) => void;
  onDragOver?: (e: React.DragEvent, id: string) => void;
  onDragLeave?: (id: string) => void;
  onDrop: (e: React.DragEvent, target: DropTarget) => void;
}) {
  // A boolean selector: the row re-renders only when its own lock flips, not on every lock change.
  const locked = useAppStore((s) => isLocked(s.previewLock, ws.id));
  // A logo file that will not load (deleted by hand, say) falls back to the icon or the dot.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const ap = ws.appearance;
  const logo = ap?.logo && ap.logo !== failedLogo ? ap.logo : null;
  const color = folderColorVar(ap?.color);
  const Icon = ap?.icon ? folderIcon(ap.icon) : null;
  const ring = color ?? 'hsl(var(--ring))';

  // Logo, then icon, then the default dot. The colour tints icons and the dot, never a logo.
  let glyph: React.ReactNode;
  if (ws.status === 'missing') glyph = <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" />;
  else if (logo) glyph = <img data-doc-logo src={logoUrl(logo)} alt="" draggable={false} onError={() => setFailedLogo(logo)} className="h-3.5 w-3.5 rounded-sm object-contain" />;
  else if (Icon) glyph = <Icon size={12} data-doc-icon={ap!.icon} style={color ? { color } : undefined} aria-hidden="true" />;
  else glyph = <Circle size={6} data-doc-default style={color ? { color } : undefined} className={color ? 'fill-current' : ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />;

  return (
    <button
      type="button"
      draggable
      data-testid={`workspace-${ws.id}`}
      data-selected={selected ? 'true' : undefined}
      data-drop-active={dropActive ? 'true' : undefined}
      style={{ paddingLeft: `${4 + indent * 12}px`, boxShadow: dropActive ? `inset 0 0 0 2px ${ring}` : undefined }}
      onDragStart={(e) => {
        e.stopPropagation();
        const payload = { kind: 'workspace', id: ws.id } as const;
        e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag(payload));
        onDragStart(payload);
      }}
      onDragOver={(e) => { if (onDragOver) onDragOver(e, ws.id); else e.preventDefault(); }}
      onDragLeave={() => onDragLeave?.(ws.id)}
      onDrop={(e) => { e.stopPropagation(); onDrop(e, { workspace: ws.id }); }}
      // Shift-click would otherwise also start a browser text selection across the rows.
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick={(e) => onSelect(ws.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
      onContextMenu={(e) => { e.preventDefault(); onMenu(ws, e.clientX, e.clientY); }}
      onPointerEnter={() => { if (ws.status === 'ok' && !active) hoverPrefetch(ws.id); }}
      onPointerLeave={cancelHoverPrefetch}
      className={`flex w-full select-none items-center gap-1 rounded-md py-1 pr-2 text-left text-xs hover:bg-[hsl(var(--accent))] ${active ? 'bg-[hsl(var(--accent))] font-medium' : ''} ${selected ? 'bg-[hsl(var(--primary))]/15 ring-1 ring-inset ring-[hsl(var(--primary))]/60' : ''}`}
    >
      {/* A fixed slot, so rows with and without children line up. A span, because a button cannot sit inside this button. */}
      <span className="flex h-4 w-3 shrink-0 items-center justify-center">
        {nest && (
          <span
            role="button"
            tabIndex={-1}
            data-testid={`toggle-workspace-${ws.id}`}
            aria-label={nest.collapsed ? 'Expand nested documents' : 'Collapse nested documents'}
            aria-expanded={!nest.collapsed}
            onClick={(e) => { e.stopPropagation(); onToggleChildren?.(ws.id); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="flex h-4 w-3 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
          >
            {nest.collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </span>
        )}
      </span>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{glyph}</span>
      <span className="ml-1 flex-1 truncate" title={ws.path}>{ws.name}</span>
      {locked && <span title="Preview locked" className="shrink-0 text-[hsl(var(--muted-foreground))]"><Lock size={10} /></span>}
    </button>
  );
}
