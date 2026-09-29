import { describe, expect, test } from 'bun:test';
import { History, type Command } from '../client/editor3d/history.ts';

function counter() {
  const log: string[] = [];
  let value = 0;
  const cmd = (by: number, ok = true): Command => ({
    label: `add ${by}`,
    async run() {
      if (!ok) return false;
      value += by;
      log.push(`+${by}`);
      return true;
    },
    async undo() {
      value -= by;
      log.push(`-${by}`);
      return true;
    },
  });
  return { cmd, log, get value() { return value; } };
}

describe('History', () => {
  test('undo and redo walk the same steps back and forth', async () => {
    const h = new History();
    const c = counter();
    await h.execute(c.cmd(1));
    await h.execute(c.cmd(2));
    expect(c.value).toBe(3);
    await h.undo();
    expect(c.value).toBe(1);
    await h.redo();
    expect(c.value).toBe(3);
    expect(c.log).toEqual(['+1', '+2', '-2', '+2']);
  });

  test('a new command clears what could have been redone', async () => {
    const h = new History();
    const c = counter();
    await h.execute(c.cmd(1));
    await h.undo();
    expect(h.canRedo).toBe(true);
    await h.execute(c.cmd(5));
    expect(h.canRedo).toBe(false);
  });

  test('a failed run is not recorded', async () => {
    const h = new History();
    const c = counter();
    expect(await h.execute(c.cmd(1, false))).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  test('undo with nothing to undo is a no-op that says so', async () => {
    expect(await new History().undo()).toBe(false);
  });

  test('listeners hear every change', async () => {
    const h = new History();
    let n = 0;
    h.onChange(() => n++);
    await h.execute(counter().cmd(1));
    await h.undo();
    expect(n).toBe(2);
  });
});
