import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { COLLAPSED_GROUPS_KEY } from '@/lib/collapsed-groups';
import type { WorkspaceStatus } from '@/types';

vi.mock('@/lib/prefetch', () => ({ hoverPrefetch: vi.fn(), cancelHoverPrefetch: vi.fn() }));

const ws = (id: string, group: string | null, extra: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({
  id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt: 0, status: 'ok', ...extra,
});
const row = (id: string) => screen.getByTestId(`workspace-${id}`);
const pad = (id: string) => parseInt(row(id).style.paddingLeft, 10);

function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '' };
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaces: [], groups: [], folderMeta: {}, activeWorkspaceId: null, backup: null, mcp: null, online: true });
});

describe('nested documents in the sidebar', () => {
  it('renders a child under its parent, indented one level', () => {
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' }), ws('g', null, { parent: 'c' })] });
    render(<Sidebar />);
    expect(pad('c') - pad('p')).toBe(12);
    expect(pad('g') - pad('c')).toBe(12);
    const order = screen.getAllByTestId(/^workspace-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['workspace-p', 'workspace-c', 'workspace-g']);
  });

  it('shows a chevron only on a parent, and collapsing hides the children and is remembered', () => {
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' }), ws('solo', null)] });
    const { unmount } = render(<Sidebar />);
    expect(screen.queryByTestId('toggle-workspace-c')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toggle-workspace-solo')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-workspace-p'));
    expect(screen.queryByTestId('workspace-c')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)!)).toContain('ws:p');
    unmount();
    render(<Sidebar />);
    expect(screen.queryByTestId('workspace-c')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-workspace-p'));
    expect(screen.getByTestId('workspace-c')).toBeInTheDocument();
  });

  it('clicking the chevron does not open the document', () => {
    const selectWorkspace = vi.fn();
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' })], selectWorkspace });
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('toggle-workspace-p'));
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('keeps a nested document inside its folder, under its parent', () => {
    useAppStore.setState({ groups: ['A'], workspaces: [ws('p', 'A'), ws('c', 'A', { parent: 'p' }), ws('t', null)] });
    render(<Sidebar />);
    const order = screen.getAllByTestId(/^(workspace|folder)-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['folder-A', 'workspace-p', 'workspace-c', 'workspace-t']);
  });

  it('a collapsed folder counts nested documents too', () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(['A']));
    useAppStore.setState({ groups: ['A'], workspaces: [ws('p', 'A'), ws('c', 'A', { parent: 'p' })] });
    render(<Sidebar />);
    expect(screen.getByTestId('folder-A')).toHaveTextContent('2');
  });
});

describe('dragging documents onto documents', () => {
  it('a drop on a row nests the dragged document under it', () => {
    const setWorkspaceParent = vi.fn();
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null), ws('b', null)], setWorkspaceParent, setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row('a'), { dataTransfer: dt });
    fireEvent.drop(row('b'), { dataTransfer: dt });
    expect(setWorkspaceParent).toHaveBeenCalledWith('a', 'b');
    expect(setWorkspaceGroup).not.toHaveBeenCalled();
  });

  it('ignores a drop on itself and on its own descendant', () => {
    const setWorkspaceParent = vi.fn();
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' })], setWorkspaceParent });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row('p'), { dataTransfer: dt });
    fireEvent.drop(row('p'), { dataTransfer: dt });
    fireEvent.drop(row('c'), { dataTransfer: dt });
    expect(setWorkspaceParent).not.toHaveBeenCalled();
  });

  it('marks a legal hovered row and not an illegal one', () => {
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' }), ws('e', null)] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row('p'), { dataTransfer: dt });
    fireEvent.dragOver(row('e'), { dataTransfer: dt });
    expect(row('e')).toHaveAttribute('data-drop-active', 'true');
    fireEvent.dragLeave(row('e'), { dataTransfer: dt });
    expect(row('e')).not.toHaveAttribute('data-drop-active', 'true');
    fireEvent.dragOver(row('c'), { dataTransfer: dt });
    expect(row('c')).not.toHaveAttribute('data-drop-active', 'true');
    fireEvent.dragOver(row('p'), { dataTransfer: dt });
    expect(row('p')).not.toHaveAttribute('data-drop-active', 'true');
  });

  it('a drop on a folder header un-nests and files it there; on the background it goes loose', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ groups: ['CPTC'], workspaces: [ws('p', null), ws('c', null, { parent: 'p' })], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row('c'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('c', 'CPTC');
    fireEvent.dragStart(row('c'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('sidebar-workspace-list'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('c', null);
  });

  it('a folder dropped on a document row still goes to that row folder', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ groups: ['CPTC', 'School'], workspaces: [ws('b', 'School'), ws('k', 'School', { parent: 'b' })], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(row('k'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC', 'School');
  });

  it('resting on a collapsed parent opens it', () => {
    vi.useFakeTimers();
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(['ws:p']));
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' }), ws('e', null)] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row('e'), { dataTransfer: dt });
    fireEvent.dragOver(row('p'), { dataTransfer: dt });
    expect(screen.queryByTestId('workspace-c')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(700); });
    vi.useRealTimers();
    expect(screen.getByTestId('workspace-c')).toBeInTheDocument();
  });
});

