import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { WorkspaceRow } from '@/components/sidebar/WorkspaceRow';
import type { WorkspaceStatus } from '@/types';

vi.mock('@/lib/prefetch', () => ({ hoverPrefetch: vi.fn(), cancelHoverPrefetch: vi.fn() }));

const ws: WorkspaceStatus = { id: 'w1', name: 'Report', group: null, path: 'C:/w1', library: true, createdAt: 0, openedAt: 0, status: 'ok' };

function row() {
  return render(
    <WorkspaceRow ws={ws} active={false} indent={0} onSelect={() => {}} onMenu={() => {}} onDragStart={() => {}} onDrop={() => {}} />,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ previewLock: { all: false, overrides: {} } });
});

describe('WorkspaceRow lock indicator', () => {
  it('shows nothing while the workspace is unlocked', () => {
    row();
    expect(screen.queryByTitle('Preview locked')).toBeNull();
  });

  it('shows the lock when this workspace is locked', () => {
    useAppStore.setState({ previewLock: { all: false, overrides: { w1: true } } });
    row();
    expect(screen.getByTitle('Preview locked')).toBeTruthy();
  });

  it('shows the lock for everything under Lock all, except an unlocked override', () => {
    useAppStore.setState({ previewLock: { all: true, overrides: {} } });
    const { unmount } = row();
    expect(screen.getByTitle('Preview locked')).toBeTruthy();
    unmount();
    useAppStore.setState({ previewLock: { all: true, overrides: { w1: false } } });
    row();
    expect(screen.queryByTitle('Preview locked')).toBeNull();
  });

  it('store actions toggle one workspace and set all, and persist', () => {
    useAppStore.getState().toggleWorkspaceLock('w1');
    expect(useAppStore.getState().previewLock).toEqual({ all: false, overrides: { w1: true } });
    expect(JSON.parse(localStorage.getItem('tfs-preview-lock')!)).toEqual({ all: false, overrides: { w1: true } });
    useAppStore.getState().setAllLocked(true);
    expect(useAppStore.getState().previewLock).toEqual({ all: true, overrides: {} });
    expect(JSON.parse(localStorage.getItem('tfs-preview-lock')!).all).toBe(true);
  });
});
