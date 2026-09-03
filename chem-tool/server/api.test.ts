import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

function make() {
  const resolver = createResolver({ pubchem: null });
  const store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const { app } = createApp({ store, resolver, host: '127.0.0.1', port: 8140 });
  return { app, store };
}

describe('REST', () => {
  test('health, search, resolve, workspace', async () => {
    const { app } = make();
    expect((await (await app.request('/api/health')).json()).ok).toBe(true);
    const hits = await (await app.request('/api/search?q=eth')).json();
    expect(hits[0].name).toBe('Ethane');
    const r = await (await app.request('/api/resolve?q=water')).json();
    expect(r.species.formula).toBe('H2O');
    const ws = await (await app.request('/api/workspace')).json();
    expect(ws.version).toBe(1);
  });
  test('command applies and returns the workspace; errors carry status and details', async () => {
    const { app, store } = make();
    const res = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'load', query: 'benzene' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.message).toMatch(/Benzene/);
    expect(body.workspace.version).toBe(2);
    expect(store.focused().name).toBe('Benzene');
    const missing = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'load', query: 'benzeen' }) });
    expect(missing.status).toBe(404);
    expect((await missing.json()).suggestions).toContain('Benzene');
    const stale = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set_structure', smiles: 'C', baseVersion: 1 }) });
    expect(stale.status).toBe(409);
    const invalid = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope' }) });
    expect(invalid.status).toBe(400);
  });
  test('species files and snapshot', async () => {
    const { app, store } = make();
    const id = store.focused().id;
    const svg = await app.request(`/api/species/${id}.svg?numbered=1`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('O1');
    const png = await app.request(`/api/species/${id}.png?w=200`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(await (await app.request(`/api/species/${id}.sdf`)).text()).toContain('$$$$');
    expect((await app.request('/api/species/zzzzzz.svg')).status).toBe(404);
    const snap = await app.request('/api/snapshot.png');
    expect(snap.headers.get('content-type')).toBe('image/png');
  });
  test('formula info and connect snippet', async () => {
    const { app } = make();
    const f = await (await app.request('/api/formula?q=NaCl')).json();
    expect(f.molarMass).toBeCloseTo(58.44, 1);
    expect((await app.request('/api/formula?q=Xx')).status).toBe(400);
    const c = await (await app.request('/api/connect')).json();
    expect(c.claudeCode).toBe('claude mcp add --transport http chemtool http://127.0.0.1:8140/mcp');
  });
});
