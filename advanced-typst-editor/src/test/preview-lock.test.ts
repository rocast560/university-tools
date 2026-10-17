import { describe, it, expect } from 'vitest';
import {
  PREVIEW_LOCK_KEY, isLocked, loadPreviewLock, savePreviewLock, setAllLocked, toggleWorkspaceLock, type PreviewLock,
} from '@/lib/preview-lock';

function memoryStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(PREVIEW_LOCK_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  } as unknown as Storage;
}

const open: PreviewLock = { all: false, overrides: {} };

describe('preview lock persistence', () => {
  it('loads as unlocked when nothing is stored or storage is missing', () => {
    expect(loadPreviewLock(memoryStorage())).toEqual(open);
    expect(loadPreviewLock(null)).toEqual(open);
  });

  it('falls back to unlocked on garbage or wrong shapes', () => {
    expect(loadPreviewLock(memoryStorage('{not json'))).toEqual(open);
    expect(loadPreviewLock(memoryStorage('[1,2]'))).toEqual(open);
    expect(loadPreviewLock(memoryStorage('{"all":"yes","overrides":5}'))).toEqual(open);
  });

  it('drops non-boolean override values', () => {
    const raw = JSON.stringify({ all: true, overrides: { a: false, b: 'x', c: 1, d: true } });
    expect(loadPreviewLock(memoryStorage(raw))).toEqual({ all: true, overrides: { a: false, d: true } });
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const lock: PreviewLock = { all: true, overrides: { w1: false } };
    savePreviewLock(lock, storage);
    expect(loadPreviewLock(storage)).toEqual(lock);
  });

  it('does not throw when storage does', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(loadPreviewLock(broken)).toEqual(open);
    expect(() => savePreviewLock(open, broken)).not.toThrow();
  });
});

describe('preview lock logic', () => {
  it('an override beats the global flag, which is the fallback', () => {
    expect(isLocked({ all: false, overrides: {} }, 'a')).toBe(false);
    expect(isLocked({ all: true, overrides: {} }, 'a')).toBe(true);
    expect(isLocked({ all: true, overrides: { a: false } }, 'a')).toBe(false);
    expect(isLocked({ all: false, overrides: { a: true } }, 'a')).toBe(true);
    expect(isLocked({ all: false, overrides: { a: true } }, 'b')).toBe(false);
  });

  it('toggling while all is false locks one document and toggling again tidies the override away', () => {
    const locked = toggleWorkspaceLock(open, 'a');
    expect(locked).toEqual({ all: false, overrides: { a: true } });
    expect(toggleWorkspaceLock(locked, 'a')).toEqual(open);
  });

  it('toggling while all is true unlocks one document and toggling again tidies the override away', () => {
    const all: PreviewLock = { all: true, overrides: {} };
    const unlocked = toggleWorkspaceLock(all, 'a');
    expect(unlocked).toEqual({ all: true, overrides: { a: false } });
    expect(isLocked(unlocked, 'b')).toBe(true);
    expect(toggleWorkspaceLock(unlocked, 'a')).toEqual(all);
  });

  it('does not mutate its input', () => {
    const lock: PreviewLock = { all: false, overrides: {} };
    toggleWorkspaceLock(lock, 'a');
    expect(lock).toEqual({ all: false, overrides: {} });
  });

  it('setAllLocked sets the flag and clears every override', () => {
    const mixed: PreviewLock = { all: false, overrides: { a: true, b: false } };
    expect(setAllLocked(mixed, true)).toEqual({ all: true, overrides: {} });
    expect(setAllLocked({ all: true, overrides: { a: false } }, false)).toEqual(open);
  });
});
