import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { createMcp } from './mcp';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '= T' });
  const mcp = createMcp({ service, compile: createCompiler({ settings, service, typstCli: null }), backup: createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' }), settings, bus, token: null });
  const post = (body: unknown, session?: string) => mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) }));
  return { mcp, post };
}
async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? text;
  return JSON.parse(data) as Record<string, unknown>;
}

describe('MCP over Streamable HTTP', () => {
  it('initialises a session, lists tools, calls one, reports the client, ends the session', async () => {
    const { mcp, post } = setup();
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9.9' } } });
    expect(init.status).toBe(200);
    const session = init.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    expect((await bodyJson(init)).result).toMatchObject({ serverInfo: { name: 'typst-figure-studio' } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const list = await bodyJson(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session));
    expect(((list.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name)).toContain('create_workspace');
    const call = await bodyJson(await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_workspace', arguments: { name: 'Via MCP' } } }, session));
    const text = (call.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ name: 'Via MCP', library: true });
    const bad = await bodyJson(await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_workspace', arguments: { workspace_id: 'nope' } } }, session));
    expect((bad.result as { isError: boolean }).isError).toBe(true);
    expect(mcp.status().clients).toEqual([expect.objectContaining({ name: 'claude-code', version: '9.9', sessions: 1 })]);
    const del = await mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'DELETE', headers: { 'mcp-session-id': session } }));
    expect(del.status).toBeLessThan(300);
    expect(mcp.status().clients).toEqual([]);
    mcp.close();
  });
});
