import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createWatcher } from './watcher';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) c(); for (const d of dirs.splice(0)) rmDir(d); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); }
}

describe('watcher', () => {
  it('reports external edits, coalesced, and suppresses its own writes', async () => {
    const d = tmpDir(); dirs.push(d);
    put(d, 'main.typ', 'a');
    const bus = createEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const w = createWatcher({ bus, debounceMs: 100 });
    closers.push(() => w.close());
    w.watch('ws1', d);
    await sleep(200);

    // Own write: marked first, then written => no event.
    w.markOwnWrite('ws1', 'main.typ');
    fs.writeFileSync(path.join(d, 'main.typ'), 'own');
    await sleep(400);
    expect(events).toEqual([]);

    // External edits to two files inside the debounce window => one event.
    fs.writeFileSync(path.join(d, 'main.typ'), 'ext');
    put(d, 'assets/x.png', 'img');
    await until(() => events.length >= 1);
    await sleep(200);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('workspace.changed');
    if (ev.type === 'workspace.changed') {
      expect(ev.id).toBe('ws1');
      expect(ev.origin).toBe('disk');
      expect(ev.paths.sort()).toEqual(['assets/x.png', 'main.typ']);
    }

    w.unwatch('ws1');
    fs.writeFileSync(path.join(d, 'main.typ'), 'after');
    await sleep(300);
    expect(events).toHaveLength(1);
  });
});
