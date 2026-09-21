import { ChevronDown, ChevronRight } from 'lucide-react';
import { folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import { folderName } from '@/lib/folder-tree';
import { encodeDrag, SIDEBAR_DRAG_MIME } from '@/lib/sidebar-dnd';
import type { FolderMeta } from '@/types';

export function FolderRow({ path, meta, collapsed, count, indent, onToggle, onMenu, onDrop }: {
  path: string;
  meta: FolderMeta | undefined;
  collapsed: boolean;
  count: number;
  indent: number;
  onToggle: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  onDrop: (e: React.DragEvent, path: string) => void;
}) {
  const Icon = folderIcon(meta?.icon);
  const color = folderColorVar(meta?.color);
  return (
    <button
      type="button"
      draggable
      data-testid={`folder-${path}`}
      aria-expanded={!collapsed}
      style={{ paddingLeft: `${4 + indent * 12}px` }}
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag({ kind: 'folder', path })); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, path)}
      onClick={() => onToggle(path)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(path, e.clientX, e.clientY); }}
      className="flex w-full items-center gap-1 rounded py-1 pr-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
    >
      <span data-folder-stripe className="mr-0.5 h-3.5 w-0.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? 'transparent' }} />
      {collapsed ? <ChevronRight size={12} className="shrink-0" aria-hidden="true" /> : <ChevronDown size={12} className="shrink-0" aria-hidden="true" />}
      <Icon size={12} data-folder-icon={meta?.icon ?? 'folder'} className="shrink-0" style={color ? { color } : undefined} aria-hidden="true" />
      <span className="flex-1 truncate">{folderName(path)}</span>
      {collapsed && count > 0 && (
        <span className="text-[9px] font-normal normal-case tracking-normal" style={color ? { color } : undefined}>{count}</span>
      )}
    </button>
  );
}
