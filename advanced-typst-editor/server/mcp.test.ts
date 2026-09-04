import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { createMcp } from './mcp';
import { tmpDir, rmDir, TYPST_CLI } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup(now?: () => number, typstCli: string | null = null) {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '= T' });
  const mcp = createMcp({ service, compile: createCompiler({ settings, service, typstCli }), backup: createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' }), settings, bus, token: null, now });
  const post = (body: unknown, session?: string) => mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) }));
  return { mcp, post, bus };
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

  it.skipIf(!fs.existsSync(TYPST_CLI))('wraps a tool result carrying an image as an MCP image content block, not JSON text', async () => {
    const { post } = setup(undefined, TYPST_CLI);
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9.9' } } });
    const session = init.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const created = await bodyJson(await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_workspace', arguments: { name: 'P', source: '= ok' } } }, session));
    const { id } = JSON.parse((created.result as { content: Array<{ text: string }> }).content[0]!.text) as { id: string };
    const call = await bodyJson(await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'render_preview', arguments: { workspace_id: id } } }, session));
    const content = (call.result as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> }).content;
    const image = content.find((c) => c.type === 'image');
    expect(image).toMatchObject({ mimeType: 'image/png' });
    expect(image!.data!.length).toBeGreaterThan(100);
    const text = content.find((c) => c.type === 'text');
    expect(JSON.parse(text!.text!)).toMatchObject({ ok: true, page: 1 });
  });

  it('closes the GET stream on cancel, marking the client disconnected, and sweep reaps + publishes for a stale session', async () => {
    const clock = { t: Date.now() };
    const { mcp, post, bus } = setup(() => clock.t);
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9.9' } } });
    const session = init.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);

    const streamRes = await mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': session } }));
    const reader = streamRes.body!.getReader();
    expect(mcp.status().clients[0]?.connected).toBe(true);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 61_000;
    expect(mcp.status().clients[0]?.connected).toBe(false);

    let mcpEvents = 0;
    const unsubscribe = bus.subscribe((ev) => { if (ev.type === 'mcp.clients') mcpEvents += 1; });
    clock.t += 31 * 60_000; // past SESSION_TTL_MS since the stream closed above
    await mcp.handle(new Request('http://127.0.0.1:8090/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'other-client', version: '1.0' } } }),
    }));
    unsubscribe();

    expect(mcpEvents).toBeGreaterThan(0);
    expect(mcp.status().clients.some((c) => c.name === 'claude-code')).toBe(false);
    mcp.close();
  });
});
