/**
 * Debounced save with a single in-flight write; edits during a save stay pending.
 *
 * `flush(keepalive)` rides down to `save` so the caller can say the page is going
 * away: only the pagehide flush passes `true`, and only that save needs to
 * outlive the document. The debounced path and a plain `flush()` pass nothing,
 * which the save closure reads as "an ordinary request".
 */
export function createAutosave(opts: { delayMs: number; save: (text: string, keepalive?: boolean) => Promise<void> }) {
  let pending: string | null = null;
  let saving: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (keepalive?: boolean): Promise<void> => {
    if (saving) { await saving; }
    if (pending === null) return;
    const text = pending;
    pending = null;
    saving = opts.save(text, keepalive).catch((err) => { if (pending === null) pending = text; throw err; }).finally(() => { saving = null; });
    await saving;
  };
  return {
    change(text: string) {
      pending = text;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run().catch(() => {}); }, opts.delayMs);
    },
    async flush(keepalive?: boolean) { if (timer) { clearTimeout(timer); timer = null; } await run(keepalive); },
    dirty: () => pending !== null || saving !== null,
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}
