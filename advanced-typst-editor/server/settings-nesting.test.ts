import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore } from './settings';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('settings store: nested documents and document appearance', () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, path: `/p/${id}`, name: id, group: null, library: true, createdAt: 1, openedAt: 1, ...extra });
  const seed = (d: string, workspaces: unknown[], extra: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ version: 1, workspaces, groups: [], ...extra }));
    return createSettingsStore(d);
  };

  it('loads an old settings.json that has none of the new fields unchanged', () => {
    const d = tmpDir(); dirs.push(d);
    const old = { version: 1, workspaces: [entry('a', { group: 'G' }), entry('b')], groups: ['G'], folderMeta: { G: { icon: 'shield', color: 'blue' } }, backup: { destinations: [], snapshotIntervalMin: 60, keepSnapshots: 30 }, typstCli: null, redaction: { style: 'gaussian', strength: 1 } };
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(old));
    const got = createSettingsStore(d).get();
    expect(got).toEqual(old);
    expect(got.workspaces[0]).not.toHaveProperty('parent');
    expect(got.workspaces[0]).not.toHaveProperty('appearance');
  });

  it('keeps a valid parent and appearance', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('p'), entry('c', { parent: 'p', appearance: { icon: 'book', color: 'teal', logo: 'ab12.png' } })]);
    const c = s.getWorkspace('c')!;
    expect(c.parent).toBe('p');
    expect(c.appearance).toEqual({ icon: 'book', color: 'teal', logo: 'ab12.png' });
  });

  it('drops a parent that is unknown, itself or part of a cycle', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [
      entry('gone', { parent: 'nobody' }), entry('self', { parent: 'self' }),
      entry('x', { parent: 'y' }), entry('y', { parent: 'z' }), entry('z', { parent: 'x' }),
      entry('ok', { parent: 'x' }),
    ]);
    expect(s.getWorkspace('gone')!.parent ?? null).toBeNull();
    expect(s.getWorkspace('self')!.parent ?? null).toBeNull();
    // The cycle is cut somewhere: walking up from every member must terminate at a root.
    for (const id of ['x', 'y', 'z', 'ok']) {
      const seen = new Set<string>();
      for (let p: string | null | undefined = id; p; p = s.getWorkspace(p)?.parent) { expect(seen.has(p)).toBe(false); seen.add(p); }
    }
    expect(s.getWorkspace('ok')!.parent).toBe('x');
    // Cutting loses one link, not all of them.
    expect(['x', 'y', 'z'].filter((id) => s.getWorkspace(id)!.parent).length).toBe(2);
  });

  it('drops an appearance with nothing valid in it, and an unsafe logo name', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [
      entry('a', { appearance: { logo: '../../etc/passwd' } }),
      entry('b', { appearance: { logo: 'x.gif', icon: 'star' } }),
      entry('c', { appearance: {} }), entry('d', { appearance: 'nope' }), entry('e', { appearance: { icon: 5, color: '' } }),
    ]);
    expect(s.getWorkspace('a')!.appearance).toBeUndefined();
    expect(s.getWorkspace('b')!.appearance).toEqual({ icon: 'star' });
    expect(s.getWorkspace('c')!.appearance).toBeUndefined();
    expect(s.getWorkspace('d')!.appearance).toBeUndefined();
    expect(s.getWorkspace('e')!.appearance).toBeUndefined();
  });

  it('a child carries its parent group: the parent wins on load', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('p', { group: 'A' }), entry('c', { parent: 'p', group: 'B' }), entry('g', { parent: 'c', group: null })]);
    expect(s.getWorkspace('c')!.group).toBe('A');
    expect(s.getWorkspace('g')!.group).toBe('A');
    expect(s.listGroups()).toEqual(['A']); // B is no longer referenced by anything
  });

  it('moving a parent moves its whole subtree in one registry write', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('p', { group: 'A' }), entry('c', { parent: 'p', group: 'A' }), entry('g', { parent: 'c', group: 'A' }), entry('other', { group: 'A' })], { groups: ['A', 'B'] });
    s.moveWorkspace('p', 'B', null);
    expect(['p', 'c', 'g'].map((id) => s.getWorkspace(id)!.group)).toEqual(['B', 'B', 'B']);
    expect(s.getWorkspace('other')!.group).toBe('A');
    expect(s.getWorkspace('c')!.parent).toBe('p');
  });

  it('moveWorkspace with a null parent un-nests, and nesting adopts the parent group', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('p', { group: 'A' }), entry('c', { parent: 'p', group: 'A' }), entry('x', { group: 'B' })], { groups: ['A', 'B'] });
    s.moveWorkspace('c', 'B', null);
    expect(s.getWorkspace('c')).toMatchObject({ group: 'B' });
    expect(s.getWorkspace('c')!.parent ?? null).toBeNull();
    s.moveWorkspace('x', 'A', 'p');
    expect(s.getWorkspace('x')).toMatchObject({ group: 'A', parent: 'p' });
  });

  it('removing a parent re-parents its children to the removed one parent', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('r'), entry('m', { parent: 'r' }), entry('k1', { parent: 'm' }), entry('k2', { parent: 'm' })]);
    expect(s.removeWorkspace('m')).toBe(true);
    expect(s.getWorkspace('k1')!.parent).toBe('r');
    expect(s.getWorkspace('k2')!.parent).toBe('r');
    s.removeWorkspace('r');
    expect(s.getWorkspace('k1')!.parent ?? null).toBeNull();
    expect(s.listWorkspaces().map((w) => w.id).sort()).toEqual(['k1', 'k2']);
  });

  it('sets, merges and clears a document appearance', () => {
    const d = tmpDir(); dirs.push(d);
    const s = seed(d, [entry('a')]);
    expect(s.setWorkspaceAppearance('a', { icon: 'star', color: 'red' })!.appearance).toEqual({ icon: 'star', color: 'red' });
    expect(s.setWorkspaceAppearance('a', { logo: 'ab.png' })!.appearance).toEqual({ icon: 'star', color: 'red', logo: 'ab.png' });
    expect(s.setWorkspaceAppearance('a', { logo: null, icon: null, color: null })!.appearance).toBeUndefined();
    expect(s.setWorkspaceAppearance('nope', { icon: 'x' })).toBeNull();
  });

  it('folder appearance accepts a logo and clears it', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('CPTC');
    expect(s.setFolderMeta('CPTC', { logo: 'ab.png' })).toEqual({ CPTC: { logo: 'ab.png' } });
    expect(createSettingsStore(d).folderMeta()).toEqual({ CPTC: { logo: 'ab.png' } });
    expect(s.setFolderMeta('CPTC', { logo: null })).toEqual({});
  });

  it('never deletes a logo file when a logo is cleared or its owner removed', () => {
    const d = tmpDir(); dirs.push(d);
    fs.mkdirSync(path.join(d, 'logos'));
    fs.writeFileSync(path.join(d, 'logos', 'ab.png'), 'x');
    const s = seed(d, [entry('a', { appearance: { logo: 'ab.png' } })]);
    s.setWorkspaceAppearance('a', { logo: null });
    s.removeWorkspace('a');
    expect(fs.existsSync(path.join(d, 'logos', 'ab.png'))).toBe(true);
  });
});

