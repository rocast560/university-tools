import { AlertTriangle, Circle } from 'lucide-react';
import { cancelHoverPrefetch, hoverPrefetch } from '@/lib/prefetch';
import { encodeDrag, SIDEBAR_DRAG_MIME } from '@/lib/sidebar-dnd';
import type { WorkspaceStatus } from '@/types';

export function WorkspaceRow({ ws, active, indent, onSelect, onMenu }: {
  ws: WorkspaceStatus;
  active: boolean;
  indent: number;
  onSelect: (id: string) => void;
  onMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
}) {
  return (
    <button
      type="button"
      draggable
      data-testid={`workspace-${ws.id}`}
      style={{ paddingLeft: `${8 + indent * 12}px` }}
      onDragStart={(e) => e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag({ kind: 'workspace', id: ws.id }))}
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
