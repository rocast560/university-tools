import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { WorkspaceEntry } from '../../src/types';
import { createSettingsStore } from '../settings';
import { openWorkspace } from '../workspace';
import { tmpDir, rmDir, put } from '../test-util';
import { buildSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotName, stateDigest, writeSnapshot, type MirrorItem } from './snapshot';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function itemWithId(id: string, name: string, group: string | null, files: Record<string, string>, library = true): MirrorItem {
  const root = tmpDir(); dirs.push(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const entry: WorkspaceEntry = { id, name, group, path: root, library, createdAt: 1, openedAt: 1 };
  return { entry, files: openWorkspace(root).listFiles() };
}

function item(name: string, group: string | null, files: Record<string, string>, library = true): MirrorItem {
  return itemWithId(name, name, group, files, library);
}

describe('snapshots', () => {
  it('names by timestamp and digests state', () => {
    expect(snapshotName(Date.UTC(2026, 8, 3, 1, 2, 3))).toBe('typst-snapshot-20260903-010203.zip');
    const a = item('A', null, { 'main.typ': 'x' });
    const d1 = stateDigest([a]);
    fs.writeFileSync(path.join(a.entry.path, 'main.typ'), 'xy');
    a.files = openWorkspace(a.entry.path).listFiles();
    expect(stateDigest([a])).not.toBe(d1);
  });

  it('builds a zip with a manifest and checksums', () => {
    const { zip, manifest } = buildSnapshot([item('A', 'G', { 'main.typ': 'hello', 'workspace.json': '{}' })], { now: 5, version: '0.1.0' });
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(['G/A/main.typ', 'G/A/workspace.json', 'manifest.json']);
    expect(manifest.workspaces[0]).toMatchObject({ name: 'A', group: 'G', dir: 'G/A', library: true });
    expect(manifest.workspaces[0]!.files.find((f) => f.path === 'main.typ')!.sha256).toHaveLength(64);
  });

  it('writes, lists newest first, prunes', () => {
    const dest = tmpDir(); dirs.push(dest);
    const a = item('A', null, { 'main.typ': 'x' });
    for (let i = 0; i < 3; i++) writeSnapshot(dest, [a], { now: Date.UTC(2026, 0, 1, 0, 0, i), version: '0.1.0', destinationId: 'd1' });
    const list = listSnapshots(dest, 'd1');
    expect(list.map((s) => s.name)).toEqual(['typst-snapshot-20260101-000002.zip', 'typst-snapshot-20260101-000001.zip', 'typst-snapshot-20260101-000000.zip']);
    expect(list[0]).toMatchObject({ destinationId: 'd1', workspaces: 1 });
    expect(pruneSnapshots(dest, 2)).toBe(1);
    expect(listSnapshots(dest, 'd1')).toHaveLength(2);
  });

  it('restores library workspaces in place and external ones beside them, keeping a pre-restore copy', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const workspacesDir = path.join(dataDir, 'workspaces');
    const settings = createSettingsStore(dataDir);
    const lib = item('Lib', null, { 'main.typ': 'from snapshot' });
    const ext = item('Ext', 'G', { 'main.typ': 'ext' }, false);
    const info = writeSnapshot(dest, [lib, ext], { now: 1000, version: '0.1.0', destinationId: 'd1' });
    // current state differs from the snapshot
    put(workspacesDir, 'Lib/main.typ', 'current');
    settings.addWorkspace({ path: path.join(workspacesDir, 'Lib'), name: 'Lib', group: null, library: true });
    const r = await restoreSnapshot({ zipPath: path.join(dest, 'snapshots', info.name), dataDir, workspacesDir, settings, now: () => 2000 });
    expect(r.restored).toBe(2);
    expect(fs.readFileSync(path.join(workspacesDir, 'Lib', 'main.typ'), 'utf8')).toBe('from snapshot');
    const pre = fs.readdirSync(dataDir).find((n) => n.startsWith('pre-restore-'))!;
    expect(fs.readFileSync(path.join(dataDir, pre, 'Lib', 'main.typ'), 'utf8')).toBe('current');
    const restoredDir = fs.readdirSync(workspacesDir).find((n) => n.startsWith('restored-'))!;
    expect(fs.readFileSync(path.join(workspacesDir, restoredDir, 'Ext', 'main.typ'), 'utf8')).toBe('ext');
    expect(settings.listWorkspaces().map((w) => w.name).sort()).toEqual(['Ext', 'Lib']);
    expect(settings.listWorkspaces().find((w) => w.name === 'Ext')).toMatchObject({ group: 'G', library: true });
  });

  it('refuses a zip whose checksums do not match', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const info = writeSnapshot(dest, [item('A', null, { 'main.typ': 'x' })], { now: 1, version: '0.1.0', destinationId: 'd1' });
    const zipPath = path.join(dest, 'snapshots', info.name);
    const raw = unzipSync(fs.readFileSync(zipPath));
    raw['A/main.typ'] = new TextEncoder().encode('tampered');
    const { zipSync } = await import('fflate');
    fs.writeFileSync(zipPath, zipSync(raw));
    await expect(restoreSnapshot({ zipPath, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), settings: createSettingsStore(dataDir), now: () => 1 })).rejects.toThrow(/checksum/);
  });

  it('refuses a manifest with an unsafe path (zip-slip)', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const workspacesDir = path.join(dataDir, 'workspaces');
    const settings = createSettingsStore(dataDir);
    const evilBytes = new TextEncoder().encode('evil');
    const evilSha = crypto.createHash('sha256').update(evilBytes).digest('hex');
    const manifest = {
      app: 'typst-studio',
      version: '0.1.0',
      createdAt: 1,
      workspaces: [{ id: 'A', name: 'A', group: null, library: true, dir: 'A', files: [{ path: '../../evil.txt', size: evilBytes.length, sha256: evilSha }] }],
    };
    const { zipSync } = await import('fflate');
    const zip = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'A/../../evil.txt': evilBytes,
    });
    const zipPath = path.join(dest, 'zip-slip.zip');
    fs.writeFileSync(zipPath, zip);
    await expect(restoreSnapshot({ zipPath, dataDir, workspacesDir, settings, now: () => 5 })).rejects.toThrow(/unsafe path/);
    expect(fs.readdirSync(dataDir).some((n) => n.startsWith('pre-restore-'))).toBe(false);
    expect(fs.existsSync(path.join(workspacesDir, '..', '..', 'evil.txt'))).toBe(false);
  });

  it('gives two same-named library workspaces distinct restored folders', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const workspacesDir = path.join(dataDir, 'workspaces');
    const settings = createSettingsStore(dataDir);
    const foo1 = itemWithId('foo-1', 'Foo', null, { 'main.typ': 'first' });
    const foo2 = itemWithId('foo-2', 'Foo', null, { 'main.typ': 'second' });
    const info = writeSnapshot(dest, [foo1, foo2], { now: 2000, version: '0.1.0', destinationId: 'd1' });
    const r = await restoreSnapshot({ zipPath: path.join(dest, 'snapshots', info.name), dataDir, workspacesDir, settings, now: () => 3000 });
    expect(r.restored).toBe(2);
    expect(fs.readFileSync(path.join(workspacesDir, 'Foo', 'main.typ'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(workspacesDir, 'Foo (2)', 'main.typ'), 'utf8')).toBe('second');
    expect(settings.listWorkspaces().filter((w) => w.name === 'Foo')).toHaveLength(2);
  });
});
