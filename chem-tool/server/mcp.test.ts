import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createMcpServer } from './mcp';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

type Content = { type: string; text?: string; mimeType?: string; data?: string }[];
let client: Client;
let store: WorkspaceStore;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { content: r.content as Content, isError: Boolean(r.isError), text: (r.content as Content).filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  const resolver = createResolver({ pubchem: null });
  store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const server = createMcpServer({ store, resolver, host: '127.0.0.1', port: 8140 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

describe('MCP tools', () => {
  test('lists the phase 1 tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['lookup_chemical', 'search_chemicals', 'get_current', 'set_molecule', 'render_2d', 'render_3d', 'get_structure', 'formula_info', 'new_scene', 'list_scenes', 'switch_scene']) expect(names).toContain(n);
  });
  test('lookup_chemical loads into the window and returns a numbered atom list and an image', async () => {
    const r = await call('lookup_chemical', { query: 'ethanol' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Ethanol/);
    expect(r.text).toMatch(/Atoms \(1-based, heavy first\): 1:C 2:C 3:O 4:H/);
    expect(r.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(store.focused().name).toBe('Ethanol');
    expect(store.get().version).toBe(2);
  });
  test('lookup_chemical with load=false does not touch the workspace; unknown names fail with suggestions', async () => {
    const before = store.get().version;
    const r = await call('lookup_chemical', { query: 'acetone', load: false });
    expect(r.text).toMatch(/Acetone/);
    expect(store.get().version).toBe(before);
    const bad = await call('lookup_chemical', { query: 'acetoen' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Acetone/);
  });
  test('get_current, set_molecule, get_structure', async () => {
    const cur = await call('get_current');
    expect(cur.text).toMatch(/Ethanol/);
    expect(cur.text).toMatch(/"version"/);
    const set = await call('set_molecule', { smiles: 'CC(C)=O' });
    expect(set.text).toMatch(/C3H6O/);
    const s = await call('get_structure', { format: 'smiles' });
    expect(s.text.trim()).toMatch(/^(CC\(C\)=O|CC\(=O\)C)$/);   // OpenChemLib's canonical spelling of acetone
    const sdf = await call('get_structure', { format: 'sdf' });
    expect(sdf.text).toContain('V2000');
    const j = await call('get_structure', { format: 'json' });
    expect(j.text).toContain('"atoms"');
  });
  test('render_2d and render_3d return PNGs', async () => {
    for (const name of ['render_2d', 'render_3d']) {
      const r = await call(name, { width: 200 });
      expect(r.isError).toBe(false);
      const img = r.content.find((c) => c.type === 'image');
      expect(img?.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data!, 'base64')[0]).toBe(0x89);
    }
  });
  test('search_chemicals and formula_info do not touch the workspace', async () => {
    const before = store.get().version;
    expect((await call('search_chemicals', { query: 'chlor' })).text).toMatch(/Chlorine/);
    const f = await call('formula_info', { formula: 'NaCl' });
    expect(f.text).toMatch(/58\.44/);
    expect(store.get().version).toBe(before);
  });
  test('scenes', async () => {
    const n = await call('new_scene', { title: 'Second', query: 'benzene' });
    expect(n.text).toMatch(/Second/);
    const list = await call('list_scenes');
    expect(list.text).toMatch(/Second/);
    const id = store.get().scenes[0].id;
    await call('switch_scene', { sceneId: id });
    expect(store.get().activeSceneId).toBe(id);
  });
});
