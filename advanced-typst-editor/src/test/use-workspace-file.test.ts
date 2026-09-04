import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CLIENT_ID } from '@/api/client';
import { useWorkspaceFile } from '@/hooks/use-workspace-file';
import { useAppStore } from '@/stores';
import type { ServerEvent } from '@/types';

/**
 * The buffer-sync contract, from the editor's side.
 *
 * `useWorkspaceFile` deliberately drops any `workspace.changed` event carrying
 * its own client id, so its autosave writes don't come back at it as "the file
 * changed on disk". That filter is why the server announces a reference rewrite
 * (asset/folder rename, move, delete) with `origin: null` rather than the id of
 * the tab that requested it -- see server/service.ts's `rewrote`. These tests
 * pin both halves: a null origin reloads even though this tab's own HTTP
 * request caused the rewrite, and the tab's own id is still filtered out.
 */

const detail = {
  entry: { id: 'w1', name: 'A', path: 'C:/a', group: null, library: true, createdAt: 0, openedAt: 0 },
  files: [], meta: { version: 1, assets: {}, fonts: {} }, assets: [], folders: [],
};

const BEFORE = '#image("/assets/shots/a.png")';
const AFTER = '#image("/assets/a.png")';

let disk = BEFORE;
const writes: string[] = [];

beforeEach(() => {
  disk = BEFORE;
  writes.length = 0;
  useAppStore.setState({ activeWorkspaceId: 'w1', lastChange: null, detail: null, typstAssets: [], assetFolders: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      const text = new TextDecoder().decode(init!.body as Uint8Array);
      writes.push(text);
      disk = text;
      return new Response(null, { status: 204 });
    }
    if (String(url).includes('/files/')) return new Response(disk, { status: 200, headers: { etag: 'e1' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const emit = (ev: ServerEvent) => act(() => { useAppStore.getState().handleEvent(ev); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('useWorkspaceFile external-change handling', () => {
  it('reloads a clean buffer on a null-origin rewrite, even though this tab asked for it', async () => {
    const { result } = renderHook(() => useWorkspaceFile('w1', 'main.typ'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.text).toBe(BEFORE);

    // What the server does after this tab's own "move the asset" request: it
    // rewrites main.typ on disk and announces it as nobody's write.
    disk = AFTER;
    emit({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: null });

    await waitFor(() => expect(result.current.text).toBe(AFTER));
    expect(result.current.externalChange).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(writes).toEqual([]); // nothing autosaved the stale text back
  });

  it('still ignores a rewrite attributed to this tab`s own client id', async () => {
    const { result } = renderHook(() => useWorkspaceFile('w1', 'main.typ'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    disk = AFTER;
    emit({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: CLIENT_ID });
    await settle();

    // The pre-fix failure mode: the buffer keeps the stale path and no reload runs.
    expect(result.current.text).toBe(BEFORE);
    expect(result.current.externalChange).toBe(false);
  });

  it('flags a dirty buffer instead of reloading over the user`s unsaved edits', async () => {
    const { result, unmount } = renderHook(() => useWorkspaceFile('w1', 'main.typ'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.setText(`${BEFORE} // mine`); });
    disk = AFTER;
    emit({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: null });

    await waitFor(() => expect(result.current.externalChange).toBe(true));
    expect(result.current.text).toBe(`${BEFORE} // mine`);

    // Drain the queued autosave while the fetch stub is still installed, so it
    // does not fire against the real fetch after the test.
    unmount();
    await settle();
  });

  it('ignores a change naming a different file or workspace', async () => {
    const { result } = renderHook(() => useWorkspaceFile('w1', 'main.typ'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    disk = AFTER;
    emit({ type: 'workspace.changed', id: 'w1', paths: ['other.typ'], origin: null });
    await settle();
    expect(result.current.text).toBe(BEFORE);
  });
});
