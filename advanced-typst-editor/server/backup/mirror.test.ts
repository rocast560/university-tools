import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceEntry } from '../../src/types';
import { openWorkspace } from '../workspace';
import { tmpDir, rmDir, put } from '../test-util';
import { MARKER_FILE, REGISTRY_DIR, claimable, planMirror, runMirror, type MirrorItem } from './mirror';

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

  it('plans an unchanged tree for a one-segment group', () => {
    const plan = planMirror([item('Report', 'CPTC', { 'main.typ': 'a' })]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(['CPTC/Report/main.typ', 'README.txt']);
    expect(plan.dirs).toContain('CPTC');
  });

  it('nests a folder path into nested directories', () => {
    const plan = planMirror([item('Lab1', 'School/ECE-2300L', { 'main.typ': 'a' })]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(['README.txt', 'School/ECE-2300L/Lab1/main.typ']);
    expect(plan.dirs).toContain('School');
    expect(plan.dirs).toContain('School/ECE-2300L');
    expect(plan.dirOf.get('Lab1')).toBe('School/ECE-2300L/Lab1');
  });

  it('scopes name collisions per level, not globally', () => {
    const plan = planMirror([
      item('A', 'School/Labs', { 'main.typ': 'a' }, 'a'),
      item('B', 'CPTC/Labs', { 'main.typ': 'b' }, 'b'),
    ]);
    expect(plan.dirOf.get('a')).toBe('School/Labs/A');
    expect(plan.dirOf.get('b')).toBe('CPTC/Labs/B');
  });

  it('sanitises each segment separately so a separator cannot escape', () => {
    const plan = planMirror([item('R', 'A:B/C*D', { 'main.typ': 'a' })]);
    expect(plan.dirOf.get('R')).toBe('A_B/C_D/R');
    expect(plan.dirs).toContain('A_B');
    expect(plan.dirs).toContain('A_B/C_D');
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

describe('registry in the mirror', () => {
  function data(settings: string, logos: Record<string, string>): string {
    const d = tmpDir(); dirs.push(d);
    put(d, 'settings.json', settings);
    for (const [n, t] of Object.entries(logos)) put(d, `logos/${n}`, t);
    return d;
  }

  it('copies logos and settings.json under the reserved .typst-studio folder', () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = data('{"v":1}', { 'aaaa1111.png': 'png', 'bbbb2222.svg': 'svg' });
    runMirror(dest, planMirror([item('A', null, { 'main.typ': 'x' })], { dataDir }), { now: () => 1 });
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'settings.json'), 'utf8')).toBe('{"v":1}');
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'logos', 'aaaa1111.png'), 'utf8')).toBe('png');
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'logos', 'bbbb2222.svg'), 'utf8')).toBe('svg');
    expect(fs.existsSync(path.join(dest, 'A', 'main.typ'))).toBe(true);
  });

  it('does not duplicate on a second run and trashes the old settings.json when it changes', () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = data('{"v":1}', { 'aaaa1111.png': 'png' });
    const a = item('A', null, { 'main.typ': 'x' });
    const plan = () => planMirror([a], { dataDir });
    runMirror(dest, plan(), { now: () => 1000 });
    const again = runMirror(dest, plan(), { now: () => 2000 });
    expect(again).toEqual({ written: 0, trashed: 0 });
    expect(fs.readdirSync(path.join(dest, REGISTRY_DIR)).sort()).toEqual(['logos', 'settings.json']);
    expect(fs.existsSync(path.join(dest, '_trash'))).toBe(false);

    put(dataDir, 'settings.json', '{"v":2}');
    runMirror(dest, plan(), { now: () => 3000 });
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'settings.json'), 'utf8')).toBe('{"v":2}');
    const [stampDir] = fs.readdirSync(path.join(dest, '_trash'));
    expect(fs.readFileSync(path.join(dest, '_trash', stampDir!, REGISTRY_DIR, 'settings.json'), 'utf8')).toBe('{"v":1}');
  });

  it('keeps a sidebar folder or loose document named .typst-studio away from the reserved folder', () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = data('{}', { 'aaaa1111.png': 'png' });
    const plan = planMirror([item('Doc', '.typst-studio', { 'main.typ': 'g' }, 'g'), item('.Typst-Studio', null, { 'main.typ': 'l' }, 'l')], { dataDir });
    runMirror(dest, plan, { now: () => 1 });
    expect(plan.dirOf.get('g')).toBe('.typst-studio (2)/Doc');
    expect(plan.dirOf.get('l')).toBe('.Typst-Studio (3)');
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'logos', 'aaaa1111.png'), 'utf8')).toBe('png');
    expect(fs.readFileSync(path.join(dest, '.typst-studio (2)', 'Doc', 'main.typ'), 'utf8')).toBe('g');
  });

  it('skips files in data/logos that are not valid logo names', () => {
    const dataDir = data('{}', { 'aaaa1111.png': 'png', 'notes.txt': 'x' });
    const paths = planMirror([], { dataDir }).files.map((f) => f.path).sort();
    expect(paths).toEqual([`${REGISTRY_DIR}/logos/aaaa1111.png`, `${REGISTRY_DIR}/settings.json`, 'README.txt'].sort());
  });
});

describe('registry trash handling', () => {
  function data(settings: string): string {
    const d = tmpDir(); dirs.push(d);
    put(d, 'settings.json', settings);
    return d;
  }

  it('keeps the mirror copy when the old one cannot be moved to the trash', () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = data('{"v":1}');
    runMirror(dest, planMirror([], { dataDir }), { now: () => 1000 });
    put(dest, '_trash', 'a file where the trash folder should be');
    put(dataDir, 'settings.json', '{"v":2}');
    const logged: unknown[][] = [];
    runMirror(dest, planMirror([], { dataDir }), { now: () => 2000, log: (...a) => logged.push(a) });
    expect(fs.readFileSync(path.join(dest, REGISTRY_DIR, 'settings.json'), 'utf8')).toBe('{"v":1}');
    expect(logged.length).toBeGreaterThan(0);
  });

  it('never overwrites an earlier trash copy made in the same second', () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = data('{"v":1}');
    const run = () => runMirror(dest, planMirror([], { dataDir }), { now: () => 5000 });
    run();
    put(dataDir, 'settings.json', '{"v":2}'); run();
    put(dataDir, 'settings.json', '{"v":3}'); run();
    const [stampDir] = fs.readdirSync(path.join(dest, '_trash'));
    const dir = path.join(dest, '_trash', stampDir!, REGISTRY_DIR);
    const copies = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort();
    expect(copies).toEqual(['{"v":1}', '{"v":2}']);
  });
});
