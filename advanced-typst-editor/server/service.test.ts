import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import type { Watcher } from './watcher';
import { tmpDir, rmDir, put } from './test-util';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

type ChangedEvent = Extract<ServerEvent, { type: 'workspace.changed' }>;
const changes = (events: ServerEvent[]): ChangedEvent[] => events.filter((e): e is ChangedEvent => e.type === 'workspace.changed');

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

  it('creates, renames and deletes sidebar groups, notifying workspaces.changed', () => {
    const { svc, events } = setup();
    svc.createGroup('CPTC');
    expect(svc.listGroups()).toEqual(['CPTC']);
    expect(events.filter((e) => e.type === 'workspaces.changed').length).toBeGreaterThan(0);
    const w = svc.create({ name: 'A', group: 'CPTC', source: undefined });
    svc.renameGroup('CPTC', 'CPTC 2026');
    expect(svc.listGroups()).toEqual(['CPTC 2026']);
    expect(svc.entry(w.id).group).toBe('CPTC 2026');
    svc.deleteGroup('CPTC 2026');
    expect(svc.listGroups()).toEqual([]);
    expect(svc.entry(w.id).group).toBeNull();
  });

  it('rejects an empty or duplicate group name', () => {
    const { svc } = setup();
    expect(() => svc.createGroup('  ')).toThrow(/empty/);
    svc.createGroup('CPTC');
    expect(() => svc.createGroup('CPTC')).toThrow(/exists/);
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

  it('detail() returns a freshly bumped openedAt, not the stale pre-patch value', () => {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const bus = createEventBus();
    let clock = 1000;
    const settings = createSettingsStore(dataDir, { now: () => clock });
    const svc = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T\n', now: () => clock });
    const w = svc.create({ name: 'A', group: null, source: undefined });
    expect(w.openedAt).toBe(1000);
    clock = 2000;
    const d = svc.detail(w.id);
    expect(d.entry.openedAt).toBe(2000);
    expect(d.entry.openedAt).toBeGreaterThanOrEqual(w.createdAt);
  });

  it('a no-op rename (or a case-only change) keeps the same folder', () => {
    const { svc, dataDir } = setup();
    const w = svc.create({ name: 'A', group: null, source: undefined });
    const r1 = svc.rename(w.id, 'A');
    expect(r1.path).toBe(w.path);
    expect(fs.existsSync(path.join(dataDir, 'workspaces', 'A (2)'))).toBe(false);
    const r2 = svc.rename(w.id, 'a');
    expect(r2.path).toBe(w.path);
    expect(r2.name).toBe('a');
  });

  it('R9: an already-registered path returns its entry even past the entry-count limit', () => {
    const { svc } = setup();
    const ext = tmpDir(); dirs.push(ext);
    put(ext, 'main.typ', '= Ext');
    const w = svc.openFolder(ext, undefined);
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(ext, `f${i}.txt`), '');
    expect(svc.openFolder(ext, 'x').id).toBe(w.id);
  });

  it('refuses a new folder with more than 5,000 entries', () => {
    const { svc } = setup();
    const big = tmpDir(); dirs.push(big);
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
    expect(() => svc.openFolder(big, undefined)).toThrow(/5000/);
  });

  it('marks only the .typ files actually rewritten as own-writes, not every .typ file', () => {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const bus = createEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const settings = createSettingsStore(dataDir, { now: () => 1000 });
    const marked: string[] = [];
    const watcher: Watcher = {
      watch() {},
      unwatch() {},
      markOwnWrite(_id, rel) { marked.push(rel); },
      close() {},
    };
    const svc = createWorkspaceService({ settings, bus, watcher, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= Template\n', now: () => 1000 });
    const w = svc.create({ name: 'A', group: null, source: '#image("/assets/a.png")' });
    svc.addAsset(w.id, { kind: 'image', filename: 'a.png', bytes: PNG_1x1, folder: null }, null);
    svc.writeFile(w.id, 'other.typ', Buffer.from('no references here'), null);

    marked.length = 0;
    events.length = 0;
    svc.renameAsset(w.id, 'assets/a.png', 'b', null);

    expect(marked).toEqual(expect.arrayContaining(['main.typ', 'assets/a.png', 'assets/b.png', 'workspace.json']));
    expect(marked).not.toContain('other.typ');
    const announced = changes(events).flatMap((e) => e.paths);
    expect(announced).toEqual(expect.arrayContaining(['main.typ', 'assets/a.png', 'assets/b.png']));
    expect(announced).not.toContain('other.typ');
  });

  // ── The reference rewrite belongs to nobody ──────────────────────────────
  // Renaming/moving an asset or a folder rewrites every .typ file that pointed
  // at it. An open editor ignores workspace.changed events carrying its own
  // client id (that filter exists so its autosave writes don't echo back as
  // external changes), so attributing the server's rewrite to the tab that
  // asked for the move would leave that tab's buffer on the pre-rewrite path --
  // and its next autosave would put the stale path straight back over the
  // rewrite. The rewritten sources therefore go out with origin: null.

  it('announces an asset rename/move rewrite with a null origin, the asset paths with the caller`s', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'A', group: null, source: '#image("/assets/shots/a.png")\n' });
    svc.addAsset(w.id, { kind: 'image', filename: 'a.png', bytes: PNG_1x1, folder: 'shots' }, 'client-1');

    events.length = 0;
    svc.renameAsset(w.id, 'assets/shots/a.png', 'b', 'client-1');
    let ch = changes(events);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['assets/shots/a.png', 'assets/shots/b.png'], origin: 'client-1' });
    expect(ch[1]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: null });

    events.length = 0;
    svc.moveAsset(w.id, 'assets/shots/b.png', null, 'client-1');
    ch = changes(events);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['assets/shots/b.png', 'assets/b.png'], origin: 'client-1' });
    expect(ch[1]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: null });
  });

  it('announces a folder rename/delete rewrite with a null origin too', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'A', group: null, source: '#image("/assets/shots/a.png")\n' });
    svc.addAsset(w.id, { kind: 'image', filename: 'a.png', bytes: PNG_1x1, folder: 'shots' }, null);

    events.length = 0;
    svc.renameFolder(w.id, 'shots', 'screens', 'client-1');
    let ch = changes(events);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['assets/shots', 'assets/screens'], origin: 'client-1' });
    expect(ch[1]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: null });

    events.length = 0;
    svc.deleteFolder(w.id, 'screens', 'client-1');
    ch = changes(events);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['assets/screens'], origin: 'client-1' });
    expect(ch[1]).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: null });
  });

  it('skips the rewrite event entirely when no .typ file referenced the asset', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'A', group: null, source: '= nothing references it\n' });
    svc.addAsset(w.id, { kind: 'image', filename: 'a.png', bytes: PNG_1x1, folder: 'shots' }, null);

    events.length = 0;
    svc.renameFolder(w.id, 'shots', 'screens', 'client-1');
    expect(changes(events)).toEqual([
      { type: 'workspace.changed', id: w.id, paths: ['assets/shots', 'assets/screens'], origin: 'client-1' },
    ]);
  });
});
