import { FOLDER_COLORS, FOLDER_ICON_NAMES, folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import type { FolderMeta } from '@/types';

/**
 * Colour swatches and the icon grid for one folder. Every choice applies at
 * once -- there is nothing to confirm, and picking again is the undo.
 */
export function FolderAppearance({ meta, x, y, onPick, onClose }: {
  meta: FolderMeta | undefined;
  x: number;
  y: number;
  onPick: (patch: FolderMeta) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className="absolute w-56 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-2 text-xs shadow-lg"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Colour</div>
        <div className="mb-2 flex flex-wrap gap-1">
          <button type="button" title="no colour" onClick={() => onPick({ color: null })}
            className={`h-5 w-5 rounded-full border border-[hsl(var(--border))] ${!meta?.color ? 'ring-2 ring-[hsl(var(--ring))]' : ''}`} />
          {FOLDER_COLORS.map((c) => (
            <button key={c} type="button" title={c} onClick={() => onPick({ color: c })}
              style={{ backgroundColor: folderColorVar(c)! }}
              className={`h-5 w-5 rounded-full ${meta?.color === c ? 'ring-2 ring-[hsl(var(--ring))]' : ''}`} />
          ))}
        </div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Icon</div>
        <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-auto">
          {FOLDER_ICON_NAMES.map((name) => {
            const Icon = folderIcon(name);
            return (
              <button key={name} type="button" title={name} onClick={() => onPick({ icon: name })}
                className={`flex h-6 w-6 items-center justify-center rounded hover:bg-[hsl(var(--accent))] ${meta?.icon === name ? 'bg-[hsl(var(--accent))] ring-1 ring-[hsl(var(--ring))]' : ''}`}>
                <Icon size={13} style={folderColorVar(meta?.color) ? { color: folderColorVar(meta?.color)! } : undefined} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
