import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler, parseDiagnostics, resolveTypstCli } from './compile';
import { tmpDir, rmDir, put, TYPST_CLI } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });
const have = fs.existsSync(TYPST_CLI);

describe('parseDiagnostics', () => {
  it('parses the short format and relativises the path', () => {
    const root = 'C:\\ws';
    const out = parseDiagnostics('\\\\?\\C:\\ws\\main.typ:3:7: error: file not found (searched at x)\nwarning: unused\n', root);
    expect(out).toEqual([
      { severity: 'error', message: 'file not found (searched at x)', file: 'main.typ', line: 3, col: 7 },
      { severity: 'warning', message: 'unused', file: null, line: null, col: null },
    ]);
  });
});

describe('resolveTypstCli', () => {
  it('prefers the configured path, then settings, then PATH', () => {
    expect(resolveTypstCli('C:\\nope\\typst.exe', null)).not.toBe('C:\\nope\\typst.exe');
    if (have) expect(resolveTypstCli(TYPST_CLI, null)).toBe(TYPST_CLI);
  });
});

describe.skipIf(!have)('createCompiler', () => {
  function setup() {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const settings = createSettingsStore(dataDir);
    const service = createWorkspaceService({ settings, bus: createEventBus(), watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '' });
    const compile = createCompiler({ settings, service, typstCli: TYPST_CLI });
    return { service, compile, dataDir };
  }
  it('reports diagnostics and compiles a good document', async () => {
    const { service, compile } = setup();
    const w = service.create({ name: 'A', group: null, source: '#set page(width: 8cm)\n= Hi\n#image("/assets/missing.png")\n' });
    const bad = await compile.compile(w.id, undefined);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', file: 'main.typ', line: 3 });
    fs.writeFileSync(path.join(w.path, 'main.typ'), '= Hi\nHello');
    expect((await compile.compile(w.id, undefined)).ok).toBe(true);
  });
  it('exports a PDF with redactions baked, to bytes or to a path', async () => {
    const { service, compile, dataDir } = setup();
    const w = service.create({ name: 'B', group: null, source: '#image("/assets/shot.png", width: 5cm)' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    put(w.path, 'assets/shot.png', png);
    service.patchAsset(w.id, 'assets/shot.png', { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] }, null);
    const originalBytes = fs.readFileSync(path.join(w.path, 'assets', 'shot.png'));
    const out = await compile.exportPdf(w.id, undefined, undefined);
    expect(out.baked).toBe(1);
    expect(Buffer.from(out.bytes!.subarray(0, 4)).toString()).toBe('%PDF');
    expect(Buffer.from(fs.readFileSync(path.join(w.path, 'assets', 'shot.png'))).equals(originalBytes)).toBe(true); // original untouched
    const to = path.join(dataDir, 'out.pdf');
    const saved = await compile.exportPdf(w.id, undefined, to);
    expect(saved.path).toBe(to);
    expect(fs.statSync(to).size).toBeGreaterThan(100);
  });
  it('renders a page preview as PNG, defaulting to page 1', async () => {
    const { service, compile } = setup();
    const w = service.create({ name: 'D', group: null, source: '#set page(width: 8cm, height: 6cm)\n= Page one\n#pagebreak()\n= Page two' });
    const res = await compile.renderPreview(w.id, undefined, undefined, undefined);
    expect(res.ok).toBe(true);
    expect(res.page).toBe(1);
    expect(Buffer.from(res.png!.subarray(0, 8))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const res2 = await compile.renderPreview(w.id, undefined, 2, undefined);
    expect(res2.ok).toBe(true);
    expect(res2.page).toBe(2);
    expect(Buffer.from(res2.png!).equals(Buffer.from(res.png!))).toBe(false);
  });

  it('reports diagnostics instead of a PNG when the document has errors', async () => {
    const { service, compile } = setup();
    const w = service.create({ name: 'E', group: null, source: '= Bad\n#image("/assets/missing.png")\n' });
    const res = await compile.renderPreview(w.id, undefined, undefined, undefined);
    expect(res.ok).toBe(false);
    expect(res.png).toBeNull();
    expect(res.diagnostics[0]).toMatchObject({ severity: 'error' });
  });

  it('rejects an export when a framed asset cannot be baked', async () => {
    const { service, compile } = setup();
    const w = service.create({ name: 'C', group: null, source: '#image("/assets/x.svg", width: 5cm)' });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    put(w.path, 'assets/x.svg', svg);
    service.patchAsset(w.id, 'assets/x.svg', { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, null);
    await expect(compile.exportPdf(w.id, undefined, undefined)).rejects.toThrow(/cannot be baked/);
  });
});
