import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.ts';
import { makeService } from './service.test.ts';

async function connect() {
  const { service, sch } = await makeService();
  const server = createMcpServer(service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { client, sch };
}

type Result = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

describe('MCP tools', () => {
  test('lists the tools and opens a schematic', async () => {
    const { client, sch } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['list_projects', 'open_schematic', 'get_summary', 'render_breadboard', 'explain_net', 'simulate', 'move_part', 'run_erc']) expect(tools).toContain(t);
    const opened = (await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result;
    expect(opened.isError).toBeFalsy();
    const id = opened.structuredContent!.id as string;
    expect(id).toHaveLength(10);
    const summary = (await client.callTool({ name: 'get_summary', arguments: { project: id } })) as Result;
    expect(summary.content[0].text).toMatch(/3 chips/);
    const listed = (await client.callTool({ name: 'list_projects', arguments: {} })) as Result;
    expect(listed.content[0].text).toContain('PL1_1');
  });

  test('questions: explain_net, get_pinout, truth table, steps, checks', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const net = (await client.callTool({ name: 'explain_net', arguments: { project: id, net: 'A' } })) as Result;
    expect(net.content[0].text).toMatch(/U3 pin 1/);
    expect(net.content[0].text).toMatch(/wire/);
    const pin = (await client.callTool({ name: 'get_pinout', arguments: { project: id, ref: 'U3' } })) as Result;
    expect(pin.content[0].text).toMatch(/pin 14 VCC/);
    const tt = (await client.callTool({ name: 'get_truth_table', arguments: { project: id } })) as Result;
    expect(tt.content[0].text).toMatch(/A\s+B\s+\|\s+Y1\s+Y2/);
    const steps = (await client.callTool({ name: 'get_build_steps', arguments: { project: id } })) as Result;
    expect(steps.content[0].text).toMatch(/^1\. /m);
    const checks = (await client.callTool({ name: 'get_checks', arguments: { project: id } })) as Result;
    expect(checks.structuredContent!.errors).toBe(0);
    const sim = (await client.callTool({ name: 'simulate', arguments: { project: id, levels: { A: 1, B: 0 } } })) as Result;
    expect(sim.content[0].text).toMatch(/Y1 = 1/);
  });

  test('render returns an image (or SVG text when PNG is unavailable)', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const r = (await client.callTool({ name: 'render_breadboard', arguments: { project: id, highlight_net: 'A' } })) as Result;
    const img = r.content.find((c) => c.type === 'image');
    if (img) expect(img.mimeType).toBe('image/png');
    else expect(r.content.some((c) => c.text?.includes('<svg'))).toBe(true);
    expect(r.content.some((c) => c.type === 'text')).toBe(true);
  });

  test('layout edits and bad input', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const moved = (await client.callTool({ name: 'move_part', arguments: { project: id, ref: 'R1', holes: { '1': 'a20', '2': 'b20' } } })) as Result;
    expect(moved.isError).toBeFalsy();
    expect(moved.content[0].text).toMatch(/R1 now at a20 and b20/);
    const bad = (await client.callTool({ name: 'move_part', arguments: { project: id, ref: 'R1', holes: { '1': 'zz9' } } })) as Result;
    expect(bad.isError).toBe(true);
    const opts = (await client.callTool({ name: 'set_layout_options', arguments: { project: id, dipSwitchPositions: 4 } })) as Result;
    expect(opts.content[0].text).toMatch(/DIP switch/);
    const parts = (await client.callTool({ name: 'list_supported_parts', arguments: {} })) as Result;
    expect(parts.content[0].text).toContain('74LS00');
  });
});
