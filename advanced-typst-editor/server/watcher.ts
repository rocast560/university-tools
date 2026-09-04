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
/** `at`: when we marked the write. `mtime`: the resulting mtime once we've seen
 * the first echo for it (ms, rounded); null until then. */
interface OwnMark { at: number; mtime: number | null }

const IGNORED = /(^|\/)(\.git|node_modules|\.[^/]*|.*\.tmp)(\/|$)/;

const ownKey = (id: string, rel: string): string => `${id}\0${rel.replace(/\\/g, '/')}`;

export function createWatcher(deps: { bus: EventBus; now?: () => number; debounceMs?: number; ownWriteWindowMs?: number }): Watcher {
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? 200;
  const windowMs = deps.ownWriteWindowMs ?? 1500;
  const entries = new Map<string, Entry>();
  // `${id}\0${rel}` -> mark. All expiry is driven by `now()` alone (never by a
  // timer), so an injected fake clock and the map agree on what's expired.
  const own = new Map<string, OwnMark>();

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
    const key = ownKey(id, rel);
    const mark = own.get(key);
    if (mark !== undefined) {
      if (now() - mark.at >= windowMs) {
        own.delete(key); // stale mark past its window; treat this event as real
      } else {
        let st: fs.Stats | null;
        try { st = fs.statSync(path.join(e.root, ...rel.split('/'))); } catch { st = null; }
        if (st === null) {
          own.delete(key); // file is gone; that's a real change (e.g. a delete)
        } else {
          const mtime = Math.round(st.mtimeMs);
          if (mark.mtime === null) {
            // First event after our write: this is the echo. Remember the
            // resulting mtime so a duplicate raw fs notification for the same
            // write (content vs. metadata, common on Windows) is recognised
            // and suppressed too, without needing a settle timer.
            mark.mtime = mtime;
            return;
          }
          if (mtime === mark.mtime) return; // duplicate echo of the same write
          own.delete(key); // the file changed again after our write; real change
        }
      }
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
      // Also covers the temp file writeAtomic creates next to it: the rename
      // back to `rel` is the event this mark matches.
      own.set(ownKey(id, rel), { at: now(), mtime: null });
      if (own.size > 5000) for (const [k, m] of own) if (now() - m.at > windowMs) own.delete(k);
    },
    close() {
      for (const id of [...entries.keys()]) this.unwatch(id);
      own.clear();
    },
  };
}
