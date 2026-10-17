import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { logoUrl } from '@/api/client';
import { FOLDER_COLORS, FOLDER_ICON_NAMES, folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import { LOGO_TYPES, logoTypeError } from '@/lib/logo';
import type { FolderMeta } from '@/types';

const ACCEPT = Object.keys(LOGO_TYPES).join(',');

/**
 * Colour swatches, the icon grid and a logo upload for one sidebar row, a
 * folder or a document. Every choice applies at once -- there is nothing to
 * confirm, and picking again is the undo. A logo shows instead of an icon; it
 * is only ever unlinked here, the image file stays in data/logos.
 */
export function FolderAppearance({ meta, x, y, onPick, onUploadLogo, onClose }: {
  meta: FolderMeta | undefined;
  x: number;
  y: number;
  onPick: (patch: FolderMeta) => void;
  /** Stores the image and resolves to its file name; rejects with the server's message. */
  onUploadLogo: (file: File) => Promise<string>;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    // The same rules the server enforces, so a bad file is refused without a round trip.
    const problem = logoTypeError(file.type, file.size);
    if (problem) { setError(problem); return; }
    setError(null);
    setBusy(true);
    try { onPick({ logo: await onUploadLogo(file) }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

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
        <div className="mb-2 grid max-h-40 grid-cols-8 gap-0.5 overflow-auto">
          {FOLDER_ICON_NAMES.map((name) => {
            const Icon = folderIcon(name);
            return (
              // A logo outranks an icon, so choosing an icon lets go of the logo or the choice would not show.
              <button key={name} type="button" title={name} onClick={() => onPick(meta?.logo ? { icon: name, logo: null } : { icon: name })}
                className={`flex h-6 w-6 items-center justify-center rounded hover:bg-[hsl(var(--accent))] ${!meta?.logo && meta?.icon === name ? 'bg-[hsl(var(--accent))] ring-1 ring-[hsl(var(--ring))]' : ''}`}>
                <Icon size={13} style={folderColorVar(meta?.color) ? { color: folderColorVar(meta?.color)! } : undefined} />
              </button>
            );
          })}
        </div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Logo</div>
        <div className="flex items-center gap-2">
          {meta?.logo && <img data-testid="logo-preview" src={logoUrl(meta.logo)} alt="Current logo" className="h-8 w-8 shrink-0 rounded border border-[hsl(var(--border))] object-contain p-0.5" />}
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 rounded border border-[hsl(var(--border))] px-2 py-1 hover:bg-[hsl(var(--accent))] disabled:opacity-60">
            <ImagePlus size={12} aria-hidden="true" />{busy ? 'Uploading…' : 'Upload image…'}
          </button>
          {meta?.logo && (
            <button type="button" onClick={() => { setError(null); onPick({ logo: null }); }} className="rounded px-1 py-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]">Remove logo</button>
          )}
        </div>
        <input ref={fileRef} type="file" accept={ACCEPT} hidden data-testid="logo-file"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
        <div className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">PNG, JPEG, WebP or SVG, up to 512 KB.</div>
        {error && <div role="alert" className="mt-1 text-[11px] text-[hsl(var(--status-red))]">{error}</div>}
      </div>
    </div>
  );
}
