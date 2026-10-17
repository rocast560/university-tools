import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createHandler } from './router';
import { restoreDocument, scanTrash, trashDocument, SIDECAR } from './trash';
import { stamp } from './fsx';
import { tmpDir, rmDir, put } from './test-util';
import { TOOLS, callTool, type ToolDeps } from './mcp-tools';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0, 0);

/** A service over a temp data dir. `clock.t` moves time so each delete gets its own stamp folder. */
function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const clock = { t: T0 };
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = createSettingsStore(dataDir, { now: () => clock.t });
  const workspacesDir = path.join(dataDir, 'workspaces');
  const svc = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '= T\n', now: () => clock.t });
  const trashDir = path.join(dataDir, 'trash');
  return { dataDir, workspacesDir, trashDir, clock, bus, events, settings, svc };
}
const sidecar = (trashDir: string, st: string) => JSON.parse(fs.readFileSync(path.join(trashDir, st, SIDECAR), 'utf8')) as { items: Array<Record<string, unknown>> };

describe('trash sidecar written by both delete paths', () => {
  it('a document delete writes .trash.json with the full registry entry', () => {
    const { svc, trashDir } = setup();
    const parent = svc.create({ name: 'Parent', group: 'School/ECE', source: undefined });
    const w = svc.create({ name: 'Lab 4', group: 'School/ECE', source: undefined });
    svc.setParent(w.id, parent.id);
    svc.setAppearance(w.id, { icon: 'flask', color: '#ff6c52' });
    svc.remove(w.id);
    const [st] = fs.readdirSync(trashDir);
    expect(fs.existsSync(path.join(trashDir, st!, 'Lab 4', 'main.typ'))).toBe(true);
    const sc = sidecar(trashDir, st!);
    expect(sc.items).toHaveLength(1);
    expect(sc.items[0]).toMatchObject({
      kind: 'document', name: 'Lab 4', originalPath: w.path, deletedAt: T0,
      entry: { name: 'Lab 4', group: 'School/ECE', parent: parent.id, library: true, appearance: { icon: 'flask', color: '#ff6c52' } },
    });
    expect(fs.readdirSync(path.join(trashDir, st!)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a file delete and an asset delete write a files record with the workspace id', () => {
    const { svc, trashDir } = setup();
    const w = svc.create({ name: 'Keep', group: null, source: undefined });
    svc.writeFile(w.id, 'notes.txt', Buffer.from('note'), null);
    put(w.path, 'assets/shot.png', 'png');
    svc.deleteFile(w.id, 'notes.txt', null);
    svc.deleteAsset(w.id, 'assets/shot.png', null);
    const [st] = fs.readdirSync(trashDir);
    const sc = sidecar(trashDir, st!);
    expect(sc.items).toHaveLength(1);
    expect(sc.items[0]).toMatchObject({ kind: 'files', name: 'Keep', workspaceId: w.id, deletedAt: T0 });
    expect((sc.items[0] as { files: unknown[] }).files).toEqual([
      { original: 'notes.txt', stored: 'notes.txt' },
      { original: 'assets/shot.png', stored: 'assets/shot.png' },
    ]);
  });
});

describe('listing the trash', () => {
  it('finds sidecar items and both legacy kinds, newest first, with sizes and counts', () => {
    const { svc, trashDir, dataDir, clock } = setup();
    // legacy document: workspace.json at its top, no sidecar
    put(trashDir, '2026-01-01T00-00-00-000Z/Old Report/workspace.json', '{"version":1,"assets":{},"fonts":{}}');
    put(trashDir, '2026-01-01T00-00-00-000Z/Old Report/main.typ', '= old');
    // legacy files of a workspace that is live
    const live = svc.create({ name: 'Live', group: null, source: undefined });
    put(trashDir, '2026-02-01T00-00-00-000Z/Live/assets/a.png', 'aaaa');
    put(trashDir, '2026-02-01T00-00-00-000Z/Live/b.txt', 'bb');
    // legacy files of a workspace that no longer exists
    put(trashDir, '2026-03-01T00-00-00-000Z/Gone/c.txt', 'c');
    // a new-style document delete
    clock.t = T0;
    const w = svc.create({ name: 'New One', group: null, source: undefined });
    svc.remove(w.id);

    const list = svc.listTrash();
    expect(list.map((e) => e.name)).toEqual(['New One', 'c.txt', '2 files', 'Old Report']);
    const byName = Object.fromEntries(list.map((e) => [e.name, e]));
    expect(byName['New One']).toMatchObject({ kind: 'document', canRestore: true, reason: null, deletedAt: T0, fileCount: 1 });
    expect(byName['Old Report']).toMatchObject({ kind: 'document', canRestore: true, fileCount: 2, deletedAt: Date.UTC(2026, 0, 1) });
    expect(byName['Old Report']!.size).toBe('{"version":1,"assets":{},"fonts":{}}'.length + '= old'.length);
    expect(byName['2 files']).toMatchObject({ kind: 'files', workspace: 'Live', canRestore: true, size: 6, fileCount: 2, deletedAt: Date.UTC(2026, 1, 1) });
    expect(byName['c.txt']).toMatchObject({ kind: 'files', workspace: 'Gone', canRestore: false, reason: "its document isn't in the app; restore the document first" });
    expect(live.id).toBeTruthy();
    expect(list[0]!.id).toBe(`${stamp(T0)}/New One`);
    // listing never changes the trash
    expect(fs.readFileSync(path.join(trashDir, '2026-03-01T00-00-00-000Z/Gone/c.txt'), 'utf8')).toBe('c');
    expect(fs.existsSync(path.join(dataDir, 'trash', '2026-03-01T00-00-00-000Z', SIDECAR))).toBe(false);
  });

  it('an empty or missing trash lists nothing', () => {
    const { svc, trashDir } = setup();
    expect(svc.listTrash()).toEqual([]);
    fs.mkdirSync(trashDir, { recursive: true });
    expect(svc.listTrash()).toEqual([]);
  });
});

describe('restoring a document', () => {
  it('moves it back, re-registers with group, appearance and a parent that still exists, and announces it', () => {
    const { svc, trashDir, events, settings } = setup();
    const parent = svc.create({ name: 'Parent', group: 'School/ECE', source: undefined });
    const w = svc.create({ name: 'Lab 4', group: 'School/ECE', source: '= lab four\n' });
    svc.setParent(w.id, parent.id);
    svc.setAppearance(w.id, { icon: 'flask', color: '#ff6c52' });
    svc.remove(w.id);
    expect(fs.existsSync(w.path)).toBe(false);
    events.length = 0;

    const [item] = svc.listTrash();
    const res = svc.restoreFromTrash(item!.id);
    expect(fs.readFileSync(path.join(w.path, 'main.typ'), 'utf8')).toBe('= lab four\n');
    const back = settings.getWorkspace(res.workspaceId)!;
    expect(back).toMatchObject({ name: 'Lab 4', path: w.path, group: 'School/ECE', parent: parent.id, library: true, appearance: { icon: 'flask', color: '#ff6c52' } });
    expect(res).toMatchObject({ kind: 'document', renamed: false, location: 'School/ECE/Lab 4' });
    expect(res.message).toBe('Restored to School/ECE/Lab 4');
    expect(events.some((e) => e.type === 'workspaces.changed')).toBe(true);
    expect(svc.listTrash()).toEqual([]);
    expect(fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : []).toEqual([]);
  });

  it('recreates a folder that no longer exists and drops a parent that is gone', () => {
    const { svc, settings } = setup();
    const parent = svc.create({ name: 'Parent', group: 'Old', source: undefined });
    const w = svc.create({ name: 'Child', group: 'Old', source: undefined });
    svc.setParent(w.id, parent.id);
    svc.remove(w.id);
    svc.remove(parent.id);
    svc.deleteGroup('Old');
    expect(settings.listGroups()).not.toContain('Old');
    const child = svc.listTrash().find((e) => e.name === 'Child')!;
    const res = svc.restoreFromTrash(child.id);
    const back = settings.getWorkspace(res.workspaceId)!;
    expect(back.group).toBe('Old');
    expect(back.parent ?? null).toBeNull();
    expect(settings.listGroups()).toContain('Old');
  });

  it('a taken original path gets a "(restored)" name, then "(restored 2)", and never overwrites', () => {
    const { svc, clock, settings } = setup();
    const a = svc.create({ name: 'Lab', group: null, source: '= first\n' });
    svc.remove(a.id);
    const b = svc.create({ name: 'Lab', group: null, source: '= second\n' });
    clock.t += 1000;
    svc.remove(b.id);
    const c = svc.create({ name: 'Lab', group: null, source: '= live\n' });

    const [newest, oldest] = svc.listTrash();
    const r1 = svc.restoreFromTrash(newest!.id);
    expect(r1).toMatchObject({ renamed: true, location: 'Lab (restored)' });
    expect(r1.message).toBe("Restored as 'Lab (restored)'");
    const r2 = svc.restoreFromTrash(oldest!.id);
    expect(r2.renamed).toBe(true);
    expect(settings.getWorkspace(r2.workspaceId)!.name).toBe('Lab (restored 2)');
    expect(fs.readFileSync(path.join(c.path, 'main.typ'), 'utf8')).toBe('= live\n');
    expect(fs.readFileSync(path.join(path.dirname(c.path), 'Lab (restored)', 'main.typ'), 'utf8')).toBe('= second\n');
    expect(fs.readFileSync(path.join(path.dirname(c.path), 'Lab (restored 2)', 'main.typ'), 'utf8')).toBe('= first\n');
  });

  it('restores a legacy document (no sidecar) to data/workspaces/<folder> with no group or parent', () => {
    const { svc, trashDir, workspacesDir, settings } = setup();
    put(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/workspace.json', '{"version":1,"assets":{},"fonts":{}}');
    put(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/main.typ', '= legacy');
    const [item] = svc.listTrash();
    const res = svc.restoreFromTrash(item!.id);
    expect(fs.readFileSync(path.join(workspacesDir, 'Legacy Doc', 'main.typ'), 'utf8')).toBe('= legacy');
    expect(settings.getWorkspace(res.workspaceId)).toMatchObject({ name: 'Legacy Doc', group: null, library: true });
    expect(svc.listTrash()).toEqual([]);
  });

  it('refuses an unknown id and leaves the trash alone', () => {
    const { svc, trashDir } = setup();
    put(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/workspace.json', '{}');
    expect(() => svc.restoreFromTrash('nope/nothing')).toThrow(/not in the trash/);
    expect(() => svc.restoreFromTrash('2026-01-01T00-00-00-000Z/../../etc')).toThrow(/not in the trash/);
    expect(fs.existsSync(path.join(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/workspace.json'))).toBe(true);
  });
});

describe('restoring files', () => {
  it('puts files back at their relative paths and announces the workspace', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'Rep', group: null, source: undefined });
    svc.writeFile(w.id, 'chapters/intro.typ', Buffer.from('intro'), null);
    put(w.path, 'assets/f/shot.png', 'png');
    svc.deleteFile(w.id, 'chapters/intro.typ', null);
    svc.deleteAsset(w.id, 'assets/f/shot.png', null);
    events.length = 0;
    const [item] = svc.listTrash();
    expect(item).toMatchObject({ kind: 'files', workspace: 'Rep', fileCount: 2, canRestore: true });
    const res = svc.restoreFromTrash(item!.id);
    expect(fs.readFileSync(path.join(w.path, 'chapters', 'intro.typ'), 'utf8')).toBe('intro');
    expect(fs.readFileSync(path.join(w.path, 'assets', 'f', 'shot.png'), 'utf8')).toBe('png');
    expect(res).toMatchObject({ kind: 'files', renamed: false, workspaceId: w.id });
    const ch = events.filter((e) => e.type === 'workspace.changed');
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ id: w.id, origin: null });
    expect((ch[0] as { paths: string[] }).paths.sort()).toEqual(['assets/f/shot.png', 'chapters/intro.typ']);
    expect(svc.listTrash()).toEqual([]);
  });

  it('keeps an asset\'s crop and blur through delete and restore, under the restored name too', () => {
    const { svc, trashDir } = setup();
    const w = svc.create({ name: 'Rep', group: null, source: undefined });
    put(w.path, 'assets/shot.png', 'png');
    const crop = { x: 0, y: 0, w: 1, h: 0.5 };
    const blurs = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    svc.patchAsset(w.id, 'assets/shot.png', { crop, blurs, width: 640, height: 480 }, null);
    svc.deleteAsset(w.id, 'assets/shot.png', null);
    expect(svc.fs(w.id).readMeta().assets['assets/shot.png']).toBeUndefined();
    const [st] = fs.readdirSync(trashDir);
    const rec = sidecar(trashDir, st!).items[0] as { files: Array<{ meta?: { kind: string; record: Record<string, unknown> } }> };
    expect(rec.files[0]!.meta).toMatchObject({ kind: 'assets', record: { crop, blurs, width: 640, height: 480 } });

    // the original name is taken again, so it comes back as "(restored)"
    put(w.path, 'assets/shot.png', 'new');
    const [item] = svc.listTrash();
    const res = svc.restoreFromTrash(item!.id);
    expect(res.renamed).toBe(true);
    const meta = svc.fs(w.id).readMeta();
    expect(meta.assets['assets/shot (restored).png']).toMatchObject({ crop, blurs, width: 640, height: 480 });
    expect(meta.assets['assets/shot.png']).toBeUndefined();
    expect(svc.fs(w.id).getAsset('assets/shot (restored).png').crop).toEqual(crop);
  });

  it('keeps a font\'s family the same way, and a legacy asset item restores with no metadata', () => {
    const { svc, trashDir } = setup();
    const w = svc.create({ name: 'Rep', group: null, source: undefined });
    put(w.path, 'fonts/Foo.ttf', 'ttf');
    svc.patchAsset(w.id, 'fonts/Foo.ttf', { family: 'Foo Sans' }, null);
    svc.deleteAsset(w.id, 'fonts/Foo.ttf', null);
    put(trashDir, '2026-02-01T00-00-00-000Z/Rep/assets/old.png', 'legacy');
    for (const it of svc.listTrash()) svc.restoreFromTrash(it.id);
    expect(svc.fs(w.id).readMeta().fonts['fonts/Foo.ttf']).toEqual({ family: 'Foo Sans' });
    expect(svc.fs(w.id).getAsset('assets/old.png').crop).toBeNull();
  });

  it('never overwrites: a taken path gets a free "(restored)" name', () => {
    const { svc } = setup();
    const w = svc.create({ name: 'Rep', group: null, source: undefined });
    svc.writeFile(w.id, 'refs.bib', Buffer.from('old'), null);
    svc.deleteFile(w.id, 'refs.bib', null);
    svc.writeFile(w.id, 'refs.bib', Buffer.from('new'), null);
    const [item] = svc.listTrash();
    const res = svc.restoreFromTrash(item!.id);
    expect(res.renamed).toBe(true);
    expect(fs.readFileSync(path.join(w.path, 'refs.bib'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(w.path, 'refs (restored).bib'), 'utf8')).toBe('old');
  });

  it('restores a legacy files item into the workspace whose folder name matches, and lists one with no match as disabled', () => {
    const { svc, trashDir } = setup();
    const w = svc.create({ name: 'Matches', group: null, source: undefined });
    put(trashDir, '2026-02-01T00-00-00-000Z/Matches/assets/old.png', 'legacy');
    put(trashDir, '2026-02-02T00-00-00-000Z/Nobody/x.txt', 'x');
    const list = svc.listTrash();
    const nobody = list.find((e) => e.workspace === 'Nobody')!;
    expect(nobody).toMatchObject({ canRestore: false, reason: "its document isn't in the app; restore the document first" });
    expect(() => svc.restoreFromTrash(nobody.id)).toThrow(/restore the document first/);
    expect(fs.readFileSync(path.join(trashDir, '2026-02-02T00-00-00-000Z/Nobody/x.txt'), 'utf8')).toBe('x');
    const ok = list.find((e) => e.workspace === 'Matches')!;
    svc.restoreFromTrash(ok.id);
    expect(fs.readFileSync(path.join(w.path, 'assets', 'old.png'), 'utf8')).toBe('legacy');
  });
});

describe('cleaning up after a restore', () => {
  it('removes a stamp folder only when it is empty', () => {
    const { svc, trashDir, clock } = setup();
    // two documents deleted in the same millisecond share one stamp folder
    const a = svc.create({ name: 'A', group: null, source: undefined });
    const b = svc.create({ name: 'B', group: null, source: undefined });
    clock.t = T0;
    svc.remove(a.id);
    svc.remove(b.id);
    const st = stamp(T0);
    expect(fs.readdirSync(path.join(trashDir, st)).sort()).toEqual([SIDECAR, 'A', 'B'].sort());
    expect(sidecar(trashDir, st).items).toHaveLength(2);
    const [first, second] = svc.listTrash();
    svc.restoreFromTrash(first!.id);
    expect(fs.existsSync(path.join(trashDir, st))).toBe(true);
    expect(sidecar(trashDir, st).items).toHaveLength(1);
    svc.restoreFromTrash(second!.id);
    expect(fs.existsSync(path.join(trashDir, st))).toBe(false);
  });

  it('keeps the stamp folder when something else is still in it', () => {
    const { svc, trashDir } = setup();
    const a = svc.create({ name: 'A', group: null, source: undefined });
    svc.remove(a.id);
    const st = stamp(T0);
    put(trashDir, `${st}/stray.txt`, 'keep me');
    const [item] = svc.listTrash();
    svc.restoreFromTrash(item!.id);
    expect(fs.readFileSync(path.join(trashDir, st, 'stray.txt'), 'utf8')).toBe('keep me');
  });

  it('removes only the emptied folders of a files item, never other files', () => {
    const { svc, trashDir } = setup();
    const w = svc.create({ name: 'Rep', group: null, source: undefined });
    put(w.path, 'assets/a/one.png', '1');
    put(w.path, 'assets/b/two.png', '2');
    svc.deleteAsset(w.id, 'assets/a/one.png', null);
    svc.deleteAsset(w.id, 'assets/b/two.png', null);
    const [item] = svc.listTrash();
    svc.restoreFromTrash(item!.id);
    expect(fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : []).toEqual([]);
  });

  it('restoring never deletes anything else in the trash', () => {
    const { svc, trashDir, clock } = setup();
    put(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/workspace.json', '{}');
    put(trashDir, '2026-01-01T00-00-00-000Z/Legacy Doc/main.typ', 'legacy text');
    put(trashDir, '2026-02-01T00-00-00-000Z/Gone/c.txt', 'c');
    const w = svc.create({ name: 'Fresh', group: null, source: undefined });
    clock.t = T0;
    svc.remove(w.id);
    const before = (): string[] => {
      const out: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(trashDir, p).replaceAll('\\', '/')); } };
      walk(trashDir);
      return out.sort();
    };
    const snap = before();
    const fresh = svc.listTrash().find((e) => e.name === 'Fresh')!;
    svc.restoreFromTrash(fresh.id);
    const after = before();
    // exactly the restored item's files (and its sidecar) left; every other file is still there
    expect(after).toEqual(snap.filter((p) => !p.startsWith(`${stamp(T0)}/`)));
    expect(after).toContain('2026-01-01T00-00-00-000Z/Legacy Doc/main.typ');
    expect(after).toContain('2026-02-01T00-00-00-000Z/Gone/c.txt');
  });
});

describe('cross-drive restore', () => {
  const exdev = (): never => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };

  function trashed() {
    const root = tmpDir(); dirs.push(root);
    const trashDir = path.join(root, 'trash');
    const workspacesDir = path.join(root, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });
    put(trashDir, '2026-01-01T00-00-00-000Z/Doc/workspace.json', '{}');
    put(trashDir, '2026-01-01T00-00-00-000Z/Doc/sub/deep.typ', 'deep');
    const item = scanTrash(trashDir)[0]!;
    return { trashDir, workspacesDir, item };
  }

  it('copies first and removes the trash copy only after the copy succeeded', () => {
    const { trashDir, workspacesDir, item } = trashed();
    let trashSeenAtCopyEnd = false;
    const out = restoreDocument(trashDir, item, workspacesDir, {
      rename: exdev,
      copyDir: (from, to) => { fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false }); trashSeenAtCopyEnd = fs.existsSync(path.join(from, 'sub', 'deep.typ')) && fs.existsSync(path.join(to, 'sub', 'deep.typ')); },
    });
    expect(trashSeenAtCopyEnd).toBe(true);
    expect(fs.readFileSync(path.join(workspacesDir, 'Doc', 'sub', 'deep.typ'), 'utf8')).toBe('deep');
    expect(out.dir).toBe(path.join(workspacesDir, 'Doc'));
    expect(fs.existsSync(path.join(trashDir, '2026-01-01T00-00-00-000Z'))).toBe(false);
  });

  it('a failed copy leaves the trash copy untouched and no half-restored folder', () => {
    const { trashDir, workspacesDir, item } = trashed();
    expect(() => restoreDocument(trashDir, item, workspacesDir, {
      rename: exdev,
      copyDir: (_from, to) => { fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, 'half.txt'), 'x'); throw new Error('disk full'); },
    })).toThrow(/disk full/);
    expect(fs.readFileSync(path.join(trashDir, '2026-01-01T00-00-00-000Z/Doc/sub/deep.typ'), 'utf8')).toBe('deep');
    expect(fs.existsSync(path.join(workspacesDir, 'Doc'))).toBe(false);
  });

  it('trashing a document across drives copies first too', () => {
    const root = tmpDir(); dirs.push(root);
    const src = path.join(root, 'ws', 'Doc');
    put(src, 'main.typ', 'main');
    const trashDir = path.join(root, 'trash');
    trashDocument(trashDir, stamp(T0), src, { kind: 'document', name: 'Doc', originalPath: src, deletedAt: T0, entry: { id: 'i', name: 'Doc', group: null, library: true } }, {
      rename: exdev,
      copyDir: (from, to) => fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false }),
    });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(path.join(trashDir, stamp(T0), 'Doc', 'main.typ'), 'utf8')).toBe('main');
  });
});

