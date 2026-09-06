import { describe, expect, test } from 'bun:test';
import { buildConnectInfo } from '../server/connect.ts';

const find = (info: ReturnType<typeof buildConnectInfo>, id: string) => info.snippets.find((s) => s.id === id)!;

describe('buildConnectInfo', () => {
  test('inside Docker the stdio snippets go through docker exec and the example path is the mounted folder', () => {
    const info = buildConnectInfo('http://localhost:8765', { container: 'circuit-ai-tool', projectsDir: '/projects' });
    expect(info.container).toBe('circuit-ai-tool');
    expect(info.stdioCommand).toBe('"docker" "exec" "-i" "circuit-ai-tool" "bun" "server/index.ts" "--stdio"');
    const desktop = JSON.parse(find(info, 'claude-desktop').code) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(desktop.mcpServers['circuit-ai-tool']).toEqual({ command: 'docker', args: ['exec', '-i', 'circuit-ai-tool', 'bun', 'server/index.ts', '--stdio'] });
    expect(find(info, 'claude-code').code).toContain('"docker" "exec" "-i" "circuit-ai-tool"');
    expect(find(info, 'chatgpt').code.startsWith('docker compose up -d')).toBe(true);
    expect(find(info, 'api').code).toContain('/projects/lab1/lab1.kicad_sch');
    expect(info.mcpAliasUrl).toBe('http://localhost:8765/mcp-server/mcp');
  });

  test('outside Docker nothing mentions docker and the example path is the local projects folder', () => {
    const info = buildConnectInfo('http://localhost:8765', { container: null, projectsDir: 'C:\\Users\\me\\Documents\\KiCad\\9.0\\projects' });
    expect(info.container).toBeNull();
    expect(info.stdioCommand.startsWith('"docker"')).toBe(false);
    expect(info.stdioCommand).toContain('mcp-stdio.ts');
    expect(find(info, 'chatgpt').code.startsWith('bun start')).toBe(true);
    expect(find(info, 'api').code).toContain('C:/Users/me/Documents/KiCad/9.0/projects/lab1/lab1.kicad_sch');
    expect(find(info, 'claude-desktop').title).toContain('works even when this server is closed');
  });
});