describe('scanLibrary fold keeps nesting', () => {
  it('re-points the stale entry children to the owner and passes on its appearance and parent', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const e = (id: string, p: string, extra: Record<string, unknown> = {}) => ({ id, path: p, name: 'report', group: null, library: true, createdAt: 1, openedAt: 1, ...extra });
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({
      version: 1, groups: [], workspaces: [
        { ...e('top', path.join(d, 'top'), { name: 'top' }) },
        e('live', path.join(lib, 'report')),
        e('stale', path.join(d, 'gone', 'report'), { parent: 'top', appearance: { icon: 'star' } }),
        { ...e('kid', path.join(d, 'kid'), { name: 'kid', parent: 'stale' }) },
      ],
    }));
    const s = createSettingsStore(d);
    s.scanLibrary(lib);
    expect(s.getWorkspace('stale')).toBeNull();
    expect(s.getWorkspace('kid')!.parent).toBe('live');
    expect(s.getWorkspace('live')).toMatchObject({ parent: 'top', appearance: { icon: 'star' } });
  });

  it('does not overwrite the owner own appearance or parent', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const e = (id: string, p: string, extra: Record<string, unknown> = {}) => ({ id, path: p, name: id === 'live' || id === 'stale' ? 'report' : id, group: null, library: true, createdAt: 1, openedAt: 1, ...extra });
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({
      version: 1, groups: [], workspaces: [
        e('a', path.join(d, 'a')), e('b', path.join(d, 'b')),
        e('live', path.join(lib, 'report'), { parent: 'a', appearance: { icon: 'book' } }),
        e('stale', path.join(d, 'gone', 'report'), { parent: 'b', appearance: { icon: 'star' } }),
      ],
    }));
    const s = createSettingsStore(d);
    s.scanLibrary(lib);
    expect(s.getWorkspace('live')).toMatchObject({ parent: 'a', appearance: { icon: 'book' } });
  });

  it('cannot create a cycle when the stale entry was the owner own child', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({
      version: 1, groups: [], workspaces: [
        { id: 'live', path: path.join(lib, 'report'), name: 'report', group: null, library: true, createdAt: 1, openedAt: 1, parent: 'stale' },
        { id: 'stale', path: path.join(d, 'gone', 'report'), name: 'report', group: null, library: true, createdAt: 1, openedAt: 1 },
      ],
    }));
    const s = createSettingsStore(d);
    s.scanLibrary(lib);
    expect(s.getWorkspace('live')!.parent ?? null).toBeNull();
  });
});

