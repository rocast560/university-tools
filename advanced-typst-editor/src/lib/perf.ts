// ─────────────────────────────────────────────────────────────────────────
// Switch tracing: how long a sidebar click takes to become a painted page.
//
// One trace per `selectWorkspace`. The store, the file hook, the asset sync
// and the preview each drop a mark as their stage completes; the first mark
// of each name wins. Traces stay on `window.__tfsPerf` (last 20) so they can
// be read from the console, and are logged as one line in dev or when
// `localStorage['tfs-perf']` is '1'.
// ─────────────────────────────────────────────────────────────────────────

export type SwitchMark = 'detail' | 'source' | 'assets' | 'compile' | 'compiled' | 'painted';

export interface SwitchTrace {
  id: string;
  startedAt: number;
  /** Milliseconds after the click, by stage. */
  marks: Partial<Record<SwitchMark, number>>;
  done: boolean;
}

const KEEP = 20;
const traces: SwitchTrace[] = [];
let current: SwitchTrace | null = null;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function enabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('tfs-perf') === '1') return true;
  } catch { /* no storage */ }
  return typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;
}

function expose(): void {
  if (typeof window !== 'undefined') (window as unknown as { __tfsPerf: SwitchTrace[] }).__tfsPerf = traces;
}

export const switchTrace = {
  /** A new switch began; earlier marks no longer apply. */
  start(id: string): SwitchTrace {
    current = { id, startedAt: now(), marks: {}, done: false };
    traces.push(current);
    if (traces.length > KEEP) traces.splice(0, traces.length - KEEP);
    expose();
    return current;
  },
  /** Record a stage for the switch in progress; ignored when none is or the stage already landed. */
  mark(name: SwitchMark): void {
    const t = current;
    if (!t || t.done || name in t.marks) return;
    t.marks[name] = Math.round((now() - t.startedAt) * 10) / 10;
    if (name === 'painted') {
      t.done = true;
      if (enabled()) console.info(`[perf] switch ${t.id}`, t.marks);
    }
  },
  current: (): SwitchTrace | null => current,
  all: (): readonly SwitchTrace[] => traces,
  /** Tests only. */
  reset(): void { traces.length = 0; current = null; },
};
