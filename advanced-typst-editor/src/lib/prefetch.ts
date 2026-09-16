// ─────────────────────────────────────────────────────────────────────────
// Prefetch: warm the caches for workspaces the user is likely to click.
//
// Two triggers. Hovering a sidebar row for a moment (intent, not a pass-by)
// prefetches that workspace; and once the app is idle after start-up, every
// other workspace is prefetched one at a time, most recently opened first,
// under a count and byte budget. Prefetch fills exactly the caches a real
// switch reads (detail, document text, asset and plain-file bytes) and never
// touches the compiler: its font and shadow state belongs to the document
// on screen.
// ─────────────────────────────────────────────────────────────────────────

import { api } from '@/api/client';
import type { WorkspaceStatus } from '@/types';
import { collectMounts, defaultTypFile } from './typst-mount';
import { detailCache, docKeyOf, textCache } from './workspace-cache';

/** How long a pointer must rest on a row before it counts as intent. */
export const HOVER_INTENT_MS = 80;
/** Idle prefetch stops after this many workspaces… */
export const IDLE_MAX_WORKSPACES = 20;
/** …or once this many asset bytes have been pulled in. */
export const IDLE_MAX_BYTES = 64 * 1024 * 1024;
/** When the browser offers no idle callback, wait this long after start-up instead. */
export const IDLE_FALLBACK_MS = 2000;

const inflight = new Map<string, Promise<number>>();

/**
 * Warm every cache a switch to `id` would read. Resolves to the number of
 * asset and plain-file bytes now resident for it. One prefetch per workspace
 * runs at a time; a second call while one is in flight shares it.
 */
export function prefetchWorkspace(id: string): Promise<number> {
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    let detail = detailCache.get(id);
    if (!detail) {
      const fresh = await api.getWorkspace(id);
      if (!fresh) return 0;
      // A switch may have cached it meanwhile; keep whichever landed first.
      detail = detailCache.get(id) ?? fresh;
      detailCache.set(id, detail);
    }
    const main = defaultTypFile(detail.files);
    const key = docKeyOf(id, main);
    if (!textCache.has(key)) {
      try {
        const r = await api.readText(id, main);
        if (r && !textCache.has(key)) textCache.set(key, { text: r.text, etag: r.etag });
      } catch { /* a workspace without its main file: the tab shows that itself */ }
    }
    const mounts = await collectMounts(id, detail.assets, detail.files, main);
    return mounts.bytes;
  })().finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

// ── hover intent ─────────────────────────────────────────────────────────

let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/** The pointer entered a workspace row: prefetch it if it stays there. */
export function hoverPrefetch(id: string): void {
  cancelHoverPrefetch();
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    void prefetchWorkspace(id).catch(() => { /* retried on the next hover or click */ });
  }, HOVER_INTENT_MS);
}

export function cancelHoverPrefetch(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
}

// ── idle sweep ───────────────────────────────────────────────────────────

type IdleFn = (cb: () => void) => void;

function whenIdle(cb: () => void): void {
  const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(cb, { timeout: IDLE_FALLBACK_MS * 2 });
  else setTimeout(cb, IDLE_FALLBACK_MS);
}

/**
 * The order the idle sweep visits workspaces: the ones opened most recently
 * first, skipping the active one and anything whose folder is missing, capped.
 */
export function idlePrefetchOrder(workspaces: readonly WorkspaceStatus[], activeId: string | null): string[] {
  return workspaces
    .filter((w) => w.status === 'ok' && w.id !== activeId)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, IDLE_MAX_WORKSPACES)
    .map((w) => w.id);
}

/**
 * Prefetch every other workspace while the browser is idle, one at a time,
 * yielding back to idle time between them. Stops at the byte budget. Returns
 * a function that cancels whatever has not started yet.
 */
export function schedulePrefetchAll(
  getWorkspaces: () => readonly WorkspaceStatus[],
  getActiveId: () => string | null,
  opts: { idle?: IdleFn; maxBytes?: number } = {},
): () => void {
  const idle = opts.idle ?? whenIdle;
  const maxBytes = opts.maxBytes ?? IDLE_MAX_BYTES;
  let cancelled = false;
  let bytes = 0;
  let queue: string[] | null = null;
  const step = () => {
    if (cancelled) return;
    queue ??= idlePrefetchOrder(getWorkspaces(), getActiveId());
    const next = queue.shift();
    if (!next || bytes >= maxBytes) return;
    void prefetchWorkspace(next)
      .then((n) => { bytes += n; }, () => { /* skip it */ })
      .then(() => { if (!cancelled) idle(step); });
  };
  idle(step);
  return () => { cancelled = true; };
}
