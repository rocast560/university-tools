import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceEntry } from '../../src/types';
import { openWorkspace } from '../workspace';
import { tmpDir, rmDir, put } from '../test-util';
import { MARKER_FILE, claimable, planMirror, runMirror, type MirrorItem } from './mirror';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function entry(name: string, group: string | null, root: string, id = name): WorkspaceEntry {
  return { id, name, group, path: root, library: true, createdAt: 1, openedAt: 1 };
}
function item(name: string, group: string | null, files: Record<string, string>, id = name): MirrorItem {
  const root = tmpDir(); dirs.push(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  return { entry: entry(name, group, root, id), files: openWorkspace(root).listFiles() };
}

describe('planMirror', () => {
  it('lays out groups, loose workspaces, and unique names', () => {
    const plan = planMirror([
      item('Report', 'CPTC', { 'main.typ': 'a', 'assets/x.png': 'b', 'workspace.json': '{}' }),
      item('Report', 'CPTC', { 'main.typ': 'c' }, 'second'),
      item('Loose: one?', null, { 'main.typ': 'd' }),
      item('_trash', null, { 'main.typ': 'e' }, 'reserved'),
    ]);
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual(['CPTC/Report (2)/main.typ', 'CPTC/Report/assets/x.png', 'CPTC/Report/main.typ', 'CPTC/Report/workspace.json', 'Loose_ one_/main.typ', 'README.txt', '_trash (2)/main.typ']);
    expect(plan.dirOf.get('second')).toBe('CPTC/Report (2)');
    expect(plan.dirs).toContain('CPTC');
  });
});

describe('runMirror', () => {
  it('refuses a folder with foreign files, accepts empty or marked ones', () => {
    const dest = tmpDir(); dirs.push(dest);
    expect(claimable(dest)).toBe(true);
    put(dest, 'notes.txt', 'mine');
    expect(claimable(dest)).toBe(false);
    fs.unlinkSync(path.join(dest, 'notes.txt'));
    put(dest, MARKER_FILE, '{}');
    put(dest, 'anything.txt', 'x');
    expect(claimable(dest)).toBe(true);
  });

  it('writes, skips identical bytes, trashes stale files, keeps snapshots/', () => {
    const dest = tmpDir(); dirs.push(dest);
    const a = item('A', null, { 'main.typ': 'one', 'assets/p.png': 'img' });
    let plan = planMirror([a]);
    const first = runMirror(dest, plan, { now: () => 1000 });
    expect(first.written).toBe(3); // main.typ, assets/p.png, README.txt
    expect(fs.existsSync(path.join(dest, MARKER_FILE))).toBe(true);
    expect(runMirror(dest, plan, { now: () => 2000 }).written).toBe(0);

    put(dest, 'snapshots/keep.zip', 'zip');
    put(dest, 'A/stale.txt', 'old');
    fs.writeFileSync(path.join(a.entry.path, 'main.typ'), 'two');
    a.files = openWorkspace(a.entry.path).listFiles();
    plan = planMirror([a]);
    const second = runMirror(dest, plan, { now: () => 3000 });
    expect(second.written).toBe(1);
    expect(second.trashed).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'A', 'main.typ'), 'utf8')).toBe('two');
    expect(fs.existsSync(path.join(dest, 'snapshots', 'keep.zip'))).toBe(true);
    const trash = fs.readdirSync(path.join(dest, '_trash'));
    expect(fs.existsSync(path.join(dest, '_trash', trash[0]!, 'A', 'stale.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'A', 'stale.txt'))).toBe(false);
  });

  it('throws on an unclaimable destination', () => {
    const dest = tmpDir(); dirs.push(dest);
    put(dest, 'photo.jpg', 'x');
    expect(() => runMirror(dest, planMirror([]), {})).toThrow(/already has files/);
  });
});
