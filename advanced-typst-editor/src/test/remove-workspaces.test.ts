import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore } from '@/stores';
import { clearWorkspaceCaches } from '@/lib/workspace-cache';
import { forgetWorkspaceLocks } from '@/lib/preview-lock';

const calls: Array<{ method: string; url: string }> = [];
/** `failing` ids answer 500 to DELETE; everything else succeeds. */
function mockFetch(failing: string[] = []) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'DELETE' && failing.some((id) => url.endsWith(`/api/workspaces/${id}`))) return json({ error: 'locked by another process' }, 500);
    if (method === 'DELETE') return json({ ok: true });
    if (url.split('?')[0] === '/api/workspaces') return json([]);
    return json({});
  }));
}
const listCalls = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/workspaces');

beforeEach(() => {
  clearWorkspaceCaches();
  localStorage.clear();
  useAppStore.setState({ activeWorkspaceId: null, detail: null, previewLock: { all: false, overrides: {} } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('forgetWorkspaceLocks', () => {
  it('drops only the named overrides and keeps the global flag', () => {
    expect(forgetWorkspaceLocks({ all: true, overrides: { a: false, b: false, c: false } }, ['a', 'c'])).toEqual({ all: true, overrides: { b: false } });
  });
  it('returns the same object when nothing was overridden', () => {
    const lock = { all: false, overrides: { x: true } };
    expect(forgetWorkspaceLocks(lock, ['a'])).toBe(lock);
  });
});

describe('store removeWorkspaces', () => {
  it('deletes each id and reloads the list once', async () => {
    mockFetch();
    const r = await useAppStore.getState().removeWorkspaces(['a', 'b', 'c']);
    expect(r).toEqual({ removed: ['a', 'b', 'c'], failed: [] });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/workspaces/a', '/api/workspaces/b', '/api/workspaces/c']);
    expect(listCalls()).toHaveLength(1);
  });

  it('selects nothing when the active workspace was among them', async () => {
    mockFetch();
    useAppStore.setState({ activeWorkspaceId: 'b' });
    await useAppStore.getState().removeWorkspaces(['a', 'b']);
    expect(useAppStore.getState().activeWorkspaceId).toBeNull();
  });

  it('keeps the active workspace when it was not deleted', async () => {
    mockFetch();
    useAppStore.setState({ activeWorkspaceId: 'z' });
    await useAppStore.getState().removeWorkspaces(['a']);
    expect(useAppStore.getState().activeWorkspaceId).toBe('z');
  });

  it('reports partial failure, keeps the successes, and does not clear a failed active workspace', async () => {
    mockFetch(['b']);
    useAppStore.setState({ activeWorkspaceId: 'b' });
    const r = await useAppStore.getState().removeWorkspaces(['a', 'b', 'c']);
    expect(r.removed).toEqual(['a', 'c']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ id: 'b' });
    expect(r.failed[0]?.message).toContain('locked by another process');
    expect(useAppStore.getState().activeWorkspaceId).toBe('b');
    expect(listCalls()).toHaveLength(1);
  });

  it('drops the removed workspaces from the preview lock and saves it', async () => {
    mockFetch(['b']);
    useAppStore.setState({ previewLock: { all: false, overrides: { a: true, b: true, c: true } } });
    await useAppStore.getState().removeWorkspaces(['a', 'b']);
    // b failed to delete, so its override stays
    expect(useAppStore.getState().previewLock).toEqual({ all: false, overrides: { b: true, c: true } });
    expect(JSON.parse(localStorage.getItem('tfs-preview-lock')!)).toEqual({ all: false, overrides: { b: true, c: true } });
  });

  it('single removeWorkspace also drops its lock override, and still throws on failure', async () => {
    mockFetch(['x']);
    useAppStore.setState({ previewLock: { all: false, overrides: { a: true } } });
    await useAppStore.getState().removeWorkspace('a');
    expect(useAppStore.getState().previewLock.overrides).toEqual({});
    await expect(useAppStore.getState().removeWorkspace('x')).rejects.toThrow(/locked by another process/);
  });
});
