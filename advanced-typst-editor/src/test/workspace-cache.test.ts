import { describe, it, expect, beforeEach } from 'vitest';
import { clearWorkspaceCaches, createLru, detailCache, forgetWorkspace, mergeDetail, renderCache, textCache } from '@/lib/workspace-cache';
import type { WorkspaceDetail } from '@/types';

const entry = { id: 'w1', name: 'A', path: 'C:/a', group: null, library: true, createdAt: 0, openedAt: 1 };
const asset = (id: string, extra: object = {}) => ({ id, kind: 'image' as const, filename: id.split('/').pop()!, mime: 'image/png', size: 1, etag: 'e', folderId: null, createdAt: 0, updatedAt: 0, crop: null, blurs: null, ...extra });
const detail = (over: Partial<WorkspaceDetail> = {}): WorkspaceDetail => ({
  entry,
  files: [{ path: 'main.typ', size: 10, mtime: 1 }, { path: 'assets/a.png', size: 1, mtime: 1 }],
  meta: { version: 1, assets: {}, fonts: {} },
  assets: [asset('assets/a.png')],
  folders: [],
  etag: 'e1',
  ...over,
});

beforeEach(() => clearWorkspaceCaches());

describe('createLru', () => {
  it('evicts the least recently used entries once the weight budget is exceeded', () => {
    const lru = createLru<string>({ maxWeight: 10, sizeOf: (s) => s.length });
    lru.set('a', 'aaaa');
    lru.set('b', 'bbbb');
    expect(lru.get('a')).toBe('aaaa'); // a is now the most recent
    lru.set('c', 'cccc'); // 12 > 10: evict b, the oldest
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('aaaa');
    expect(lru.get('c')).toBe('cccc');
    expect(lru.weight).toBe(8);
    lru.set('big', 'x'.repeat(50)); // over budget on its own: kept, everything else goes
    expect(lru.size).toBe(1);
    expect(lru.get('big')).toHaveLength(50);
    lru.delete('big');
    expect(lru.weight).toBe(0);
  });

  it('replaces an existing key without double counting', () => {
    const lru = createLru<string>({ maxWeight: 100, sizeOf: (s) => s.length });
    lru.set('a', 'aaaa');
    lru.set('a', 'aa');
    expect(lru.weight).toBe(2);
    lru.deleteWhere((k) => k.startsWith('a'));
    expect(lru.size).toBe(0);
  });
});

describe('mergeDetail', () => {
  it('returns the previous object when only openedAt moved', () => {
    const prev = detail();
    const next = detail({ entry: { ...entry, openedAt: 2 } });
    expect(mergeDetail(prev, next)).toBe(prev);
  });

  it('keeps unchanged records by identity and swaps only what changed', () => {
    const prev = detail({ assets: [asset('assets/a.png'), asset('assets/b.png')] });
    const next = detail({
      files: [{ path: 'main.typ', size: 12, mtime: 2 }, { path: 'assets/a.png', size: 1, mtime: 1 }],
      assets: [asset('assets/a.png'), asset('assets/b.png', { crop: { x: 0, y: 0, w: 1, h: 0.5 } })],
      etag: 'e2',
    });
    const merged = mergeDetail(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.etag).toBe('e2');
    expect(merged.files[1]).toBe(prev.files[1]);
    expect(merged.files[0]).toEqual({ path: 'main.typ', size: 12, mtime: 2 });
    expect(merged.assets[0]).toBe(prev.assets[0]);
    expect(merged.assets[1]).not.toBe(prev.assets[1]);
    expect(merged.folders).toBe(prev.folders);
    expect(merged.meta).toBe(prev.meta);
    expect(merged.entry).toBe(prev.entry);
  });

  it('passes a fresh detail through when there is nothing to share with', () => {
    const next = detail();
    expect(mergeDetail(undefined, next)).toBe(next);
  });
});

describe('forgetWorkspace', () => {
  it('drops every cache entry for the workspace and nothing else', () => {
    detailCache.set('w1', detail());
    detailCache.set('w2', detail());
    textCache.set('w1:main.typ', { text: 'a', etag: null });
    textCache.set('w2:main.typ', { text: 'b', etag: null });
    renderCache.set('w1:main.typ', { svg: '<svg/>', diagnostics: [], scrollTop: 0 });
    renderCache.set('w2:main.typ', { svg: '<svg/>', diagnostics: [], scrollTop: 0 });
    forgetWorkspace('w1');
    expect(detailCache.has('w1')).toBe(false);
    expect(detailCache.has('w2')).toBe(true);
    expect(textCache.has('w1:main.typ')).toBe(false);
    expect(textCache.has('w2:main.typ')).toBe(true);
    expect(renderCache.get('w1:main.typ')).toBeUndefined();
    expect(renderCache.get('w2:main.typ')).toBeDefined();
  });
});
