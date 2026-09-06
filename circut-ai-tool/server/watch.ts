// A tiny event bus and a debounced file watcher. The watcher observes the
// directory (KiCad may replace the file rather than rewrite it) and only
// reports changes to the named file. With `pollMs` it polls instead, for
// mounts that never emit inotify events.

import { statSync, watch } from 'node:fs';
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

export interface WatchOptions {
  /** Quiet time after the last change before onChange fires. */
  debounceMs?: number;
  /**
   * When > 0, poll the file's mtime and size every pollMs instead of using
   * fs.watch. Needed where inotify never fires, such as Docker Desktop bind
   * mounts of Windows folders.
   */
  pollMs?: number;
}

export function watchFile(file: string, onChange: () => void, opts: number | WatchOptions = {}): () => void {
  const { debounceMs = 300, pollMs = 0 } = typeof opts === 'number' ? { debounceMs: opts } : opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  if (pollMs > 0) {
    // One stat per interval; "missing" is a state too, so a delete-and-recreate
    // (KiCad's save strategy) counts as a change on both transitions. ctimeMs is
    // included so a same-size save within the same mtime tick (1s granularity on
    // some bind mounts) still changes the key.
    const snapshot = (): string => {
      try {
        const s = statSync(file);
        return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      } catch {
        return 'missing';
      }
    };
    let last = snapshot();
    const poll = setInterval(() => {
      const now = snapshot();
      if (now !== last) fire();
      last = now;
    }, pollMs);
    poll.unref?.(); // like persistent: false above: never keep the process alive
    return () => {
      stopTimer();
      clearInterval(poll);
    };
  }

  const dir = path.dirname(file);
  const base = path.basename(file);
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && String(filename) !== base) return;
    fire();
  });
  return () => {
    stopTimer();
    watcher.close();
  };
}
