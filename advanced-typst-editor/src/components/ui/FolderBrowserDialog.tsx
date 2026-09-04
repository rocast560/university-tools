import { useEffect, useState } from 'react';
import { ChevronRight, Folder, HardDrive, X } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { DirListing } from '@/types';
import { Portal } from './Portal';

export function FolderBrowserDialog({ title, confirmLabel = 'Use this folder', onPick, onClose }: { title: string; confirmLabel?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = async (p: string) => {
    try { const l = await api.browse(p); setListing(l); setInput(l.path); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  useEffect(() => { void go(''); }, []);
  const crumbs = listing?.path ? listing.path.split(/[\\/]/).filter(Boolean) : [];
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="flex h-[70vh] w-[640px] flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--popover))] shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
            <span className="text-sm font-semibold">{title}</span>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
          </div>
          <form className="flex gap-2 border-b border-[hsl(var(--border))] px-4 py-2" onSubmit={(e) => { e.preventDefault(); void go(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type or paste a path, e.g. D:\Backups\typst" className="min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
            <button type="submit" className="rounded-md border border-[hsl(var(--border))] px-2 py-1 text-xs hover:bg-[hsl(var(--accent))]">Go</button>
          </form>
          <div className="flex flex-wrap items-center gap-1 px-4 py-1 text-[11px] text-[hsl(var(--muted-foreground))]">
            <button type="button" onClick={() => void go('')} className="hover:underline">Drives</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1"><ChevronRight size={11} /><button type="button" className="hover:underline" onClick={() => void go(crumbs.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : ''))}>{c}</button></span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2">
            {listing?.entries.map((e) => (
              <button key={e.path} type="button" onDoubleClick={() => void go(e.path)} onClick={() => setInput(e.path)} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${input === e.path ? 'bg-[hsl(var(--accent))]' : ''}`}>
                {listing.path ? <Folder size={13} /> : <HardDrive size={13} />}
                <span className="flex-1 truncate">{e.name}</span>
                {e.isBackupRoot && <span className="rounded bg-[hsl(var(--status-green))]/20 px-1 text-[10px]">backup</span>}
                {!e.isBackupRoot && listing.path && !e.isEmpty && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">has files</span>}
              </button>
            ))}
            {listing && listing.entries.length === 0 && <div className="px-2 py-4 text-xs text-[hsl(var(--muted-foreground))]">No subfolders.</div>}
          </div>
          {error && <div className="px-4 py-1 text-xs text-[hsl(var(--status-red))]">{error}</div>}
          <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--border))] px-4 py-2">
            <span className="mr-auto truncate text-[11px] text-[hsl(var(--muted-foreground))]">{input || 'nothing selected'}</span>
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xs hover:bg-[hsl(var(--accent))]">Cancel</button>
            <button type="button" disabled={!input} onClick={() => onPick(input)} className="rounded-md bg-[hsl(var(--primary))] px-3 py-1 text-xs text-[hsl(var(--primary-foreground))] disabled:opacity-40">{confirmLabel}</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
