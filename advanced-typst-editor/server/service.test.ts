import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = createSettingsStore(dataDir, { now: () => 1000 });
  const svc = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= Template\n', now: () => 1000 });
  return { dataDir, bus, events, settings, svc };
}

describe('workspace service', () => {
  it('creates a library workspace from the template and lists it', () => {
    const { svc, dataDir, events } = setup();
    const w = svc.create({ name: 'My: Report?', group: 'CPTC', source: undefined });
    expect(w.library).toBe(true);
    expect(w.path).toBe(path.join(dataDir, 'workspaces', 'My_ Report_'));
    expect(fs.readFileSync(path.join(w.path, 'main.typ'), 'utf8')).toBe('= Template\n');
    expect(svc.list()).toEqual([{ ...w, status: 'ok' }]);
    expect(events.some((e) => e.type === 'workspaces.changed')).toBe(true);
    const w2 = svc.create({ name: 'My: Report?', group: null, source: '= Two' });
    expect(path.basename(w2.path)).toBe('My_ Report_ (2)');
  });

  it('opens an external folder once, refuses roots and the data dir', () => {
    const { svc, dataDir } = setup();
    const ext = tmpDir(); dirs.push(ext);
    put(ext, 'main.typ', '= Ext');
    const w = svc.openFolder(ext, undefined);
    expect(w.library).toBe(false);
    expect(w.name).toBe(path.basename(ext));
    expect(svc.openFolder(ext, 'x').id).toBe(w.id);
    expect(() => svc.openFolder('C:\\', undefined)).toThrow(/drive root/);
    expect(() => svc.openFolder(dataDir, undefined)).toThrow(/data folder/);
    expect(() => svc.openFolder(path.join(ext, 'missing'), undefined)).toThrow(/not a folder/);
  });

  it('renames (folder too, for library), regroups, and removes to trash', () => {
    const { svc, dataDir } = setup();
    const w = svc.create({ name: 'A', group: null, source: undefined });
    const r = svc.rename(w.id, 'B');
    expect(r.name).toBe('B');
    expect(fs.existsSync(path.join(dataDir, 'workspaces', 'B', 'main.typ'))).toBe(true);
    expect(svc.setGroup(w.id, 'G').group).toBe('G');
    svc.remove(w.id);
    expect(svc.list()).toEqual([]);
    const trash = fs.readdirSync(path.join(dataDir, 'trash'));
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDir, 'trash', trash[0]!, 'B', 'main.typ'))).toBe(true);
  });

  it('reports a missing external workspace instead of dropping it', () => {
    const { svc } = setup();
    const ext = tmpDir();
    put(ext, 'main.typ', '');
    const w = svc.openFolder(ext, undefined);
    rmDir(ext);
    expect(svc.list()[0]).toMatchObject({ id: w.id, status: 'missing' });
    expect(() => svc.detail(w.id)).toThrow(/missing/);
  });

  it('writes go through the service and emit with the origin', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'A', group: null, source: undefined });
    events.length = 0;
    svc.writeFile(w.id, 'main.typ', Buffer.from('= X'), 'client-1');
    expect(events.at(-1)).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: 'client-1' });
    const a = svc.addAsset(w.id, { kind: 'image', filename: 'x.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), folder: 'shots' }, 'mcp');
    expect(events.at(-1)).toMatchObject({ type: 'workspace.changed', id: w.id, paths: ['assets/shots/x.png'], origin: 'mcp' });
    const d = svc.detail(w.id);
    expect(d.assets.map((x) => x.id)).toEqual([a.id]);
    expect(d.folders.map((f) => f.id)).toEqual(['shots']);
    expect(d.files.map((f) => f.path).sort()).toEqual(['assets/shots/x.png', 'main.typ']);
  });
});
