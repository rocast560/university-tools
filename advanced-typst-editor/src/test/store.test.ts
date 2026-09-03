import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '@/stores';

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
const detail = { entry: { id: 'w1', name: 'A', path: 'C:/a', group: null, library: true, createdAt: 0, openedAt: 0 }, files: [], meta: { version: 1, assets: {}, fonts: {} }, assets: [], folders: [{ id: 'Findings/auth', name: 'auth', parentId: 'Findings', createdAt: 0, updatedAt: 0 }] };

beforeEach(() => { useAppStore.setState({ activeWorkspaceId: 'w1', detail: null, typstAssets: [], assetFolders: [] }); });

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
