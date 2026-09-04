// A tiny event bus and a debounced file watcher. The watcher observes the
// directory (KiCad may replace the file rather than rewrite it) and only
// reports changes to the named file.

import { watch } from 'node:fs';
import path from 'node:path';

export class Events<T> {
  private subs = new Set<(ev: T) => void>();

  subscribe(fn: (ev: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: T) {
    for (const fn of [...this.subs]) {
      try {
        fn(ev);
      } catch {
        /* a bad subscriber must not break the others */
      }
    }
  }
}

export function watchFile(file: string, onChange: () => void, debounceMs = 300): () => void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && String(filename) !== base) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
