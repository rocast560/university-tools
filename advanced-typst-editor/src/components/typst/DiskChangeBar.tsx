import { RefreshCw } from 'lucide-react';

export function DiskChangeBar({ file, onReload, onKeep }: { file: string; onReload: () => void; onKeep: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--status-amber))]/40 bg-[hsl(var(--status-amber))]/10 px-3 py-1.5 text-xs text-[hsl(var(--foreground))]">
      <RefreshCw size={13} className="text-[hsl(var(--status-amber))]" />
      <span className="min-w-0 flex-1 truncate"><b>{file}</b> changed on disk while you have unsaved edits.</span>
      <button type="button" onClick={onReload} className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 hover:bg-[hsl(var(--accent))]">Reload from disk</button>
      <button type="button" onClick={onKeep} className="rounded-md bg-[hsl(var(--primary))] px-2 py-0.5 text-[hsl(var(--primary-foreground))]">Keep mine</button>
    </div>
  );
}
