import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';

beforeEach(() => {
  useAppStore.setState({
    workspaces: [], activeWorkspaceId: null, backup: null, mcp: null, online: true,
  });
});

describe('Sidebar', () => {
  it('has no way to open an arbitrary external folder as a workspace', () => {
    render(<Sidebar />);
    expect(screen.getByTitle('New workspace')).toBeInTheDocument();
    expect(screen.queryByTitle('Open folder as workspace')).not.toBeInTheDocument();
  });
});
