import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore } from '@/stores';
import { api } from '@/api/client';
import { clearWorkspaceCaches } from '@/lib/workspace-cache';

const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body, headers: init?.headers as Record<string, string> });
    const hit = routes[`${method} ${url.split('?')[0]}`] ?? routes[`${method} *`];
    return new Response(JSON.stringify(hit?.body ?? {}), { status: hit?.status ?? (hit ? 200 : 404), headers: { 'content-type': 'application/json' } });
  }));
}

beforeEach(() => { clearWorkspaceCaches(); useAppStore.setState({ workspaces: [], activeWorkspaceId: null }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('api: nesting and logos', () => {
  it('patchWorkspace sends parent and appearance', async () => {
    mockFetch({ 'PATCH *': { body: { workspace: { id: 'a' } } } });
    await api.patchWorkspace('a', { parent: 'b' });
    await api.patchWorkspace('a', { appearance: { logo: null } });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: '/api/workspaces/a', body: { parent: 'b' } });
    expect(calls[1]!.body).toEqual({ appearance: { logo: null } });
  });

  it('uploadLogo posts the raw image with its own content type and resolves to the file name', async () => {
    mockFetch({ 'POST /api/logos': { status: 201, body: { logo: 'ab12.png' } } });
    const file = new File([new Uint8Array([1, 2, 3])], 'mark.png', { type: 'image/png' });
    expect(await api.uploadLogo(file)).toBe('ab12.png');
    expect(calls[0]!.headers!['content-type']).toBe('image/png');
    expect(calls[0]!.body).toBe(file);
  });

  it('uploadLogo surfaces the server message on a rejection', async () => {
    mockFetch({ 'POST /api/logos': { status: 413, body: { error: 'A logo can be at most 512 KB.' } } });
    await expect(api.uploadLogo(new File([new Uint8Array([1])], 'm.png', { type: 'image/png' }))).rejects.toThrow(/512 KB/);
  });

  it('folder appearance sends logo', async () => {
    mockFetch({ 'PATCH *': { body: { groups: [], folderMeta: {} } } });
    await api.setFolderAppearance('CPTC', { logo: 'ab12.png' });
    expect(calls[0]!.body).toEqual({ logo: 'ab12.png' });
  });
});

describe('store: nesting and logos', () => {
  it('setWorkspaceParent patches the parent then reloads the list', async () => {
    mockFetch({ 'PATCH *': { body: { workspace: { id: 'a' } } }, 'GET /api/workspaces': { body: { workspaces: [{ id: 'a', name: 'a', parent: 'b', group: null, path: 'C:/a', library: true, createdAt: 0, openedAt: 0, status: 'ok' }] } } });
    await useAppStore.getState().setWorkspaceParent('a', 'b');
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: '/api/workspaces/a', body: { parent: 'b' } });
    expect(useAppStore.getState().workspaces[0]!.parent).toBe('b');
  });

  it('setWorkspaceAppearance patches the appearance then reloads the list', async () => {
    mockFetch({ 'PATCH *': { body: { workspace: { id: 'a' } } }, 'GET /api/workspaces': { body: { workspaces: [{ id: 'a', name: 'a', group: null, path: 'C:/a', library: true, createdAt: 0, openedAt: 0, status: 'ok', appearance: { icon: 'star' } }] } } });
    await useAppStore.getState().setWorkspaceAppearance('a', { icon: 'star' });
    expect(calls[0]!.body).toEqual({ appearance: { icon: 'star' } });
    expect(useAppStore.getState().workspaces[0]!.appearance).toEqual({ icon: 'star' });
  });

  it('uploadLogo returns the stored file name', async () => {
    mockFetch({ 'POST /api/logos': { status: 201, body: { logo: 'zz.webp' } } });
    expect(await useAppStore.getState().uploadLogo(new File([new Uint8Array([1])], 'm.webp', { type: 'image/webp' }))).toBe('zz.webp');
  });
});
