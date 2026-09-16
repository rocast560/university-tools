import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '@/stores';
import { clearWorkspaceCaches, detailCache } from '@/lib/workspace-cache';
import type { WorkspaceDetail } from '@/types';

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
function mockFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const key = `${method} ${url.split('?')[0]}`;
    const hit = routes[key] ?? routes[`${method} *`];
    return new Response(JSON.stringify(hit ?? {}), { status: hit === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } });
  }));
}
const detail: WorkspaceDetail = { entry: { id: 'w1', name: 'A', path: 'C:/a', group: null, library: true, createdAt: 0, openedAt: 0 }, files: [], meta: { version: 1, assets: {}, fonts: {} }, assets: [], folders: [{ id: 'Findings/auth', name: 'auth', parentId: 'Findings', createdAt: 0, updatedAt: 0 }], etag: 'e0' };

beforeEach(() => { clearWorkspaceCaches(); useAppStore.setState({ activeWorkspaceId: 'w1', detail: null, typstAssets: [], assetFolders: [] }); });

describe('store folder actions map to API paths', () => {
  it('create, rename, move, delete', async () => {
    mockFetch({ 'GET /api/workspaces/w1': detail, 'POST /api/workspaces/w1/asset-folders': { folder: detail.folders[0] }, 'PATCH /api/workspaces/w1/asset-folders': { references: 0 }, 'DELETE /api/workspaces/w1/asset-folders': { references: 0, moved: 0 } });
    const s = useAppStore.getState();
    await s.createAssetFolder('auth', 'Findings');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: 'Findings/auth' } });
    await s.renameAssetFolder('Findings/auth', 'Auth Bypass');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ path: 'Findings/auth', newPath: 'Findings/Auth Bypass' });
    await s.moveAssetFolder('Findings/auth', null);
    expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ path: 'Findings/auth', newPath: 'auth' });
    await s.deleteAssetFolder('Findings/auth');
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('path=Findings%2Fauth');
    expect(useAppStore.getState().assetFolders).toEqual(detail.folders);
  });
  // The panel repoints the open document at the moved file, so it needs the
  // id the server actually stored (sanitised, de-duplicated), not a guess.
  it('moving an asset returns its new id', async () => {
    mockFetch({ 'GET /api/workspaces/w1': detail, 'PATCH *': { asset: { id: 'assets/Findings/shot.png' }, references: 1 } });
    const newId = await useAppStore.getState().moveTypstAssetToFolder('assets/shot.png', 'Findings');
    expect(newId).toBe('assets/Findings/shot.png');
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { folder: 'Findings' } });
  });
  it('reloads the active workspace on a change event, debounced', async () => {
    vi.useFakeTimers();
    mockFetch({ 'GET /api/workspaces/w1': detail });
    const s = useAppStore.getState();
    s.handleEvent({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: 'mcp' });
    s.handleEvent({ type: 'workspace.changed', id: 'w1', paths: ['workspace.json'], origin: 'mcp' });
    s.handleEvent({ type: 'workspace.changed', id: 'other', paths: ['main.typ'], origin: null });
    expect(useAppStore.getState().lastChange).toMatchObject({ paths: ['workspace.json'], seq: 2 });
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.filter((c) => c.url === '/api/workspaces/w1')).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('store workspace switching cache', () => {
  beforeEach(() => { clearWorkspaceCaches(); useAppStore.setState({ activeWorkspaceId: null, detail: null, typstAssets: [], assetFolders: [] }); });

  it('applies a cached detail synchronously and only revalidates with If-None-Match', async () => {
    const cached = { ...detail, etag: 'abc' };
    detailCache.set('w1', cached);
    let status = 304;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: (init?.headers as Record<string, string>)?.['if-none-match'] });
      return status === 304 ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ ...detail, etag: 'def', files: [{ path: 'main.typ', size: 1, mtime: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    calls.length = 0;
    const p = useAppStore.getState().selectWorkspace('w1');
    expect(useAppStore.getState().detail).toBe(cached); // before any response
    expect(useAppStore.getState().assetFolders).toBe(cached.folders);
    await p;
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1', body: '"abc"' });
    expect(useAppStore.getState().detail).toBe(cached); // 304: untouched

    status = 200;
    await useAppStore.getState().selectWorkspace('w1');
    const next = useAppStore.getState().detail!;
    expect(next).not.toBe(cached);
    expect(next.etag).toBe('def');
    expect(next.folders).toBe(cached.folders); // structural sharing
    expect(detailCache.get('w1')).toBe(next);
  });

  it('ignores a detail that arrives after the user switched away, but still caches it', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => {
      if (url.endsWith('/w1')) resolvers.push((r) => resolve(r));
      else resolve(new Response(JSON.stringify({ ...detail, entry: { ...detail.entry, id: 'w2' }, etag: 'w2' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    })));
    const first = useAppStore.getState().selectWorkspace('w1');
    await useAppStore.getState().selectWorkspace('w2');
    expect(useAppStore.getState().detail?.entry.id).toBe('w2');
    resolvers[0]!(new Response(JSON.stringify({ ...detail, etag: 'w1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await first;
    expect(useAppStore.getState().detail?.entry.id).toBe('w2');
    expect(detailCache.get('w1')?.etag).toBe('w1');
  });

  it('keeps caches for a workspace that changed off screen, clears them when the registry changes', () => {
    detailCache.set('w1', { ...detail, etag: 'x' });
    detailCache.set('w2', { ...detail, etag: 'y' });
    useAppStore.setState({ activeWorkspaceId: 'w2' });
    mockFetch({ 'GET /api/workspaces': { workspaces: [] }, 'GET /api/groups': { groups: [] }, 'GET /api/workspaces/w2': detail });
    useAppStore.getState().handleEvent({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: null });
    expect(detailCache.has('w1')).toBe(true); // revalidated on the next visit
    useAppStore.getState().handleEvent({ type: 'workspaces.changed' });
    expect(detailCache.size).toBe(0);
  });
});

describe('store group actions', () => {
  beforeEach(() => { useAppStore.setState({ workspaces: [], groups: [] }); });

  it('loads, creates, renames and deletes groups, and reloads workspaces after a change', async () => {
    mockFetch({ 'GET /api/groups': { groups: ['CPTC'] }, 'POST /api/groups': { groups: ['CPTC', 'ECE'] }, 'PATCH /api/groups/CPTC': { groups: ['CPTC 2026', 'ECE'] }, 'DELETE /api/groups/CPTC%202026': { groups: ['ECE'] }, 'GET /api/workspaces': { workspaces: [] } });
    await useAppStore.getState().loadGroups();
    expect(useAppStore.getState().groups).toEqual(['CPTC']);
    await useAppStore.getState().createGroup('ECE');
    expect(calls[1]).toMatchObject({ method: 'POST', body: { name: 'ECE' } });
    expect(useAppStore.getState().groups).toEqual(['CPTC', 'ECE']);
    await useAppStore.getState().renameGroup('CPTC', 'CPTC 2026');
    expect(useAppStore.getState().groups).toEqual(['CPTC 2026', 'ECE']);
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/workspaces')).toBe(true);
    await useAppStore.getState().deleteGroup('CPTC 2026');
    expect(useAppStore.getState().groups).toEqual(['ECE']);
  });
});
