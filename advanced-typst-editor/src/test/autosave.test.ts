import { describe, it, expect, vi } from 'vitest';
import { createAutosave } from '@/lib/autosave';

describe('autosave', () => {
  it('saves once after the quiet period and reports dirty state', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_t: string) => {});
    const a = createAutosave({ delayMs: 500, save });
    a.change('a'); a.change('ab'); a.change('abc');
    expect(a.dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    expect(a.dirty()).toBe(false);
    vi.useRealTimers();
  });
  it('flush saves immediately and coalesces with an in-flight save', async () => {
    let resolveSave: (() => void) | null = null;
    const save = vi.fn(() => new Promise<void>((r) => { resolveSave = r; }));
    const a = createAutosave({ delayMs: 10_000, save });
    a.change('x');
    const f = a.flush();
    expect(save).toHaveBeenCalledWith('x');
    a.change('xy'); // edited while saving
    resolveSave!();
    await f;
    expect(a.dirty()).toBe(true); // the edit made during the save is still pending
    const f2 = a.flush(); // triggers the second save('xy'), which is also manually resolved
    resolveSave!();
    await f2;
    expect(save).toHaveBeenLastCalledWith('xy');
    expect(a.dirty()).toBe(false);
  });
  it('keeps dirty when a save fails', async () => {
    const save = vi.fn(async () => { throw new Error('offline'); });
    const a = createAutosave({ delayMs: 1, save });
    a.change('x');
    await a.flush().catch(() => {});
    expect(a.dirty()).toBe(true);
  });
});
