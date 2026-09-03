import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createMcpServer } from './mcp';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

type Content = { type: string; text?: string; mimeType?: string }[];
let client: Client;
let store: WorkspaceStore;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Content;
  return { content, isError: Boolean(r.isError), text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  const resolver = createResolver({ pubchem: null });
  store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ store, resolver, host: '127.0.0.1', port: 8140 }).connect(a);
  client = new Client({ name: 't', version: '0' });
  await client.connect(b);
});

describe('edit tools', () => {
  test('edit_molecule applies ops and returns the new atom list', async () => {
    await call('lookup_chemical', { query: 'ethanol' });
    const r = await call('edit_molecule', { ops: [{ op: 'replace_group', index: 3, group: 'NH2' }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/C2H7N/);
    expect(r.text).toMatch(/Atoms \(1-based, heavy first\): 1:C 2:C 3:N/);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });
  test('rejected edits are isError with the reason and the unchanged atom list', async () => {
    const before = store.get().version;
    const r = await call('edit_molecule', { ops: [{ op: 'add_atom', element: 'Cl', bondTo: 42 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Atom 42 does not exist/);
    expect(r.text).toMatch(/"atoms"/);
    expect(store.get().version).toBe(before);
  });
  test('set_view merges fields and accumulates rotation', async () => {
    const r = await call('set_view', { style: 'spacefill', highlight: [1, 3], rotate: { axis: 'y', degrees: 90 } });
    expect(r.isError).toBe(false);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(store.activeScene().view).toMatchObject({ style: 'spacefill', highlight: [1, 3], camera: { rotation: [0, 90, 0] } });
    await call('set_view', { rotate: { axis: 'y', degrees: 45 }, preset: 'top' });
    expect(store.activeScene().view.camera).toEqual({ preset: 'top', rotation: [0, 135, 0] });
  });
  test('undo and redo', async () => {
    const u = await call('undo');
    expect(u.text).toMatch(/Undid.*Ethanol/);
    expect(store.focused().formula).toBe('C2H6O');
    const r = await call('redo');
    expect(r.text).toMatch(/Redid/);
    expect(store.focused().formula).toBe('C2H7N');
    await call('redo');
    expect((await call('redo')).isError).toBe(true);
  });
});
