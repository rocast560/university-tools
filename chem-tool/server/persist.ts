// workspace.json: load on start, debounced atomic save on change.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../src/chem/types';

export async function loadWorkspace(file: string): Promise<Workspace | null> {
  try {
    const ws = JSON.parse(await readFile(file, 'utf8')) as Workspace;
    if (typeof ws.version !== 'number' || !Array.isArray(ws.scenes) || ws.scenes.length === 0) return null;
    return ws;
  } catch {
    return null;
  }
}

export function createSaver(file: string, delayMs = 250): { save(ws: Workspace): void; flush(): Promise<void> } {
  let pending: Workspace | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = async () => {
    timer = null;
    const ws = pending;
    pending = null;
    if (!ws) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(ws));
      await rename(file + '.tmp', file);
    } catch (err) {
      console.error('workspace save failed:', err);
    }
  };

  const enqueue = (): Promise<void> => {
    writing = writing.then(write, write);
    return writing;
  };

  return {
    save(ws) {
      pending = ws;
      if (!timer) timer = setTimeout(() => { void enqueue(); }, delayMs);
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await enqueue();
    },
  };
}
