import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from './events';

export interface Watcher {
  watch(id: string, root: string): void;
  unwatch(id: string): void;
  /** Call right before the server writes `rel` itself, so the resulting fs event is ignored. */
  markOwnWrite(id: string, rel: string): void;
  close(): void;
}

interface Entry { root: string; handle: fs.FSWatcher | null; pending: Set<string>; timer: ReturnType<typeof setTimeout> | null }

const IGNORED = /(^|\/)(\.git|node_modules|\.[^/]*|.*\.tmp)(\/|$)/;

export function createWatcher(deps: { bus: EventBus; now?: () => number; debounceMs?: number; ownWriteWindowMs?: number }): Watcher {
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? 200;
  const windowMs = deps.ownWriteWindowMs ?? 1500;
  const entries = new Map<string, Entry>();
  // `${id}\0${rel}` -> { at: marked at, timer: settle timer clearing the mark }.
  // A single own write can surface as more than one raw fs event (e.g. a
  // separate notification for content vs. metadata on Windows); `settleMs`
  // absorbs a short burst of such duplicates without leaving the mark alive
  // long enough to swallow a later, genuine edit to the same path.
  const own = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const settleMs = Math.min(debounceMs, windowMs);

  const flush = (id: string) => {
    const e = entries.get(id);
    if (!e) return;
    e.timer = null;
    const paths = [...e.pending];
    e.pending.clear();
    // R1: fs.watch recursive on Windows reports directory creation (e.g. a new
    // "assets" folder) as an event; a directory is not a file change, so drop
    // any pending path that currently resolves to a directory. A stat failure
    // means the entry vanished (e.g. a deleted file) -- keep it as a change.
    const files = paths.filter((rel) => {
      try { return !fs.statSync(path.join(e.root, ...rel.split('/'))).isDirectory(); } catch { return true; }
    });
    if (files.length) deps.bus.emit({ type: 'workspace.changed', id, paths: files, origin: 'disk' });
  };

  const onChange = (id: string, filename: string | Buffer | null) => {
    const e = entries.get(id);
    if (!e || !filename) return;
    const rel = String(filename).replace(/\\/g, '/');
    if (IGNORED.test(rel)) return;
    const key = `${id}\0${rel}`;
    const mark = own.get(key);
    if (mark !== undefined) {
      clearTimeout(mark.timer);
      if (now() - mark.at < windowMs) {
        // Our own write echoing back. Keep the mark alive for a brief settle
        // window in case the same write surfaces a second raw fs event, but
        // let it expire quickly so a later genuine edit to this path is not
        // mistaken for another echo.
        mark.timer = setTimeout(() => own.delete(key), settleMs);
        return;
      }
      own.delete(key); // stale mark past its window; treat this event as real
    }
    e.pending.add(rel);
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => flush(id), debounceMs);
  };

  return {
    watch(id, root) {
      if (entries.has(id)) return;
      const e: Entry = { root: path.resolve(root), handle: null, pending: new Set(), timer: null };
      try {
        e.handle = fs.watch(e.root, { recursive: true }, (_ev, filename) => onChange(id, filename));
        e.handle.on('error', () => { /* folder vanished; the registry reports it as missing */ });
      } catch {
        e.handle = null;
      }
      entries.set(id, e);
    },
    unwatch(id) {
      const e = entries.get(id);
      if (!e) return;
      if (e.timer) clearTimeout(e.timer);
      e.handle?.close();
      entries.delete(id);
    },
    markOwnWrite(id, rel) {
      const key = `${id}\0${rel.replace(/\\/g, '/')}`;
      const existing = own.get(key);
      if (existing) clearTimeout(existing.timer);
      // Also cover the temp file writeAtomic creates next to it.
      own.set(key, { at: now(), timer: setTimeout(() => own.delete(key), windowMs) });
      if (own.size > 5000) for (const [k, m] of own) if (now() - m.at > windowMs) { clearTimeout(m.timer); own.delete(k); }
    },
    close() {
      for (const id of [...entries.keys()]) this.unwatch(id);
      for (const [k, m] of own) { clearTimeout(m.timer); own.delete(k); }
    },
  };
}
