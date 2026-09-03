import { describe, expect, test } from 'bun:test';
import { createApp } from '../server/app.ts';
import { pngAvailable } from '../server/png.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeService } from './service.test.ts';

async function setup() {
  const { service, sch, events } = await makeService();
  const app = createApp({ service, events, mcp: () => new McpServer({ name: 'stub', version: '0' }) });
  const json = (path: string, body?: unknown) => app.request(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, sch, json, service, events };
}

describe('REST API', () => {
  test('open, summary, layout, steps, checks, truth table, pinouts', async () => {
    const { json, sch } = await setup();
    const opened = await (await json('/api/projects/open', { path: sch })).json();
    expect(opened.id).toHaveLength(10);
    const id = opened.id;
    expect((await (await json(`/api/projects/${id}`)).json()).name).toBe('PL1_1');
    const layout = await (await json(`/api/projects/${id}/layout`)).json();
    expect(layout.packages).toHaveLength(3);
    expect((await (await json(`/api/projects/${id}/steps`)).json()).length).toBeGreaterThan(10);
    expect((await (await json(`/api/projects/${id}/checks`)).json()).some((c: { level: string }) => c.level === 'error')).toBe(false);
    expect((await (await json(`/api/projects/${id}/truth-table`)).json()).rows).toHaveLength(4);
    expect((await (await json(`/api/projects/${id}/pinouts`)).json())).toHaveLength(3);
    const list = await (await json('/api/projects')).json();
    expect(list.recent[0].id).toBe(id);
  });

  test('images', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const svg = await json(`/api/projects/${id}/board.svg?highlight=net:/A&theme=dark`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('opacity="0.18"');
    const sch2 = await json(`/api/projects/${id}/schematic.svg`);
    expect(await sch2.text()).toContain('<svg');
    const png = await json(`/api/projects/${id}/board.png`);
    if (pngAvailable()) {
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      const bytes = new Uint8Array(await png.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } else expect(png.status).toBe(501);
  });

  test('layout edits and simulation', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const before = await (await json(`/api/projects/${id}/layout`)).json();
    const d2 = before.pinHoles.D2;
    const holes = { '1': { col: d2['1'].col + 3, row: d2['1'].row }, '2': { col: d2['2'].col + 3, row: d2['2'].row } };
    const moved = await (await json(`/api/projects/${id}/layout/move`, { ref: 'D2', holes })).json();
    expect(moved.pinHoles.D2).toEqual(holes);
    const bad = await json(`/api/projects/${id}/layout/move`, { ref: 'D2', holes: { '1': { col: 1, row: 'a' } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/pin 2/);
    const opts = await (await json(`/api/projects/${id}/layout/options`, { dipSwitchPositions: 4 })).json();
    expect(opts.packages[0].kind).toBe('dipswitch');
    const col = await (await json(`/api/projects/${id}/layout/colors`, { net: '/A', color: '#abcdef' })).json();
    expect(col.nets['/A'].color).toBe('#abcdef');
    const reset = await (await json(`/api/projects/${id}/layout/reset`, {})).json();
    expect(reset.packages[0].kind).toBe('dip');
    const sim = await (await json(`/api/projects/${id}/sim`, { levels: { '/A': 1, '/B': 1 } })).json();
    expect(sim.nets['/Y1']).toBe(0);
    expect((await json(`/api/projects/zzz/layout`)).status).toBe(404);
  });

  test('openapi, connect, parts and events', async () => {
    const { json, app } = await setup();
    const doc = await (await json('/openapi.json')).json();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toContain('/api/projects/{id}/layout');
    const connect = await (await json('/api/connect')).json();
    expect(connect.snippets.length).toBeGreaterThan(3);
    expect(connect.mcpUrl).toMatch(/\/mcp$/);
    const parts = await (await json('/api/parts')).json();
    expect(parts.some((p: { alias: string }) => p.alias === '74LS00')).toBe(true);
    const res = await app.request('/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  test('netlist text and sidecar for the client', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const net = await json(`/api/projects/${id}/netlist`);
    expect(net.headers.get('content-type')).toContain('text/plain');
    expect((await net.text()).startsWith('(export')).toBe(true);
    const side = await (await json(`/api/projects/${id}/sidecar`)).json();
    expect(side.version).toBe(1);
    expect(side.pinned).toEqual({});
  });
});
