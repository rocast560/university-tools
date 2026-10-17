import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { logoUrl } from '@/api/client';
import { folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import { folderName } from '@/lib/folder-tree';
import { encodeDrag, SIDEBAR_DRAG_MIME, type DragPayload } from '@/lib/sidebar-dnd';
import type { FolderMeta } from '@/types';

export function FolderRow({ path, meta, collapsed, count, indent, dropActive, onToggle, onMenu, onDragStart, onDragOver, onDragLeave, onDrop }: {
  path: string;
  meta: FolderMeta | undefined;
  collapsed: boolean;
  count: number;
  indent: number;
  dropActive: boolean;
  onToggle: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  onDragStart: (p: DragPayload) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (path: string) => void;
  onDrop: (e: React.DragEvent, path: string | null) => void;
}) {
  const Icon = folderIcon(meta?.icon);
  // A logo file that will not load falls back to the icon.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const logo = meta?.logo && meta.logo !== failedLogo ? meta.logo : null;
  const color = folderColorVar(meta?.color);
  return (
    <button
      type="button"
      draggable
      data-testid={`folder-${path}`}
      aria-expanded={!collapsed}
      style={{ paddingLeft: `${4 + indent * 12}px`, boxShadow: dropActive ? `inset 0 0 0 2px ${color ?? 'hsl(var(--ring))'}` : undefined }}
      onDragStart={(e) => {
        e.stopPropagation();
        const payload = { kind: 'folder', path } as const;
        e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag(payload));
        onDragStart(payload);
      }}
      data-drop-active={dropActive ? 'true' : undefined}
      onDragOver={(e) => onDragOver(e, path)}
      onDragLeave={() => onDragLeave(path)}
      onDrop={(e) => onDrop(e, path)}
      onClick={() => onToggle(path)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(path, e.clientX, e.clientY); }}
      className="flex w-full items-center gap-1 rounded py-1 pr-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
    >
      <span data-folder-stripe className="mr-0.5 h-3.5 w-0.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? 'transparent' }} />
      {collapsed ? <ChevronRight size={12} className="shrink-0" aria-hidden="true" /> : <ChevronDown size={12} className="shrink-0" aria-hidden="true" />}
      {logo
        ? <img data-folder-logo src={logoUrl(logo)} alt="" draggable={false} onError={() => setFailedLogo(logo)} className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
        : <Icon size={12} data-folder-icon={meta?.icon ?? 'folder'} className="shrink-0" style={color ? { color } : undefined} aria-hidden="true" />}
      <span className="flex-1 truncate">{folderName(path)}</span>
      {collapsed && count > 0 && (
        <span className="text-[9px] font-normal normal-case tracking-normal" style={color ? { color } : undefined}>{count}</span>
      )}
    </button>
  );
}
