import { AlertTriangle, Circle } from 'lucide-react';
import { cancelHoverPrefetch, hoverPrefetch } from '@/lib/prefetch';
import { encodeDrag, SIDEBAR_DRAG_MIME, type DragPayload } from '@/lib/sidebar-dnd';
import type { WorkspaceStatus } from '@/types';

export function WorkspaceRow({ ws, active, indent, folder, onSelect, onMenu, onDragStart, onDrop }: {
  ws: WorkspaceStatus;
  active: boolean;
  indent: number;
  /** The folder this row lives in (null at the top level) -- where a drop on this row is filed. */
  folder: string | null;
  onSelect: (id: string) => void;
  onMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
  onDragStart: (p: DragPayload) => void;
  onDrop: (e: React.DragEvent, target: string | null) => void;
}) {
  return (
    <button
      type="button"
      draggable
      data-testid={`workspace-${ws.id}`}
      style={{ paddingLeft: `${8 + indent * 12}px` }}
      onDragStart={(e) => {
        const payload = { kind: 'workspace', id: ws.id } as const;
        e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag(payload));
        onDragStart(payload);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.stopPropagation(); onDrop(e, folder); }}
      onClick={() => onSelect(ws.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(ws, e.clientX, e.clientY); }}
      onPointerEnter={() => { if (ws.status === 'ok' && !active) hoverPrefetch(ws.id); }}
      onPointerLeave={cancelHoverPrefetch}
      className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-[hsl(var(--accent))] ${active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}
    >
      {ws.status === 'missing'
        ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" />
        : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
      <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
    </button>
  );
}
