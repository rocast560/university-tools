import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createHandler } from './router';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { browse } from './fs-browse';
import { TOOLS, callTool, type ToolDeps } from './mcp-tools';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '= T\n' });
  const handler = createHandler({ settings, service, bus, token: null, staticDir: null, dataDir, backup: null, compile: null, mcp: null, browse });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await handler(new Request(`http://127.0.0.1:8090${url}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const make = (name: string, group: string | null = null) => service.create({ name, group, source: undefined }).id;
  const compile = createCompiler({ settings, service, typstCli: null });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' });
  const deps: ToolDeps = { service, compile, backup, settings };
  return { call, service, settings, make, deps };
}

describe('PATCH /api/workspaces/:id parent', () => {
  it('nests a document and adopts the parent folder', async () => {
    const { call, make, service } = setup();
    const p = make('P', 'School'); const c = make('C');
    const r = await call('PATCH', `/api/workspaces/${c}`, { parent: p });
    expect(r.status).toBe(200);
    expect(r.body.workspace).toMatchObject({ parent: p, group: 'School' });
    expect(service.entry(c)).toMatchObject({ parent: p, group: 'School' });
  });

  it('refuses itself, a descendant, an unknown id and a bad type, naming the problem', async () => {
    const { call, make } = setup();
    const a = make('A'); const b = make('B');
    await call('PATCH', `/api/workspaces/${b}`, { parent: a });
    const self = await call('PATCH', `/api/workspaces/${a}`, { parent: a });
    expect(self.status).toBe(400); expect(self.body.error).toMatch(/itself/);
    const inside = await call('PATCH', `/api/workspaces/${a}`, { parent: b });
    expect(inside.status).toBe(400); expect(inside.body.error).toMatch(/inside/);
    const unknown = await call('PATCH', `/api/workspaces/${a}`, { parent: 'nope' });
    expect(unknown.status).toBe(404);
    const bad = await call('PATCH', `/api/workspaces/${a}`, { parent: 5 });
    expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/parent/);
  });

  it('refuses a fifth level', async () => {
    const { call, make } = setup();
    const ids = ['1', '2', '3', '4', '5'].map((n) => make(n));
    for (let i = 1; i < 4; i++) expect((await call('PATCH', `/api/workspaces/${ids[i]}`, { parent: ids[i - 1] })).status).toBe(200);
    const r = await call('PATCH', `/api/workspaces/${ids[4]}`, { parent: ids[3] });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/4 levels/);
  });

  it('parent null un-nests but keeps the folder; group clears the parent and moves the subtree', async () => {
    const { call, make, service } = setup();
    const p = make('P', 'A'); const c = make('C'); const g = make('G');
    await call('PATCH', `/api/workspaces/${c}`, { parent: p });
    await call('PATCH', `/api/workspaces/${g}`, { parent: c });
    await call('PATCH', `/api/workspaces/${p}`, { group: 'B' });
    expect([p, c, g].map((id) => service.entry(id).group)).toEqual(['B', 'B', 'B']);
    await call('PATCH', `/api/workspaces/${c}`, { parent: null });
    expect(service.entry(c).parent ?? null).toBeNull();
    expect(service.entry(c).group).toBe('B');
    expect(service.entry(g).parent).toBe(c);
    await call('PATCH', `/api/workspaces/${g}`, { group: 'Z' });
    expect(service.entry(g)).toMatchObject({ group: 'Z' });
    expect(service.entry(g).parent ?? null).toBeNull();
  });

  it('refuses group and a parent in the same request', async () => {
    const { call, make } = setup();
    const a = make('A'); const b = make('B');
    const r = await call('PATCH', `/api/workspaces/${a}`, { group: 'X', parent: b });
    expect(r.status).toBe(400);
  });

  it('deleting a parent re-parents its children and says nothing is lost', async () => {
    const { call, make, service } = setup();
    const root = make('R'); const mid = make('M'); const kid = make('K');
    await call('PATCH', `/api/workspaces/${mid}`, { parent: root });
    await call('PATCH', `/api/workspaces/${kid}`, { parent: mid });
    expect((await call('DELETE', `/api/workspaces/${mid}`)).status).toBe(200);
    expect(service.entry(kid).parent).toBe(root);
  });
});

describe('PATCH /api/workspaces/:id appearance', () => {
  it('sets, merges and clears icon, colour and logo', async () => {
    const { call, make } = setup();
    const a = make('A');
    const set = await call('PATCH', `/api/workspaces/${a}`, { appearance: { icon: 'star', color: 'red' } });
    expect(set.body.workspace.appearance).toEqual({ icon: 'star', color: 'red' });
    const logo = await call('PATCH', `/api/workspaces/${a}`, { appearance: { logo: 'ab12cd.png' } });
    expect(logo.body.workspace.appearance).toEqual({ icon: 'star', color: 'red', logo: 'ab12cd.png' });
    const clear = await call('PATCH', `/api/workspaces/${a}`, { appearance: { icon: null, color: null, logo: null } });
    expect(clear.body.workspace.appearance).toBeUndefined();
  });

  it('names the field in a 400', async () => {
    const { call, make } = setup();
    const a = make('A');
    const bad = await call('PATCH', `/api/workspaces/${a}`, { appearance: { logo: '../../x.png' } });
    expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/appearance\.logo/);
    const badIcon = await call('PATCH', `/api/workspaces/${a}`, { appearance: { icon: 3 } });
    expect(badIcon.status).toBe(400); expect(badIcon.body.error).toMatch(/appearance\.icon/);
    const notObj = await call('PATCH', `/api/workspaces/${a}`, { appearance: 'x' });
    expect(notObj.status).toBe(400); expect(notObj.body.error).toMatch(/appearance/);
  });

  it('appears in the workspace list', async () => {
    const { call, make } = setup();
    const a = make('A'); const b = make('B');
    await call('PATCH', `/api/workspaces/${a}`, { appearance: { icon: 'star' } });
    await call('PATCH', `/api/workspaces/${b}`, { parent: a });
    const list = (await call('GET', '/api/workspaces')).body.workspaces as Array<{ id: string; parent?: string; appearance?: unknown }>;
    expect(list.find((w) => w.id === a)!.appearance).toEqual({ icon: 'star' });
    expect(list.find((w) => w.id === b)!.parent).toBe(a);
  });
});

describe('folder appearance logo', () => {
  it('PATCH /api/groups/:path accepts a logo and null clears it', async () => {
    const { call } = setup();
    await call('POST', '/api/groups', { name: 'CPTC' });
    const set = await call('PATCH', '/api/groups/CPTC', { logo: 'ab12cd.png' });
    expect(set.body.folderMeta).toEqual({ CPTC: { logo: 'ab12cd.png' } });
    const bad = await call('PATCH', '/api/groups/CPTC', { logo: 'x/y.png' });
    expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/logo/);
    const clear = await call('PATCH', '/api/groups/CPTC', { logo: null });
    expect(clear.body.folderMeta).toEqual({});
  });
});

describe('MCP move_workspace with parent_id', () => {
  const run = (deps: ToolDeps, args: Record<string, unknown>) => callTool('move_workspace', args, deps) as Promise<Record<string, unknown>>;

  it('describes parent_id', () => {
    const t = TOOLS.find((x) => x.name === 'move_workspace')!;
    expect(t.description).toMatch(/parent_id/);
    expect(Object.keys(t.schema)).toContain('parent_id');
  });

  it('nests under a parent and adopts its folder; null clears', async () => {
    const { deps, make } = setup();
    const p = make('P', 'School'); const c = make('C');
    expect(await run(deps, { workspace_id: c, parent_id: p })).toMatchObject({ parent: p, group: 'School' });
    const cleared = await run(deps, { workspace_id: c, parent_id: null });
    expect(cleared.parent ?? null).toBeNull();
    expect(cleared.group).toBe('School');
  });

  it('group alone still works and un-nests', async () => {
    const { deps, make } = setup();
    const p = make('P', 'School'); const c = make('C');
    await run(deps, { workspace_id: c, parent_id: p });
    const moved = await run(deps, { workspace_id: c, group: null });
    expect(moved.group).toBeNull();
    expect(moved.parent ?? null).toBeNull();
  });

  it('refuses a cycle, a conflicting group, and a call with neither field', async () => {
    const { deps, make } = setup();
    const a = make('A', 'X'); const b = make('B');
    await run(deps, { workspace_id: b, parent_id: a });
    await expect(run(deps, { workspace_id: a, parent_id: b })).rejects.toThrow(/inside/);
    const c = make('C');
    await expect(run(deps, { workspace_id: c, parent_id: a, group: 'Other' })).rejects.toThrow(/folder/);
    await expect(run(deps, { workspace_id: c })).rejects.toThrow(/group or parent_id/);
  });

  it('list_workspaces shows parent and appearance', async () => {
    const { deps, make, call } = setup();
    const p = make('P'); const c = make('C');
    await run(deps, { workspace_id: c, parent_id: p });
    await call('PATCH', `/api/workspaces/${p}`, { appearance: { icon: 'star' } });
    const list = await callTool('list_workspaces', {}, deps) as Array<{ id: string; parent?: string; appearance?: unknown }>;
    expect(list.find((w) => w.id === c)!.parent).toBe(p);
    expect(list.find((w) => w.id === p)!.appearance).toEqual({ icon: 'star' });
  });
});
