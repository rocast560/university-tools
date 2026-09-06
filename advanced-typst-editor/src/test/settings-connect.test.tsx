import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { SettingsView } from '@/components/settings/SettingsView';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  useAppStore.setState({
    backup: null,
    redaction: { style: 'gaussian', strength: 1 },
    typstCli: null,
    loadBackup: async () => {},
    saveSettings: async () => {},
    mcp: { endpoint: '/mcp', authRequired: false, clients: [], stdioBridge: 'C:\\repo\\advanced-typst-editor\\server\\mcp-stdio.ts' },
  });
});

describe('Settings › Connect Claude', () => {
  it('copies the Claude Code command', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Claude Code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp'));
  });

  it('copies a Claude Desktop config that launches the bridge with forward slashes', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: /Copy Claude Desktop/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const json = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(json).toEqual({ mcpServers: { 'typst-figure-studio': { command: 'bun', args: ['C:/repo/advanced-typst-editor/server/mcp-stdio.ts'] } } });
  });

  it('copies the endpoint', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Endpoint' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:8090/mcp'));
  });

  it('shows a placeholder path and a hint when the server cannot name the bridge (Docker, sidecar)', () => {
    useAppStore.setState({ mcp: { endpoint: '/mcp', authRequired: false, clients: [], stdioBridge: null } });
    render(<SettingsView />);
    expect(screen.getByText(/<path to advanced-typst-editor>\/server\/mcp-stdio.ts/)).toBeInTheDocument();
    expect(screen.getByText(/machine that runs Claude Desktop/)).toBeInTheDocument();
  });

  it('no longer hardcodes a user path', () => {
    render(<SettingsView />);
    expect(document.body.textContent).not.toContain('C:/Users/rober');
  });
});