describe('row glyph priority: logo, then icon, then default', () => {
  it('shows the logo over an icon', () => {
    useAppStore.setState({ workspaces: [ws('a', null, { appearance: { icon: 'shield', logo: 'ab12.png' } })] });
    render(<Sidebar />);
    const img = row('a').querySelector('img[data-doc-logo]') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/logos/ab12.png');
    expect(row('a').querySelector('[data-doc-icon]')).toBeNull();
    expect(row('a').querySelector('[data-doc-default]')).toBeNull();
  });

  it('shows the icon when there is no logo', () => {
    useAppStore.setState({ workspaces: [ws('a', null, { appearance: { icon: 'shield', color: 'blue' } })] });
    render(<Sidebar />);
    expect(row('a').querySelector('[data-doc-icon="shield"]')).not.toBeNull();
    expect(row('a').querySelector('img')).toBeNull();
  });

  it('falls back to the default dot', () => {
    useAppStore.setState({ workspaces: [ws('a', null)] });
    render(<Sidebar />);
    expect(row('a').querySelector('[data-doc-default]')).not.toBeNull();
  });

  it('falls back to the icon or dot when the logo file will not load', () => {
    useAppStore.setState({ workspaces: [ws('a', null, { appearance: { icon: 'shield', logo: 'gone.png' } })] });
    render(<Sidebar />);
    fireEvent.error(row('a').querySelector('img[data-doc-logo]')!);
    expect(row('a').querySelector('img')).toBeNull();
    expect(row('a').querySelector('[data-doc-icon="shield"]')).not.toBeNull();
  });

  it('a folder shows its logo over its icon', () => {
    useAppStore.setState({ groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield', logo: 'ab12.png' } } });
    render(<Sidebar />);
    const f = screen.getByTestId('folder-CPTC');
    expect((f.querySelector('img[data-folder-logo]') as HTMLImageElement).getAttribute('src')).toBe('/api/logos/ab12.png');
    expect(f.querySelector('[data-folder-icon]')).toBeNull();
  });

  it('a folder without a logo still shows its icon', () => {
    useAppStore.setState({ groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield' } } });
    render(<Sidebar />);
    expect(screen.getByTestId('folder-CPTC').querySelector('[data-folder-icon="shield"]')).not.toBeNull();
  });
});

describe('appearance popover for a document', () => {
  const openFor = async (id: string) => {
    fireEvent.contextMenu(row(id));
    fireEvent.click(screen.getByText('Appearance…'));
    await screen.findByText('Logo');
  };

  it('is offered on a document menu, and sets an icon and a colour', async () => {
    const setWorkspaceAppearance = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null)], setWorkspaceAppearance });
    render(<Sidebar />);
    await openFor('a');
    fireEvent.click(screen.getByTitle('blue'));
    expect(setWorkspaceAppearance).toHaveBeenCalledWith('a', { color: 'blue' });
    fireEvent.click(screen.getByTitle('shield'));
    expect(setWorkspaceAppearance).toHaveBeenCalledWith('a', { icon: 'shield' });
  });

  it('is not offered when several documents are selected', () => {
    useAppStore.setState({ workspaces: [ws('a', null), ws('b', null)], selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('a'), { ctrlKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('a'));
    expect(screen.queryByText('Appearance…')).not.toBeInTheDocument();
  });

  it('uploads an image and sets it as the logo', async () => {
    const setWorkspaceAppearance = vi.fn();
    const uploadLogo = vi.fn().mockResolvedValue('ab12.png');
    useAppStore.setState({ workspaces: [ws('a', null)], setWorkspaceAppearance, uploadLogo });
    render(<Sidebar />);
    await openFor('a');
    const file = new File([new Uint8Array([1, 2, 3])], 'mark.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('logo-file'), { target: { files: [file] } });
    await waitFor(() => expect(setWorkspaceAppearance).toHaveBeenCalledWith('a', { logo: 'ab12.png' }));
    expect(uploadLogo).toHaveBeenCalledWith(file);
  });

  it('rejects a wrong type or an oversize file before uploading, with a message', async () => {
    const uploadLogo = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null)], uploadLogo, setWorkspaceAppearance: vi.fn() });
    render(<Sidebar />);
    await openFor('a');
    fireEvent.change(screen.getByTestId('logo-file'), { target: { files: [new File([new Uint8Array([1])], 'x.gif', { type: 'image/gif' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/PNG, JPEG, WebP or SVG/);
    fireEvent.change(screen.getByTestId('logo-file'), { target: { files: [new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/512 KB/));
    expect(uploadLogo).not.toHaveBeenCalled();
  });

  it('shows the server message when the upload fails', async () => {
    const uploadLogo = vi.fn().mockRejectedValue(new Error('A logo can be at most 512 KB.'));
    useAppStore.setState({ workspaces: [ws('a', null)], uploadLogo, setWorkspaceAppearance: vi.fn() });
    render(<Sidebar />);
    await openFor('a');
    fireEvent.change(screen.getByTestId('logo-file'), { target: { files: [new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('512 KB');
  });

  it('previews the current logo and Remove logo only unlinks it', async () => {
    const setWorkspaceAppearance = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null, { appearance: { logo: 'ab12.png' } })], setWorkspaceAppearance });
    render(<Sidebar />);
    await openFor('a');
    expect((screen.getByTestId('logo-preview') as HTMLImageElement).getAttribute('src')).toBe('/api/logos/ab12.png');
    fireEvent.click(screen.getByText('Remove logo'));
    expect(setWorkspaceAppearance).toHaveBeenCalledWith('a', { logo: null });
  });

  it('has no Remove logo or preview when there is no logo', async () => {
    useAppStore.setState({ workspaces: [ws('a', null)], setWorkspaceAppearance: vi.fn() });
    render(<Sidebar />);
    await openFor('a');
    expect(screen.queryByText('Remove logo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('logo-preview')).not.toBeInTheDocument();
  });

  it('picking an icon while a logo is set clears the logo, so the pick is visible', async () => {
    const setWorkspaceAppearance = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null, { appearance: { logo: 'ab12.png' } })], setWorkspaceAppearance });
    render(<Sidebar />);
    await openFor('a');
    fireEvent.click(screen.getByTitle('star'));
    expect(setWorkspaceAppearance).toHaveBeenCalledWith('a', { icon: 'star', logo: null });
  });

  it('a folder gets the same Logo section', async () => {
    const setFolderAppearance = vi.fn();
    const uploadLogo = vi.fn().mockResolvedValue('cd34.svg');
    useAppStore.setState({ groups: ['CPTC'], setFolderAppearance, uploadLogo });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('Appearance…'));
    await screen.findByText('Logo');
    fireEvent.change(screen.getByTestId('logo-file'), { target: { files: [new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })] } });
    await waitFor(() => expect(setFolderAppearance).toHaveBeenCalledWith('CPTC', { logo: 'cd34.svg' }));
  });
});

describe('deleting a parent document', () => {
  it('says how many nested documents move up a level', async () => {
    const removeWorkspaces = vi.fn().mockResolvedValue({ removed: ['p'], failed: [] });
    useAppStore.setState({ workspaces: [ws('p', null), ws('c1', null, { parent: 'p' }), ws('c2', null, { parent: 'p' }), ws('g', null, { parent: 'c1' })], removeWorkspaces });
    render(<Sidebar />);
    fireEvent.contextMenu(row('p'));
    fireEvent.click(screen.getByText('Delete…'));
    expect(await screen.findByText(/2 nested documents move up a level/)).toBeInTheDocument();
  });

  it('uses the singular for one, and says nothing when there are none', async () => {
    useAppStore.setState({ workspaces: [ws('p', null), ws('c', null, { parent: 'p' }), ws('solo', null)], removeWorkspaces: vi.fn() });
    render(<Sidebar />);
    fireEvent.contextMenu(row('p'));
    fireEvent.click(screen.getByText('Delete…'));
    expect(await screen.findByText(/1 nested document moves up a level/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.contextMenu(row('solo'));
    fireEvent.click(screen.getByText('Delete…'));
    await screen.findByRole('dialog');
    expect(screen.queryByText(/move up a level|moves up a level/)).not.toBeInTheDocument();
  });

  it('a bulk delete counts only the survivors that move', async () => {
    useAppStore.setState({ workspaces: [ws('p', null), ws('c1', null, { parent: 'p' }), ws('c2', null, { parent: 'p' })], removeWorkspaces: vi.fn(), selectWorkspace: vi.fn() });
    render(<Sidebar />);
    fireEvent.click(row('p'), { ctrlKey: true });
    fireEvent.click(row('c1'), { ctrlKey: true });
    fireEvent.contextMenu(row('p'));
    fireEvent.click(screen.getByText('Delete 2 documents…'));
    expect(await screen.findByText(/1 nested document moves up a level/)).toBeInTheDocument();
  });
});

describe('Move to… un-nests', () => {
  it('the move menu still files the document in a folder (the server clears the parent)', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ groups: ['CPTC'], workspaces: [ws('p', null), ws('c', null, { parent: 'p' })], setWorkspaceGroup });
    render(<Sidebar />);
    fireEvent.contextMenu(row('c'));
    fireEvent.click(screen.getByText('Move to…'));
    fireEvent.click(screen.getAllByText('CPTC').slice(-1)[0]!); // the menu entry; the folder row is the first
    expect(setWorkspaceGroup).toHaveBeenCalledWith('c', 'CPTC');
  });
});
