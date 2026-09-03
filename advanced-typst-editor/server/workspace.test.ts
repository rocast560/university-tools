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
    expect(() => ws.writeFile('Workspace.JSON', Buffer.alloc(1))).toThrow();
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

describe('workspace assets', () => {
  it('uploads with sanitised, extension-corrected, de-duplicated names', () => {
    const ws = openWorkspace(fixture());
    const a = ws.addAsset({ kind: 'image', filename: '../we ird?.jpg', bytes: PNG_1x1, folder: null });
    expect(a.id).toBe('assets/we_ird_.png'); // PNG bytes => .png, spaces/? => _
    const b = ws.addAsset({ kind: 'image', filename: 'we_ird_.png', bytes: PNG_1x1, folder: null });
    expect(b.id).toBe('assets/we_ird_-2.png');
    const c = ws.addAsset({ kind: 'image', filename: 'shot.png', bytes: PNG_1x1, folder: 'new/deep' });
    expect(c.id).toBe('assets/new/deep/shot.png');
    expect(c.folderId).toBe('new/deep');
    const f = ws.addAsset({ kind: 'font', filename: 'X.ttf', bytes: Buffer.alloc(8), folder: null, family: 'X Sans' });
    expect(f.id).toBe('fonts/X.ttf');
    expect(ws.readMeta().fonts['fonts/X.ttf']).toEqual({ family: 'X Sans' });
    expect(() => ws.addAsset({ kind: 'image', filename: 'x.exe', bytes: PNG_1x1, folder: null })).toThrow(/not allowed/);
    expect(() => ws.addAsset({ kind: 'image', filename: 'x.png', bytes: PNG_1x1, folder: '../out' })).toThrow();
  });

  it('patches framing and validates it', () => {
    const ws = openWorkspace(fixture());
    const a = ws.patchAsset('assets/findings/login.png', { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, blurs: [{ x: 0, y: 0, w: 0.2, h: 0.2, style: 'pixelate' }], width: 1920, height: 1080 });
    expect(a.crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(a.blurs?.[0]?.style).toBe('pixelate');
    expect(ws.readMeta().assets['assets/findings/login.png']).toMatchObject({ width: 1920, height: 1080 });
    expect(() => ws.patchAsset('assets/findings/login.png', { crop: { x: 0, y: 0, w: 0, h: 1 } })).toThrow(/crop/);
    expect(() => ws.patchAsset('assets/findings/login.png', { blurs: [{ x: 0.9, y: 0, w: 0.5, h: 0.5 }] })).toThrow(/blur/);
    expect(ws.patchAsset('assets/findings/login.png', { crop: null }).crop).toBeNull();
    expect(() => ws.patchAsset('assets/nope.png', { crop: null })).toThrow(/not found/);
  });

  it('renames an asset, keeps the extension, and rewrites every .typ reference', () => {
    const d = fixture();
    put(d, 'chapters/intro.typ', '#image("/assets/findings/login.png", width: 50%)\n#image-placeholder("x", path: "/assets/findings/login.png")');
    const ws = openWorkspace(d);
    const { asset, references, files } = ws.renameAsset('assets/findings/login.png', 'Login Bypass.jpg');
    expect(asset.id).toBe('assets/findings/Login_Bypass.png');
    expect(references).toBe(3);
    expect(files.sort()).toEqual(['chapters/intro.typ', 'main.typ']);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/findings/Login_Bypass.png"');
    expect(fs.readFileSync(path.join(d, 'chapters/intro.typ'), 'utf8')).not.toContain('login.png');
    expect(fs.existsSync(path.join(d, 'assets/findings/login.png'))).toBe(false);
  });

  it('moves an asset between folders and keeps its framing', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    ws.patchAsset('assets/cover.png', { crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    const { asset, references } = ws.moveAsset('assets/cover.png', 'findings');
    expect(asset.id).toBe('assets/findings/cover.png');
    expect(asset.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(references).toBe(0);
    expect(ws.readMeta().assets['assets/cover.png']).toBeUndefined();
    expect(ws.moveAsset('assets/findings/cover.png', null).asset.id).toBe('assets/cover.png');
  });

  it('creates, renames and deletes folders; deleting moves contents up a level', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    expect(ws.createFolder('findings/auth')).toMatchObject({ id: 'findings/auth', name: 'auth', parentId: 'findings' });
    ws.addAsset({ kind: 'image', filename: 'token.png', bytes: PNG_1x1, folder: 'findings/auth' });
    put(d, 'main.typ', '#image("/assets/findings/auth/token.png")\n#image("/assets/findings/login.png")');
    expect(ws.renameFolder('findings', 'Findings 2026').references).toBe(2);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/Findings 2026/auth/token.png"');
    const r = ws.deleteFolder('Findings 2026/auth');
    expect(r.moved).toBe(1);
    expect(fs.existsSync(path.join(d, 'assets/Findings 2026/token.png'))).toBe(true);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/Findings 2026/token.png"');
    expect(ws.listFolders().map((f) => f.id)).toEqual(['Findings 2026']);
    expect(() => ws.createFolder('../x')).toThrow();
  });

  it('deletes an asset and its meta', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    ws.deleteAsset('assets/cover.png');
    expect(fs.existsSync(path.join(d, 'assets/cover.png'))).toBe(false);
    expect(ws.readMeta().assets['assets/cover.png']).toBeUndefined();
    expect(() => ws.deleteAsset('assets/cover.png')).toThrow(/not found/);
  });
});