describe('settings store .bak guard', () => {
  const bak = (d: string) => path.join(d, 'settings.json.bak');
  const empty = { version: 1, workspaces: [], groups: [], folderMeta: {}, backup: { destinations: [], snapshotIntervalMin: 60, keepSnapshots: 30 }, typstCli: null, redaction: { style: 'gaussian', strength: 1 } };

  it('an empty registry does not replace a good .bak', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.update((x) => ({ ...x, groups: ['Keep'] }));
    s.update((x) => ({ ...x, groups: ['Keep', 'More'] })); // .bak = {Keep}
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(empty));
    fs.utimesSync(path.join(d, 'settings.json'), new Date(30_000_000), new Date(30_000_000));
    const fresh = createSettingsStore(d);
    fresh.update((x) => ({ ...x, typstCli: 'typst' })); // current file is empty: .bak must stay
    expect(JSON.parse(fs.readFileSync(bak(d), 'utf8')).groups).toEqual(['Keep']);
  });

  it('an empty registry is still backed up when no .bak exists yet', () => {
    const d = tmpDir(); dirs.push(d);
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(empty));
    const s = createSettingsStore(d);
    s.update((x) => ({ ...x, typstCli: 'typst' }));
    expect(fs.existsSync(bak(d))).toBe(true);
  });

  it('a registry with only a workspace, only a folder or only a destination does refresh the .bak', () => {
    for (const filled of [
      { workspaces: [{ id: 'a', path: '/p/a', name: 'a', group: null, library: true, createdAt: 1, openedAt: 1 }] },
      { groups: ['G'] },
      { backup: { destinations: [{ id: 'd', path: '/d', mirror: true, snapshots: true }], snapshotIntervalMin: 60, keepSnapshots: 30 } },
    ]) {
      const d = tmpDir(); dirs.push(d);
      fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ...empty, ...filled }));
      fs.writeFileSync(bak(d), JSON.stringify({ ...empty, groups: ['older'] }));
      const s = createSettingsStore(d);
      s.update((x) => ({ ...x, typstCli: 'typst' }));
      const kept = JSON.parse(fs.readFileSync(bak(d), 'utf8'));
      expect(kept.groups).not.toEqual(['older']);
    }
  });
});
