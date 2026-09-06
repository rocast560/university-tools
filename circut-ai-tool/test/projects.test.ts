import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptySidecar } from '../src/layout/types.ts';
import { ProjectRegistry, mapHostPath, normalizePath, parsePathMap, projectId, readSidecar, scanProjects, sidecarPath, writeSidecar } from '../server/projects.ts';
import { Events, watchFile } from '../server/watch.ts';

describe('projectId', () => {
  test('is stable and case-insensitive', () => {
    expect(projectId('C:\\Users\\x\\a.kicad_sch')).toBe(projectId('c:/users/x/A.kicad_sch'));
    expect(projectId('C:/a.kicad_sch')).toHaveLength(10);
  });
});

describe('ProjectRegistry', () => {
  test('remembers, lists newest first, forgets, persists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
    const reg = new ProjectRegistry(dir);
    await reg.load();
    const base = path.join(dir, 'p');
    const a = await reg.remember(path.join(base, 'a.kicad_sch'));
    await new Promise((r) => setTimeout(r, 5));
    const b = await reg.remember(path.join(base, 'b.kicad_sch'));
    expect(reg.list().map((p) => p.name)).toEqual(['b', 'a']);
    expect(reg.get(a.id)!.dir).toBe(normalizePath(base));
    await reg.remember(path.join(base, 'a.kicad_sch'));
    expect(reg.list().map((p) => p.name)).toEqual(['a', 'b']);
    await reg.forget(b.id);
    const reg2 = new ProjectRegistry(dir);
    await reg2.load();
    expect(reg2.list().map((p) => p.id)).toEqual([a.id]);
  });
});

describe('scanProjects and sidecar', () => {
  test('finds schematics two levels deep and round-trips the sidecar', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
    mkdirSync(path.join(root, 'p1'));
    mkdirSync(path.join(root, 'p2', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'p1', 'p1.kicad_sch'), '(kicad_sch)');
    writeFileSync(path.join(root, 'p2', 'sub', 'deep.kicad_sch'), '(kicad_sch)');
    writeFileSync(path.join(root, 'p2', 'sub', 'deep-backups.kicad_sch.bak'), 'x');
    const found = await scanProjects(root, 2);
    expect(found.map((f) => f.name).sort()).toEqual(['deep', 'p1']);
    const sch = path.join(root, 'p1', 'p1.kicad_sch');
    expect(sidecarPath(sch)).toBe(path.join(root, 'p1', 'p1.breadboard.json'));
    expect(await readSidecar(sch)).toEqual(emptySidecar());
    const s = emptySidecar();
    s.pinned.R1 = { '1': { col: 3, row: 'a' }, '2': { col: 3, row: 'T+' } };
    await writeSidecar(sch, s);
    expect(existsSync(sidecarPath(sch))).toBe(true);
    expect((await readSidecar(sch)).pinned.R1['1']).toEqual({ col: 3, row: 'a' });
  });
});

describe('path mapping', () => {
  const map = parsePathMap('C:\\Users\\me\\Documents\\KiCad\\9.0\\projects=/projects; D:/labs/=/labs ;bad;=/x;C:/Users/me/Documents=/docs');

  test('parses, normalises and sorts longest host prefix first', () => {
    expect(map).toEqual([
      { host: 'C:/Users/me/Documents/KiCad/9.0/projects', container: '/projects' },
      { host: 'C:/Users/me/Documents', container: '/docs' },
      { host: 'D:/labs', container: '/labs' },
    ]);
  });

  test('rewrites matching prefixes case-insensitively, with either slash', () => {
    expect(mapHostPath('c:\\users\\ME\\documents\\kicad\\9.0\\projects\\PL1_1\\PL1_1.kicad_sch', map)).toBe('/projects/PL1_1/PL1_1.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents/other/x.kicad_sch', map)).toBe('/docs/other/x.kicad_sch');
    expect(mapHostPath('D:/labs/a.kicad_sch', map)).toBe('/labs/a.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents/KiCad/9.0/projects', map)).toBe('/projects');
  });

  test('leaves ids, container paths and unmapped paths alone', () => {
    expect(mapHostPath('365480e020', map)).toBe('365480e020');
    expect(mapHostPath('/projects/PL1_1/PL1_1.kicad_sch', map)).toBe('/projects/PL1_1/PL1_1.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents2/x.kicad_sch', map)).toBe('C:/Users/me/Documents2/x.kicad_sch');
    expect(mapHostPath('E:/x.kicad_sch', [])).toBe('E:/x.kicad_sch');
  });
});

describe('Events and watchFile', () => {
  test('emits once per debounced burst of changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watch-'));
    const file = path.join(dir, 'x.kicad_sch');
    writeFileSync(file, '(kicad_sch)');
    let hits = 0;
    const stop = watchFile(file, () => hits++, 150);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, '(kicad_sch 1)');
    writeFileSync(file, '(kicad_sch 2)');
    writeFileSync(path.join(dir, 'other.txt'), 'ignored');
    await new Promise((r) => setTimeout(r, 600));
    stop();
    expect(hits).toBe(1);
    const ev = new Events<{ n: number }>();
    const got: number[] = [];
    const unsub = ev.subscribe((e) => got.push(e.n));
    ev.emit({ n: 1 });
    unsub();
    ev.emit({ n: 2 });
    expect(got).toEqual([1]);
  });

  test('polling mode notices a change without inotify and stops cleanly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poll-'));
    const file = path.join(dir, 'x.kicad_sch');
    writeFileSync(file, '(kicad_sch)');
    let hits = 0;
    const stop = watchFile(file, () => hits++, { debounceMs: 50, pollMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(file, '(kicad_sch changed)');
    await new Promise((r) => setTimeout(r, 600));
    expect(hits).toBe(1);
    stop();
    writeFileSync(file, '(kicad_sch changed again)');
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toBe(1);
  });
});
