import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';
import type { WorkspaceStatus } from '@/types';

const hoverPrefetch = vi.fn();
const cancelHoverPrefetch = vi.fn();
vi.mock('@/lib/prefetch', () => ({ hoverPrefetch: (...a: unknown[]) => hoverPrefetch(...a), cancelHoverPrefetch: (...a: unknown[]) => cancelHoverPrefetch(...a) }));

const ws = (id: string, group: string | null): WorkspaceStatus => ({ id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt: 0, status: 'ok' });

/** A DataTransfer stand-in: jsdom's own DataTransfer doesn't retain data across separate fireEvent calls, so the test wires one plain object through dragStart and drop itself, exactly as the browser would. */
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '' };
}

beforeEach(() => {
  hoverPrefetch.mockClear();
  cancelHoverPrefetch.mockClear();
  localStorage.clear();
  useAppStore.setState({
    workspaces: [], groups: [], folderMeta: {}, activeWorkspaceId: null, backup: null, mcp: null, online: true,
  });
});

describe('Sidebar', () => {
  it('prefetches a workspace the pointer rests on, not the active one', () => {
    useAppStore.setState({ workspaces: [ws('a', null), ws('b', null)], activeWorkspaceId: 'a' });
    render(<Sidebar />);
    fireEvent.pointerEnter(screen.getByText('b'));
    expect(hoverPrefetch).toHaveBeenCalledWith('b');
    fireEvent.pointerLeave(screen.getByText('b'));
    expect(cancelHoverPrefetch).toHaveBeenCalled();
    fireEvent.pointerEnter(screen.getByText('a'));
    expect(hoverPrefetch).toHaveBeenCalledTimes(1);
  });

  it('has no way to open an arbitrary external folder as a workspace', () => {
    render(<Sidebar />);
    expect(screen.getByTitle('New workspace')).toBeInTheDocument();
    expect(screen.queryByTitle('Open folder as workspace')).not.toBeInTheDocument();
  });

  it('creates a folder from the New Folder button', () => {
    const createGroup = vi.fn();
    useAppStore.setState({ createGroup });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('New folder'));
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'CPTC' } });
    fireEvent.submit(screen.getByPlaceholderText('Folder name').closest('form')!);
    expect(createGroup).toHaveBeenCalledWith('CPTC');
  });

  it('dragging a workspace onto a folder files it there', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC');
  });

  it('dragging a workspace out of its folder onto the loose area clears its group', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', 'CPTC')], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('sidebar-workspace-list'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', null);
  });

  it('offers rename and delete on a folder via its context menu', () => {
    const renameGroup = vi.fn();
    const deleteGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], renameGroup, deleteGroup });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('CPTC 2026');
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText('CPTC'));
    fireEvent.click(screen.getByText('Rename folder'));
    expect(renameGroup).toHaveBeenCalledWith('CPTC', 'CPTC 2026');
    fireEvent.contextMenu(screen.getByText('CPTC'));
    fireEvent.click(screen.getByText('Delete folder'));
    expect(deleteGroup).toHaveBeenCalledWith('CPTC');
    promptSpy.mockRestore();
  });

  it('collapses a folder from its header, shows a count, and remembers it', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC'), ws('b', 'CPTC')], groups: ['CPTC'] });
    const { unmount } = render(<Sidebar />);
    expect(screen.getByText('a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('tfs-collapsed-groups')!)).toEqual(['CPTC']);

    unmount();
    render(<Sidebar />);
    expect(screen.queryByText('a')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('still files a dragged workspace when dropped on a collapsed folder', () => {
    const setWorkspaceGroup = vi.fn();
    localStorage.setItem('tfs-collapsed-groups', JSON.stringify(['CPTC']));
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC');
  });

  it('dragging a folder onto another folder nests it', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'School'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-School'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC', 'School');
  });

  it('ignores a folder dropped into its own subtree', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    expect(moveGroup).not.toHaveBeenCalled();
  });

  it('dragging a folder onto the loose area lifts it to the top level', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('sidebar-workspace-list'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC/inject', null);
  });

  it('marks a legal hovered target and not an illegal one', () => {
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject', 'School'] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });

    fireEvent.dragOver(screen.getByTestId('folder-School'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-School')).toHaveAttribute('data-drop-active', 'true');

    fireEvent.dragOver(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-CPTC/inject')).not.toHaveAttribute('data-drop-active', 'true');
  });

  it('cancels a pending spring-load expansion when the drag ends without a drop', async () => {
    vi.useFakeTimers();
    localStorage.setItem('tfs-collapsed-groups', JSON.stringify(['CPTC']));
    useAppStore.setState({ workspaces: [ws('a', null), ws('b', 'CPTC')], groups: ['CPTC'] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.dragEnd(screen.getByTestId('workspace-a'), { dataTransfer: dt });

    await act(async () => { await vi.advanceTimersByTimeAsync(700); });

    expect(screen.getByTestId('folder-CPTC')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('clears the highlight when the drag ends without a drop', () => {
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC'] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-CPTC')).toHaveAttribute('data-drop-active', 'true');

    fireEvent.dragEnd(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-CPTC')).not.toHaveAttribute('data-drop-active', 'true');
  });

  it('dragging a folder onto a workspace row files it in that row\'s containing folder', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('b', 'School')], groups: ['CPTC', 'School'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('workspace-b'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC', 'School');
  });

  it('files a workspace dragged into a subfolder, not just a top-level one', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC', 'CPTC/inject'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC/inject');
  });

  it('dropping onto a workspace row inside a folder files the drag in that folder, not the top level', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null), ws('b', 'CPTC')], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('workspace-b'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC');
  });

  it('opens Settings from the status footer', () => {
    const setSettingsOpen = vi.fn();
    useAppStore.setState({ setSettingsOpen, mcp: null, backup: null });
    render(<Sidebar />);
    fireEvent.click(screen.getByText(/MCP: no client/));
    fireEvent.click(screen.getByText(/Backup: not set up/));
    expect(setSettingsOpen).toHaveBeenCalledTimes(2);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('renders subfolders under their parent, indented', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC/inject')], groups: ['CPTC', 'CPTC/inject'] });
    render(<Sidebar />);
    expect(screen.getByText('CPTC')).toBeInTheDocument();
    expect(screen.getByText('inject')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByTestId('folder-CPTC/inject')).toHaveStyle({ paddingLeft: '16px' });
  });

  it('shows a folder icon and colour from folderMeta', () => {
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield', color: 'blue' } } });
    render(<Sidebar />);
    const row = screen.getByTestId('folder-CPTC');
    expect(row.querySelector('[data-folder-icon="shield"]')).toBeTruthy();
    expect(row.querySelector('[data-folder-stripe]')).toHaveStyle({ backgroundColor: 'hsl(var(--folder-blue))' });
  });

  it('counts the whole subtree on a collapsed folder', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC'), ws('b', 'CPTC/inject')], groups: ['CPTC', 'CPTC/inject'] });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('Sidebar collapse', () => {
  it('collapses to a rail, hiding the workspace list but keeping a way back', () => {
    useAppStore.setState({ workspaces: [ws('a', null)] });
    render(<Sidebar />);
    expect(screen.getByText('a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByTitle('New workspace')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toBeInTheDocument();

    fireEvent.click(expand);
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('remembers the collapsed state across a remount', () => {
    useAppStore.setState({ workspaces: [ws('a', null)] });
    const { unmount } = render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(JSON.parse(localStorage.getItem('tfs-sidebar-collapsed')!)).toBe(true);

    unmount();
    render(<Sidebar />);
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('still reaches Settings from the collapsed rail', () => {
    const setSettingsOpen = vi.fn();
    useAppStore.setState({ setSettingsOpen });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    fireEvent.click(screen.getByTitle('Settings'));
    fireEvent.click(screen.getByTitle(/^MCP:/));
    fireEvent.click(screen.getByTitle(/^Backup:/));
    expect(setSettingsOpen).toHaveBeenCalledTimes(3);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('toggles on Ctrl/Cmd+B', () => {
    useAppStore.setState({ workspaces: [ws('a', null)] });
    render(<Sidebar />);

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.queryByText('a')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('leaves Ctrl+B alone while the user is typing in a field', () => {
    useAppStore.setState({ workspaces: [ws('a', null)] });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('New workspace'));
    const input = screen.getByPlaceholderText('Workspace name');
    input.focus();

    fireEvent.keyDown(input, { key: 'b', ctrlKey: true, bubbles: true });
    expect(screen.getByText('a')).toBeInTheDocument();
  });
});
