import { useState } from 'react';
import { FileText, Files, Trash2, X } from 'lucide-react';
import { api } from '@/api/client';
import { formatBytes, timeAgo } from '@/lib/trash-format';
import type { TrashEntry, TrashRestoreResult } from '@/types';
import { Portal } from './Portal';

/**
 * The app trash: what was deleted, with a Restore button each. Restore moves the
 * item back out and never overwrites; there is deliberately no other action here
 * (no emptying, no permanent delete).
 */
export function TrashDialog({ items, onRestored, onClose }: {
  /** Null while the first load is running. */
  items: TrashEntry[] | null;
  onRestored: (id: string, result: TrashRestoreResult) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (item: TrashEntry) => {
    setBusy(item.id);
    setError(null);
    try {
      const result = await api.restoreTrash(item.id);
      setStatus(result.message);
      onRestored(item.id, result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Trash"
          className="flex max-h-[70vh] w-full max-w-lg flex-col pop-shadow rounded-2xl bg-[hsl(var(--card))] p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <Trash2 size={16} />
            <span className="flex-1">Trash</span>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
            Documents and files you remove from the app wait here. Restoring puts one back and never overwrites anything: if its name is taken, it comes back as &quot;(restored)&quot;.
          </p>
          {status && <div role="status" className="mb-2 rounded-md bg-[hsl(var(--accent))] px-3 py-1.5 text-xs">{status}</div>}
          {error && <div role="alert" className="mb-2 rounded-md px-3 py-1.5 text-xs text-[hsl(var(--status-red))]">{error}</div>}
          <div className="min-h-0 flex-1 overflow-auto">
            {items === null && <div className="px-1 py-4 text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>}
            {items?.length === 0 && <div className="px-1 py-4 text-xs text-[hsl(var(--muted-foreground))]">Nothing in the trash.</div>}
            <ul className="space-y-1">
              {items?.map((item) => (
                <li key={item.id} data-testid={`trash-item-${item.id}`} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[hsl(var(--accent))]/50">
                  <span className="mt-0.5 shrink-0 text-[hsl(var(--muted-foreground))]" data-kind={item.kind}>
                    {item.kind === 'document' ? <FileText size={15} /> : <Files size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium" title={item.name}>{item.name}</div>
                    <div className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
                      {item.kind === 'files' && item.workspace ? `from ${item.workspace} · ` : ''}
                      {timeAgo(item.deletedAt)} · {formatBytes(item.size)}
                      {item.kind === 'document' || item.fileCount > 1 ? ` · ${item.fileCount} ${item.fileCount === 1 ? 'file' : 'files'}` : ''}
                    </div>
                    {!item.canRestore && item.reason && <div className="mt-0.5 text-[11px] text-[hsl(var(--status-red))]">{item.reason}</div>}
                  </div>
                  <button
                    type="button"
                    disabled={!item.canRestore || busy !== null}
                    title={item.canRestore ? undefined : item.reason ?? undefined}
                    onClick={() => void restore(item)}
                    className="shrink-0 rounded-lg border border-[hsl(var(--border))] px-3 py-1 text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Portal>
  );
}
