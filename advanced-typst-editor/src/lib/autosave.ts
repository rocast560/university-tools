/** Debounced save with a single in-flight write; edits during a save stay pending. */
export function createAutosave(opts: { delayMs: number; save: (text: string) => Promise<void> }) {
  let pending: string | null = null;
  let saving: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    if (saving) { await saving; }
    if (pending === null) return;
    const text = pending;
    pending = null;
    saving = opts.save(text).catch((err) => { if (pending === null) pending = text; throw err; }).finally(() => { saving = null; });
    await saving;
  };
  return {
    change(text: string) {
      pending = text;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run().catch(() => {}); }, opts.delayMs);
    },
    async flush() { if (timer) { clearTimeout(timer); timer = null; } await run(); },
    dirty: () => pending !== null || saving !== null,
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}
