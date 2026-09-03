import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importLegacy } from './legacy-import';
import { createSettingsStore } from './settings';
import { openWorkspace } from './workspace';
import { tmpDir, rmDir, put, OLD } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('importLegacy', () => {
  it('imports the real recovered data set', () => {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const r = importLegacy({ legacyDir: path.join(OLD, 'data'), dataDir, log: () => {} });
    expect(r.imported.map((w) => [w.name, w.group]).sort()).toEqual([
      ['ccdc-inject-template', 'CPTC'], ['cptc-inject-1', 'CPTC'], ['cptc-inject-2', 'CPTC'], ['cptc-report', 'CPTC'],
      ['ece-2300L-lab1', 'ECE-2300L'], ['ece-2300L-template', 'ECE-2300L'],
    ]);
    const settings = createSettingsStore(dataDir);
    expect(settings.listWorkspaces()).toHaveLength(6);
    const report = r.imported.find((w) => w.name === 'cptc-report')!;
    const ws = openWorkspace(report.path);
    expect(fs.readFileSync(path.join(report.path, 'main.typ'), 'utf8').length).toBeGreaterThan(20000);
    const fonts = ws.listAssets().filter((a) => a.kind === 'font');
    expect(fonts.map((f) => f.filename)).toContain('Poppins-Regular.ttf');
    expect(fonts.find((f) => f.filename === 'Poppins-Regular.ttf')?.fontFamily).toBe('Poppins');
    const lab = r.imported.find((w) => w.name === 'ece-2300L-lab1')!;
    expect(openWorkspace(lab.path).listAssets().filter((a) => a.kind === 'image')).toHaveLength(3);
    // running twice creates nothing new
    expect(importLegacy({ legacyDir: path.join(OLD, 'data'), dataDir, log: () => {} }).imported).toHaveLength(0);
  });

  it('sanitises a path-traversal filename and de-duplicates a repeated one', () => {
    const legacyDir = tmpDir(); dirs.push(legacyDir);
    const dataDir = tmpDir(); dirs.push(dataDir);
    put(legacyDir, 'folders.json', JSON.stringify({ folders: [] }));
    put(legacyDir, 'blobs/asset-1', 'AAA');
    put(legacyDir, 'blobs/asset-2', 'BBB');
    put(legacyDir, 'blobs/asset-3', 'CCC');
    put(legacyDir, 'documents/doc1.json', JSON.stringify({
      id: 'doc1',
      name: 'sanitize-test',
      folderId: null,
      source: '= T',
      assets: [
        { id: 'asset-1', kind: 'image', filename: '../evil.png', mime: 'image/png', size: 3 },
        { id: 'asset-2', kind: 'image', filename: 'shot.png', mime: 'image/png', size: 3 },
        { id: 'asset-3', kind: 'image', filename: 'shot.png', mime: 'image/png', size: 3 },
      ],
      createdAt: 0,
      updatedAt: 0,
    }));

    const r = importLegacy({ legacyDir, dataDir, log: () => {} });
    const workspacesDir = path.join(dataDir, 'workspaces');
    expect(fs.existsSync(path.join(workspacesDir, 'evil.png'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'evil.png'))).toBe(false);

    const w = r.imported.find((x) => x.name === 'sanitize-test')!;
    expect(w.assets).toBe(3);
    expect(fs.readdirSync(path.join(w.path, 'assets')).sort()).toEqual(['evil.png', 'shot-2.png', 'shot.png']);
  });
});
