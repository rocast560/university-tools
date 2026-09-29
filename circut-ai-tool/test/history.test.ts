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

  test('a slow execute and an overlapping undo run in order and leave consistent stacks', async () => {
    const h = new History();
    const c = counter();
    await h.execute(c.cmd(1));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Command = { label: 'slow', run: async () => (await gate, true), undo: async () => true };
    const pending = h.execute(slow);
    const undone = h.undo();
    release();
    await pending;
    await undone;
    // The undo ran after the execute, so it undid `slow`, and nothing else is left to redo but that.
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(true);
    await h.execute(c.cmd(9));
    expect(h.canRedo).toBe(false);
    expect(c.value).toBe(10);
  });

  test('clear during an in-flight execute keeps it off the new stack', async () => {
    const h = new History();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = h.execute({ label: 'slow', run: async () => (await gate, true), undo: async () => true });
    h.clear();
    release();
    await p;
    expect(h.canUndo).toBe(false);
  });
});
