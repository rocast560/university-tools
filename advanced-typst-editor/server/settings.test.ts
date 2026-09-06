import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('settings store', () => {
  it('returns defaults when the file is missing or corrupt', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    fs.writeFileSync(path.join(d, 'settings.json'), '{not json');
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('registers, patches and removes workspaces', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d, { now: () => 5 });
    const w = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: null, library: true });
    expect(w.createdAt).toBe(5);
    expect(s.getWorkspace(w.id)?.name).toBe('A');
    expect(s.findByPath(path.join(d, 'WS', 'a'))?.id).toBe(w.id); // case-insensitive on Windows
    expect(s.patchWorkspace(w.id, { name: 'B', group: 'G' })).toMatchObject({ name: 'B', group: 'G' });
    expect(s.removeWorkspace(w.id)).toBe(true);
    expect(s.listWorkspaces()).toEqual([]);
  });

  it('scans the library for unknown folders', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'Report One'), { recursive: true });
    fs.mkdirSync(path.join(lib, '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'restored-2026'), { recursive: true });
    const s = createSettingsStore(d);
    const added = s.scanLibrary(lib);
    expect(added.map((w) => w.name)).toEqual(['Report One']);
    expect(added[0]?.library).toBe(true);
    expect(s.scanLibrary(lib)).toEqual([]);
  });

  it('re-points a library workspace whose folder moved with the data dir, keeping its id and group', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const stale = s.addWorkspace({ path: path.join(d, 'gone', 'workspaces', 'report'), name: 'report', group: 'CPTC', library: true });

    expect(s.scanLibrary(lib)).toEqual([]); // the folder is claimed by the healed entry, nothing new
    const list = s.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: stale.id, name: 'report', group: 'CPTC', path: path.resolve(lib, 'report') });
  });

  it('folds a stale duplicate into the entry that owns the folder and passes on its group', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const live = s.addWorkspace({ path: path.join(lib, 'report'), name: 'report', group: null, library: true });
    s.addWorkspace({ path: path.join(d, 'gone', 'workspaces', 'report'), name: 'report', group: 'CPTC', library: true });

    s.scanLibrary(lib);
    const list = s.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: live.id, group: 'CPTC', path: path.resolve(lib, 'report') });
  });

  it('never re-points an external workspace, even when a library folder shares its name', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const external = s.addWorkspace({ path: path.join(d, 'elsewhere', 'report'), name: 'report', group: null, library: false });

    const added = s.scanLibrary(lib);
    expect(added).toHaveLength(1); // the library folder is registered on its own
    expect(s.getWorkspace(external.id)?.path).toBe(path.resolve(d, 'elsewhere', 'report'));
  });

  it('creates, renames and removes groups, keeping member workspaces in sync', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d, { now: () => 5 });
    expect(s.addGroup('CPTC')).toEqual(['CPTC']);
    expect(s.addGroup('ECE')).toEqual(['CPTC', 'ECE']);
    expect(s.listGroups()).toEqual(['CPTC', 'ECE']);
    const w = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: 'CPTC', library: true });
    expect(s.renameGroup('CPTC', 'CPTC 2026')).toEqual(['CPTC 2026', 'ECE']);
    expect(s.getWorkspace(w.id)?.group).toBe('CPTC 2026');
    expect(s.removeGroup('CPTC 2026')).toEqual(['ECE']);
    expect(s.getWorkspace(w.id)?.group).toBeNull();
  });

  it('groups survive with no members, and adding an existing name is a no-op', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('Empty');
    expect(s.addGroup('Empty')).toEqual(['Empty']);
    expect(s.listGroups()).toEqual(['Empty']);
  });

  it('clamps backup and redaction settings', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    const out = s.update((cur) => ({ ...cur, backup: { ...cur.backup, keepSnapshots: 0, snapshotIntervalMin: 0.2 }, redaction: { style: 'pixelate', strength: 99 } }));
    expect(out.backup.keepSnapshots).toBe(30);
    expect(out.backup.snapshotIntervalMin).toBe(60);
    expect(out.redaction).toEqual({ style: 'pixelate', strength: 3 });
  });
});
