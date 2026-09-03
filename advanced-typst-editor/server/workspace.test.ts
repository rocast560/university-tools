import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openWorkspace } from './workspace';
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
  put(d, 'workspace.json', JSON.stringify({ version: 1, assets: { 'assets/cover.png': { crop: { x: 0, y: 0, w: 1, h: 0.5 } } }, fonts: { 'fonts/Poppins-Regular.ttf': { family: 'Poppins' } } }));
  return d;
}

describe('workspace files', () => {
  it('lists every file except hidden, node_modules and workspace.json', () => {
    const ws = openWorkspace(fixture());
    const paths = ws.listFiles().map((f) => f.path).sort();
    expect(paths).toEqual(['assets/cover.png', 'assets/findings/login.png', 'chapters/intro.typ', 'fonts/Poppins-Regular.ttf', 'main.typ', 'refs.bib']);
    expect(ws.typFiles()).toEqual(['chapters/intro.typ', 'main.typ']);
  });

  it('reads with an etag and writes atomically', () => {
    const ws = openWorkspace(fixture());
    const r = ws.readFile('main.typ')!;
    expect(Buffer.from(r.bytes).toString()).toContain('= Hi');
    expect(r.etag).toMatch(/^\d+-\d+$/);
    const e = ws.writeFile('main.typ', Buffer.from('= Changed'));
    expect(e.path).toBe('main.typ');
    expect(Buffer.from(ws.readFile('main.typ')!.bytes).toString()).toBe('= Changed');
    expect(ws.readFile('nope.typ')).toBeNull();
    expect(ws.readFile('../x')).toBeNull();
    expect(() => ws.writeFile('../x', Buffer.alloc(1))).toThrow();
    expect(() => ws.writeFile('workspace.json', Buffer.alloc(1))).toThrow();
    expect(ws.deleteFile('refs.bib')).toBe(true);
    expect(ws.deleteFile('refs.bib')).toBe(false);
  });

  it('reads and writes workspace.json, tolerating a missing file', () => {
    const d = tmpDir(); dirs.push(d);
    const ws = openWorkspace(d);
    expect(ws.readMeta()).toEqual({ version: 1, assets: {}, fonts: {} });
    ws.writeMeta({ version: 1, assets: { 'assets/a.png': { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] } }, fonts: {} });
    expect(JSON.parse(fs.readFileSync(path.join(d, 'workspace.json'), 'utf8')).assets['assets/a.png'].blurs).toHaveLength(1);
  });

  it('lists assets with folders and framing from workspace.json', () => {
    const ws = openWorkspace(fixture());
    const assets = ws.listAssets();
    const ids = assets.map((a) => a.id).sort();
    expect(ids).toEqual(['assets/cover.png', 'assets/findings/login.png', 'fonts/Poppins-Regular.ttf']);
    const login = assets.find((a) => a.id === 'assets/findings/login.png')!;
    expect(login).toMatchObject({ kind: 'image', filename: 'login.png', mime: 'image/png', folderId: 'findings', size: PNG_1x1.length });
    const cover = assets.find((a) => a.id === 'assets/cover.png')!;
    expect(cover.folderId).toBeNull();
    expect(cover.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    const font = assets.find((a) => a.kind === 'font')!;
    expect(font).toMatchObject({ fontFamily: 'Poppins', filename: 'Poppins-Regular.ttf', folderId: null });
    expect(ws.listFolders()).toEqual([{ id: 'findings', name: 'findings', parentId: null, createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
  });
});
