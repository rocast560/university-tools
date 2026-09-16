import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceDetail, WorkspaceStatus } from '@/types';

const getWorkspace = vi.fn();
const readText = vi.fn();
vi.mock('@/api/client', () => ({
  api: { getWorkspace: (...a: unknown[]) => getWorkspace(...a), readText: (...a: unknown[]) => readText(...a) },
}));
const collectMounts = vi.fn();
vi.mock('@/lib/typst-mount', async () => {
  const real = await vi.importActual<typeof import('@/lib/typst-mount')>('@/lib/typst-mount');
  return { ...real, collectMounts: (...a: unknown[]) => collectMounts(...a) };
});

import { cancelHoverPrefetch, hoverPrefetch, idlePrefetchOrder, prefetchWorkspace, schedulePrefetchAll } from '@/lib/prefetch';
import { clearWorkspaceCaches, detailCache, textCache } from '@/lib/workspace-cache';

const detail = (id: string): WorkspaceDetail => ({
  entry: { id, name: id, path: `C:/${id}`, group: null, library: true, createdAt: 0, openedAt: 0 },
  files: [{ path: 'main.typ', size: 1, mtime: 1 }], meta: { version: 1, assets: {}, fonts: {} }, assets: [], folders: [], etag: 'e',
});
const ws = (id: string, openedAt: number, status: 'ok' | 'missing' = 'ok'): WorkspaceStatus =>
  ({ id, name: id, path: `C:/${id}`, group: null, library: true, createdAt: 0, openedAt, status });

beforeEach(() => {
  clearWorkspaceCaches();
  getWorkspace.mockReset().mockImplementation(async (id: string) => detail(id));
  readText.mockReset().mockResolvedValue({ text: '= doc', etag: '"t"' });
  collectMounts.mockReset().mockResolvedValue({ shadow: [], fonts: [], bytes: 100 });
});
afterEach(() => { cancelHoverPrefetch(); vi.useRealTimers(); });

describe('prefetchWorkspace', () => {
  it('fills the detail and text caches and warms the mounts, skipping what is already cached', async () => {
    expect(await prefetchWorkspace('a')).toBe(100);
    expect(detailCache.get('a')?.entry.id).toBe('a');
    expect(textCache.get('a:main.typ')).toEqual({ text: '= doc', etag: '"t"' });
    expect(collectMounts).toHaveBeenCalledWith('a', [], detail('a').files, 'main.typ');

    await prefetchWorkspace('a');
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(collectMounts).toHaveBeenCalledTimes(2); // cheap: the byte caches answer
  });

  it('shares one in-flight prefetch per workspace', async () => {
    const [x, y] = [prefetchWorkspace('b'), prefetchWorkspace('b')];
    expect(x).toBe(y);
    await x;
    expect(getWorkspace).toHaveBeenCalledTimes(1);
  });

  it('survives a workspace without a main file', async () => {
    readText.mockRejectedValue(new Error('404'));
    expect(await prefetchWorkspace('c')).toBe(100);
    expect(textCache.has('c:main.typ')).toBe(false);
  });
});

describe('hoverPrefetch', () => {
  it('waits for intent and cancels on leave', () => {
    vi.useFakeTimers();
    hoverPrefetch('a');
    vi.advanceTimersByTime(50);
    expect(getWorkspace).not.toHaveBeenCalled();
    cancelHoverPrefetch();
    vi.advanceTimersByTime(100);
    expect(getWorkspace).not.toHaveBeenCalled();
    hoverPrefetch('a');
    hoverPrefetch('b'); // moved on: only the row the pointer rests on counts
    vi.advanceTimersByTime(80);
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    expect(getWorkspace).toHaveBeenCalledWith('b');
  });
});

describe('idle sweep', () => {
  it('orders by most recently opened, skips the active and missing ones, and caps the count', () => {
    const list = [ws('old', 1), ws('active', 9), ws('new', 5), ws('gone', 7, 'missing'), ws('mid', 3)];
    expect(idlePrefetchOrder(list, 'active')).toEqual(['new', 'mid', 'old']);
    const many = Array.from({ length: 30 }, (_, i) => ws(`w${i}`, i));
    expect(idlePrefetchOrder(many, null)).toHaveLength(20);
  });

  it('prefetches one workspace per idle slot until the byte budget is spent', async () => {
    const idleQueue: Array<() => void> = [];
    const idle = (cb: () => void) => { idleQueue.push(cb); };
    const runIdle = async () => { const cb = idleQueue.shift(); cb?.(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
    collectMounts.mockResolvedValue({ shadow: [], fonts: [], bytes: 60 });
    const cancel = schedulePrefetchAll(() => [ws('a', 3), ws('b', 2), ws('c', 1)], () => null, { idle, maxBytes: 100 });
    expect(getWorkspace).not.toHaveBeenCalled();
    await runIdle();
    expect(getWorkspace).toHaveBeenCalledWith('a');
    await runIdle();
    expect(getWorkspace).toHaveBeenCalledWith('b');
    await runIdle(); // 120 bytes: over budget, c is never fetched
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    cancel();
  });

  it('stops when cancelled', async () => {
    const idleQueue: Array<() => void> = [];
    const cancel = schedulePrefetchAll(() => [ws('a', 1)], () => null, { idle: (cb) => { idleQueue.push(cb); } });
    cancel();
    idleQueue.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(getWorkspace).not.toHaveBeenCalled();
  });
});
