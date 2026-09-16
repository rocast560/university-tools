import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openWorkspace } from './workspace';
import { createWorkspaceIndex } from './workspace-index';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fixture(): string {
  const d = tmpDir(); dirs.push(d);
  put(d, 'main.typ', '= Hi\n#image("/assets/findings/login.png")\n');
  put(d, 'chapters/intro.typ', 'intro');
  put(d, 'refs.bib', '');
  put(d, 'assets/findings/login.png', PNG_1x1);
  put(d, 'assets/cover.png', PNG_1x1);
  put(d, 'fonts/Poppins-Regular.ttf', Buffer.alloc(4));
  put(d, '.git/HEAD', 'ref');
  put(d, 'node_modules/x/index.js', '');
  put(d, 'stray.tmp', 'x');
  put(d, 'workspace.json', JSON.stringify({ version: 1, assets: { 'assets/cover.png': { crop: { x: 0, y: 0, w: 1, h: 0.5 } } }, fonts: { 'fonts/Poppins-Regular.ttf': { family: 'Poppins' } } }));
  return d;
}

/** Give a file an mtime the previous stat cannot have seen. */
function bump(abs: string, ms: number) { fs.utimesSync(abs, new Date(ms), new Date(ms)); }

describe('workspace index', () => {
  it('builds the same listing as the synchronous walk', async () => {
    const d = fixture();
    const ws = openWorkspace(d);
    const index = createWorkspaceIndex();
    const snap = await index.get(d);
    expect(snap.files).toEqual([...ws.listFiles()].sort((a, b) => a.path.localeCompare(b.path)));
    expect(snap.files.map((f) => f.path)).toEqual(['assets/cover.png', 'assets/findings/login.png', 'chapters/intro.typ', 'fonts/Poppins-Regular.ttf', 'main.typ', 'refs.bib']);
    expect(snap.assets).toEqual([...ws.listAssets()].sort((a, b) => a.id.localeCompare(b.id)));
    expect(snap.assets.find((a) => a.id === 'assets/cover.png')?.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(snap.folders).toEqual([...ws.listFolders()].sort((a, b) => a.id.localeCompare(b.id)));
    expect(snap.meta).toEqual(ws.readMeta());
    expect(snap.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(index.builds).toBe(1);
  });

  it('serves the cached snapshot and shares one build between concurrent readers', async () => {
    const d = fixture();
    const index = createWorkspaceIndex();
    const [a, b] = await Promise.all([index.get(d), index.get(d)]);
    expect(a).toBe(b);
    expect(await index.get(d)).toBe(a);
    expect(index.builds).toBe(1);
  });

  it('patches a touched plain file without rebuilding, and the etag follows', async () => {
    const d = fixture();
    const index = createWorkspaceIndex();
    const before = await index.get(d);
    const main = path.join(d, 'main.typ');
    fs.writeFileSync(main, '= Changed, longer than before\n');
    bump(main, 2_000_000_000_000);
    index.touch(d, 'main.typ');
    const after = await index.get(d);
    expect(index.builds).toBe(1);
    expect(after.files.find((f) => f.path === 'main.typ')).toEqual({ path: 'main.typ', size: fs.statSync(main).size, mtime: 2_000_000_000_000 });
    expect(after.etag).not.toBe(before.etag);
    expect(after.assets).toBe(before.assets);

    // A vanished file leaves; a new one arrives.
    fs.unlinkSync(path.join(d, 'refs.bib'));
    put(d, 'notes.txt', 'n');
    index.touch(d, 'refs.bib');
    index.touch(d, 'notes.txt');
    const next = await index.get(d);
    expect(index.builds).toBe(1);
    expect(next.files.map((f) => f.path)).toEqual(['assets/cover.png', 'assets/findings/login.png', 'chapters/intro.typ', 'fonts/Poppins-Regular.ttf', 'main.typ', 'notes.txt']);
  });

  it('rebuilds for assets, fonts, workspace.json and directories', async () => {
    const d = fixture();
    const index = createWorkspaceIndex();
    await index.get(d);
    index.touch(d, 'assets/cover.png');
    await index.get(d);
    expect(index.builds).toBe(2);
    index.touch(d, 'fonts/Poppins-Regular.ttf');
    await index.get(d);
    expect(index.builds).toBe(3);
    put(d, 'workspace.json', JSON.stringify({ version: 1, assets: {}, fonts: {} }));
    index.touch(d, 'workspace.json');
    const snap = await index.get(d);
    expect(index.builds).toBe(4);
    expect(snap.assets.find((a) => a.id === 'assets/cover.png')?.crop).toBeNull();
    // A directory path arriving as a plain touch (the watcher does not know) rebuilds too.
    put(d, 'chapters/two.typ', '2');
    index.touch(d, 'chapters');
    const withTwo = await index.get(d);
    expect(index.builds).toBe(5);
    expect(withTwo.files.some((f) => f.path === 'chapters/two.typ')).toBe(true);
    index.invalidate(d);
    await index.get(d);
    expect(index.builds).toBe(6);
  });

  it('rebuilds a snapshot older than maxAgeMs', async () => {
    const d = fixture();
    let t = 0;
    const index = createWorkspaceIndex({ maxAgeMs: 100, now: () => t });
    await index.get(d);
    t = 50;
    await index.get(d);
    expect(index.builds).toBe(1);
    t = 200;
    await index.get(d);
    expect(index.builds).toBe(2);
  });

  it('keeps the etag stable across identical rebuilds', async () => {
    const d = fixture();
    const index = createWorkspaceIndex();
    const a = await index.get(d);
    index.invalidate(d);
    const b = await index.get(d);
    expect(b.etag).toBe(a.etag);
    expect(b).not.toBe(a);
  });
});
