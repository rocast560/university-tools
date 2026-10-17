import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { api } from '@/api/client';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';
import type { TrashEntry, TrashRestoreResult } from '@/types';

vi.mock('@/lib/prefetch', () => ({ hoverPrefetch: vi.fn(), cancelHoverPrefetch: vi.fn() }));

const doc = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: '2026-10-17T12-00-00-000Z/Lab 4', kind: 'document', name: 'Lab 4', workspace: null,
  deletedAt: Date.now() - 3 * 60_000, size: 2048, fileCount: 2, canRestore: true, reason: null, ...over,
});
const files = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: '2026-10-16T12-00-00-000Z/Report', kind: 'files', name: 'assets/shot.png', workspace: 'Report',
  deletedAt: Date.now() - 26 * 3600_000, size: 1_500_000, fileCount: 1, canRestore: true, reason: null, ...over,
});
const orphan = (): TrashEntry => files({
  id: '2026-03-01T00-00-00-000Z/Gone', name: 'c.txt', workspace: 'Gone', canRestore: false,
  reason: "its document isn't in the app; restore the document first",
});
const result = (over: Partial<TrashRestoreResult> = {}): TrashRestoreResult => ({
  id: 'x', kind: 'document', location: 'School/ECE-2300L/Lab 4', renamed: false, message: 'Restored to School/ECE-2300L/Lab 4', workspaceId: 'w1', ...over,
});

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaces: [], groups: [], folderMeta: {}, activeWorkspaceId: null, backup: null, mcp: null, online: true });
});
afterEach(() => vi.restoreAllMocks());

describe('Trash row in the sidebar footer', () => {
  it('shows the item count under the MCP and backup rows, and opens the dialog', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([doc(), files()]);
    render(<Sidebar />);
    const row = await screen.findByRole('button', { name: /Trash/ });
    await waitFor(() => expect(row).toHaveTextContent('2'));
    const footer = row.parentElement!;
    const labels = Array.from(footer.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.findIndex((t) => /MCP/.test(t))).toBeLessThan(labels.findIndex((t) => /Backup/.test(t)));
    expect(labels.findIndex((t) => /Backup/.test(t))).toBeLessThan(labels.findIndex((t) => /Trash/.test(t)));
    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Trash/ });
    expect(within(dialog).getByText('Lab 4')).toBeInTheDocument();
    expect(within(dialog).getByText('assets/shot.png')).toBeInTheDocument();
    expect(within(dialog).getByText(/from Report/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3 min ago/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  it('shows no count when the trash is empty, and says so in the dialog', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([]);
    render(<Sidebar />);
    const row = await screen.findByRole('button', { name: /Trash/ });
    expect(row.textContent).toBe('Trash');
    fireEvent.click(row);
    expect(await screen.findByText(/Nothing in the trash/)).toBeInTheDocument();
  });

  it('refreshes the count when a workspace.changed event arrives (a file or asset delete), without polling', async () => {
    const list = vi.spyOn(api, 'listTrash').mockResolvedValue([]);
    render(<Sidebar />);
    const row = await screen.findByRole('button', { name: /Trash/ });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    list.mockResolvedValue([files()]);
    act(() => { useAppStore.setState({ lastChange: { id: 'w1', paths: ['assets/shot.png'], origin: 'c1', seq: 1 } }); });
    await waitFor(() => expect(row).toHaveTextContent('1'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('still renders when the trash cannot be loaded', async () => {
    vi.spyOn(api, 'listTrash').mockRejectedValue(new Error('offline'));
    render(<Sidebar />);
    expect(await screen.findByRole('button', { name: /Trash/ })).toBeInTheDocument();
  });
});

describe('Trash dialog', () => {
  it('Restore calls the API, removes the item and shows where it went', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([doc(), files()]);
    const restore = vi.spyOn(api, 'restoreTrash').mockResolvedValue(result());
    render(<Sidebar />);
    fireEvent.click(await screen.findByRole('button', { name: /Trash/ }));
    const dialog = await screen.findByRole('dialog', { name: /Trash/ });
    const item = within(dialog).getByTestId('trash-item-2026-10-17T12-00-00-000Z/Lab 4');
    fireEvent.click(within(item).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('2026-10-17T12-00-00-000Z/Lab 4'));
    await waitFor(() => expect(within(dialog).queryByText('Lab 4')).not.toBeInTheDocument());
    expect(within(dialog).getByRole('status')).toHaveTextContent('Restored to School/ECE-2300L/Lab 4');
    expect(within(dialog).getByText('assets/shot.png')).toBeInTheDocument();
    // the footer count follows
    expect(screen.getByRole('button', { name: /Trash/ })).toHaveTextContent('1');
  });

  it('reloads the sidebar after a document comes back', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([doc()]);
    vi.spyOn(api, 'restoreTrash').mockResolvedValue(result());
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ loadWorkspaces });
    render(<Sidebar />);
    fireEvent.click(await screen.findByRole('button', { name: /Trash/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(loadWorkspaces).toHaveBeenCalled());
  });

  it('a disabled Restore shows its reason as a tooltip and inline, and does not call the API', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([orphan()]);
    const restore = vi.spyOn(api, 'restoreTrash').mockResolvedValue(result());
    render(<Sidebar />);
    fireEvent.click(await screen.findByRole('button', { name: /Trash/ }));
    const dialog = await screen.findByRole('dialog', { name: /Trash/ });
    const btn = within(dialog).getByRole('button', { name: 'Restore' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "its document isn't in the app; restore the document first");
    expect(within(dialog).getByText("its document isn't in the app; restore the document first")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(restore).not.toHaveBeenCalled();
  });

  it('keeps the item and shows the error when a restore fails', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([doc()]);
    vi.spyOn(api, 'restoreTrash').mockRejectedValue(new Error('disk full'));
    render(<Sidebar />);
    fireEvent.click(await screen.findByRole('button', { name: /Trash/ }));
    const dialog = await screen.findByRole('dialog', { name: /Trash/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('disk full');
    expect(within(dialog).getByText('Lab 4')).toBeInTheDocument();
  });

  it('offers no way to delete: only Restore and Close', async () => {
    vi.spyOn(api, 'listTrash').mockResolvedValue([doc(), files(), orphan()]);
    render(<Sidebar />);
    fireEvent.click(await screen.findByRole('button', { name: /Trash/ }));
    const dialog = await screen.findByRole('dialog', { name: /Trash/ });
    const names = within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names.every((n) => n === 'Restore' || n === 'Close')).toBe(true);
    expect(within(dialog).queryByText(/empty|delete|permanent/i)).not.toBeInTheDocument();
    expect((api as unknown as Record<string, unknown>).emptyTrash).toBeUndefined();
    expect((api as unknown as Record<string, unknown>).deleteTrash).toBeUndefined();
  });
});
