import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A labelled, selectable line of text with a copy button. The button shows
 * a check mark for a moment after a successful copy; if the clipboard is
 * blocked, the text stays selectable so it can still be copied by hand.
 */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is selectable */ }
  };

  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-2 py-1.5">
        <pre className="min-w-0 flex-1 select-all overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{value}</pre>
        <button type="button" aria-label={`Copy ${label}`} title="Copy" onClick={() => void copy()} className="shrink-0 rounded p-1 hover:bg-[hsl(var(--accent))]">
          {copied ? <Check size={12} className="text-[hsl(var(--status-green))]" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}