describe('no way to erase the trash', () => {
  async function api() {
    const { svc, settings, bus, dataDir, trashDir } = setup();
    const handler = createHandler({ settings, service: svc, bus, token: null, staticDir: null, dataDir, backup: null, compile: null, mcp: null, browse: null });
    const call = (method: string, url: string, body?: unknown) =>
      handler(new Request(`http://127.0.0.1:8090${url}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { svc, call, trashDir, settings };
  }

  it('GET /api/trash lists and POST /api/trash/:id/restore restores (id carries a slash, percent-encoded)', async () => {
    const { svc, call } = await api();
    const w = svc.create({ name: 'Lab', group: null, source: '= x\n' });
    svc.remove(w.id);
    const listed = await (await call('GET', '/api/trash')).json() as { items: Array<{ id: string; name: string; canRestore: boolean }> };
    expect(listed.items.map((i) => i.name)).toEqual(['Lab']);
    const res = await call('POST', `/api/trash/${encodeURIComponent(listed.items[0]!.id)}/restore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'document', message: 'Restored to Lab' });
    expect(fs.existsSync(w.path)).toBe(true);
    const missing = await call('POST', `/api/trash/${encodeURIComponent('x/y')}/restore`);
    expect(missing.status).toBe(404);
  });

  it('has no empty-trash or permanent-delete route', async () => {
    const { svc, call, trashDir } = await api();
    const w = svc.create({ name: 'Lab', group: null, source: undefined });
    svc.remove(w.id);
    const [item] = svc.listTrash();
    for (const [m, u] of [
      ['DELETE', '/api/trash'], ['DELETE', `/api/trash/${encodeURIComponent(item!.id)}`], ['POST', '/api/trash/empty'], ['POST', '/api/trash/purge'],
      ['PATCH', `/api/trash/${encodeURIComponent(item!.id)}`], ['PUT', '/api/trash'], ['POST', '/api/trash'],
    ] as const) {
      const r = await call(m, u);
      expect([404, 405], `${m} ${u}`).toContain(r.status);
    }
    expect(fs.readdirSync(trashDir).length).toBe(1);
    expect(svc.listTrash()).toHaveLength(1);
  });

  it('the MCP tools are list_trash and restore_from_trash only', async () => {
    const { svc, settings, dataDir } = setup();
    const deps = { service: svc, settings, compile: {} as never, backup: {} as never, dataDir } as ToolDeps;
    const names = TOOLS.map((t) => t.name).filter((n) => /trash|empty|purge|permanent/i.test(n));
    expect(names.sort()).toEqual(['list_trash', 'restore_from_trash']);
    const w = svc.create({ name: 'Lab', group: null, source: undefined });
    svc.remove(w.id);
    const listed = await callTool('list_trash', {}, deps) as Array<{ id: string; name: string }>;
    expect(listed.map((i) => i.name)).toEqual(['Lab']);
    const res = await callTool('restore_from_trash', { id: listed[0]!.id }, deps);
    expect(res).toMatchObject({ kind: 'document', renamed: false });
    expect(fs.existsSync(w.path)).toBe(true);
    for (const t of TOOLS.filter((x) => x.name.includes('trash'))) expect(t.description.length).toBeGreaterThan(30);
  });
});
