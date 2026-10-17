import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';
import type { WorkspaceStatus } from '@/types';

vi.mock('@/lib/prefetch', () => ({ hoverPrefetch: vi.fn(), cancelHoverPrefetch: vi.fn() }));

const ws = (id: string, group: string | null): WorkspaceStatus => ({ id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt: 0, status: 'ok' });
const ext = (id: string): WorkspaceStatus => ({ ...ws(id, null), library: false });
const rows = (...ids: string[]) => ids.map((id) => ws(id, null));
const row = (id: string) => screen.getByTestId(`workspace-${id}`);
const selected = () => screen.queryAllByTestId(/^workspace-/).filter((el) => el.getAttribute('data-selected') === 'true').map((el) => el.textContent);

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    workspaces: [], groups: [], folderMeta: {}, activeWorkspaceId: null, backup: null, mcp: null, online: true,
  });
});

describe('Sidebar multi-select', () => {
  it('Ctrl/Cmd+click toggles a row without opening it', () => {
    const selectWorkspace = vi.fn();
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('c'), { metaKey: true });
    expect(selected()).toEqual(['a', 'c']);
    fireEvent.click(row('a'), { ctrlKey: true });
    expect(selected()).toEqual(['c']);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('a plain click opens the document and resets the selection to that row', () => {
    const selectWorkspace = vi.fn();
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.click(row('c'));
    expect(selectWorkspace).toHaveBeenCalledWith('c');
    expect(selected()).toEqual(['c']);
  });

  it('Shift+click selects the range from the anchor in visible order', () => {
    useAppStore.setState({ workspaces: [ws('t1', null), ws('t2', null), ws('inA1', 'A'), ws('inA2', 'A')], groups: ['A'], selectWorkspace: vi.fn() });
    render(<Sidebar />);
    // rendered order: folder A's rows first, then the loose rows
    fireEvent.click(row('inA2'));
    fireEvent.click(row('t2'), { shiftKey: true });
    expect(selected()).toEqual(['inA2', 't1', 't2']);
  });

  it('Shift+click leaves out rows hidden inside a collapsed folder', () => {
    localStorage.setItem('tfs-collapsed-groups', JSON.stringify(['A']));
    useAppStore.setState({ workspaces: [ws('inA', 'A'), ws('t1', null), ws('t2', null)], groups: ['A'], selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('t1'));
    fireEvent.click(row('t2'), { shiftKey: true });
    expect(selected()).toEqual(['t1', 't2']);
  });

  it('gives a selected row a state distinct from the active row', () => {
    useAppStore.setState({ workspaces: rows('a', 'b'), activeWorkspaceId: 'a', selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('b'), { ctrlKey: true });
    expect(row('b').className).not.toBe(row('a').className);
    expect(row('b')).toHaveAttribute('data-selected', 'true');
    expect(row('a')).not.toHaveAttribute('data-selected', 'true');
  });

  it('Escape clears the selection', () => {
    useAppStore.setState({ workspaces: rows('a', 'b'), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(selected()).toEqual([]);
  });

  it('clicking outside the sidebar clears the selection so a stray Delete cannot fire', () => {
    useAppStore.setState({ workspaces: rows('a'), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'));
    fireEvent.mouseDown(document.body);
    expect(selected()).toEqual([]);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Sidebar delete menu and dialogs', () => {
  it('labels the single-row delete by where the folder lives', () => {
    useAppStore.setState({ workspaces: [ws('lib', null), ext('out')] });
    render(<Sidebar />);
    fireEvent.contextMenu(row('lib'));
    expect(screen.getByText('Delete…')).toBeInTheDocument();
    expect(screen.queryByText('Move to trash')).not.toBeInTheDocument();
    fireEvent.contextMenu(row('out'));
    expect(screen.getByText('Remove from sidebar')).toBeInTheDocument();
    expect(screen.queryByText('Forget')).not.toBeInTheDocument();
  });

  it('the single Delete dialog says where a library document goes and that it can be restored', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: ['lib'], failed: [] });
    useAppStore.setState({ workspaces: [ws('lib', null)], removeWorkspaces });
    render(<Sidebar />);
    fireEvent.contextMenu(row('lib'));
    fireEvent.click(screen.getByText('Delete…'));
    expect(await screen.findByText(/data\/trash/)).toBeInTheDocument();
    expect(screen.getByText(/restored from there/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(removeWorkspaces).toHaveBeenCalledWith(['lib']);
  });

  it('the single Remove dialog says an external folder stays on disk', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: ['out'], failed: [] });
    useAppStore.setState({ workspaces: [ext('out')], removeWorkspaces });
    render(<Sidebar />);
    fireEvent.contextMenu(row('out'));
    fireEvent.click(screen.getByText('Remove from sidebar'));
    expect(await screen.findByText(/stays on disk at C:\/out/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removeWorkspaces).toHaveBeenCalledWith(['out']);
  });

  it('right-clicking inside a multi-selection offers one bulk delete and hides Rename and Move', () => {
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('b'));
    expect(screen.getByText('Delete 2 documents…')).toBeInTheDocument();
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    expect(screen.queryByText('Move to…')).not.toBeInTheDocument();
    expect(selected()).toEqual(['a', 'b']);
  });

  it('right-clicking a row outside the selection resets the selection to it', () => {
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('c'));
    expect(selected()).toEqual(['c']);
    expect(screen.getByText('Delete…')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
  });

  it('bulk dialog lists up to 5 names, "+N more", and the trash/sidebar split', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: [], failed: [] });
    useAppStore.setState({ workspaces: [...rows('a', 'b', 'c', 'd', 'e', 'f', 'g'), ext('x')], removeWorkspaces, selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('x'), { shiftKey: true });
    fireEvent.contextMenu(row('c'));
    fireEvent.click(screen.getByText('Delete 8 documents…'));
    expect(await screen.findByText(/\+3 more/)).toBeInTheDocument();
    const msg = screen.getByRole('dialog').textContent!;
    expect(msg).toMatch(/7 move to the app trash folder \(data\/trash\)/);
    expect(msg).toMatch(/1 is only removed from the sidebar/);
    expect(msg).toMatch(/restored from there/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete 8' }));
    expect(removeWorkspaces).toHaveBeenCalledTimes(1);
    expect([...removeWorkspaces.mock.calls[0]![0]].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x']);
  });

  it('shows no "+N more" when 5 or fewer are selected', async () => {
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace: vi.fn(), removeWorkspaces: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('a'));
    fireEvent.click(screen.getByText('Delete 2 documents…'));
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/more/);
  });

  it('reports a partial failure in the sidebar', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: ['a'], failed: [{ id: 'b', message: 'locked by another process' }] });
    useAppStore.setState({ workspaces: rows('a', 'b'), selectWorkspace: vi.fn(), removeWorkspaces });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('a'));
    fireEvent.click(screen.getByText('Delete 2 documents…'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/1 of 2/);
    expect(alert.textContent).toMatch(/b: locked by another process/);
  });
});

describe('Sidebar Delete key', () => {
  it('opens the bulk dialog for the selected rows and clears the selection after confirming', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: ['a', 'b'], failed: [] });
    useAppStore.setState({ workspaces: rows('a', 'b', 'c'), selectWorkspace: vi.fn(), removeWorkspaces });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(await screen.findByRole('dialog', { name: 'Delete 2 documents?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(removeWorkspaces).toHaveBeenCalledWith(['a', 'b']);
    await act(async () => {});
    expect(selected()).toEqual([]);
  });

  it('is ignored with nothing selected, while typing, and inside the editor', () => {
    useAppStore.setState({ workspaces: rows('a', 'b'), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(screen.getByTitle('New workspace'));
    fireEvent.keyDown(screen.getByPlaceholderText('Workspace name'), { key: 'Delete' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // CodeMirror's content element; jsdom doesn't implement isContentEditable, so the guard also matches the editor root.
    const cm = document.body.appendChild(document.createElement('div'));
    cm.className = 'cm-editor';
    fireEvent.keyDown(cm.appendChild(document.createElement('div')), { key: 'Delete' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cm.remove();
  });
});
