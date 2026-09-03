import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importLegacy } from './legacy-import';
import { createSettingsStore } from './settings';
import { openWorkspace } from './workspace';
import { tmpDir, rmDir, OLD } from './test-util';

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
});
