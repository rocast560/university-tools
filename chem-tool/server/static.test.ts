import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

function make(staticDir: string) {
  const resolver = createResolver({ pubchem: null });
  const store = new WorkspaceStore(createInitialWorkspace(), resolver);
  return createApp({ store, resolver, staticDir }).app;
}

describe('static serving', () => {
  test('without a build, / explains how to build and asset paths are plain 404s', async () => {
    const app = make('does-not-exist-dir');
    const root = await app.request('/');
    expect(root.status).toBe(404);
    expect(await root.text()).toContain('Client not built');
    const deep = await app.request('/some/route');
    expect(await deep.text()).toContain('Client not built');
    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(404);
    expect(await asset.text()).not.toContain('Client not built');
  });
  test('path traversal is refused', async () => {
    const app = make('does-not-exist-dir');
    expect((await app.request('/..%2F..%2Fpackage.json')).status).not.toBe(200);
  });
  test('a sibling directory sharing the base name prefix is not served', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'chemstatic-'));
    try {
      const base = path.join(root, 'dist');
      const sibling = path.join(root, 'dist-secret');
      await mkdir(base, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(base, 'index.html'), '<h1>app</h1>');
      await writeFile(path.join(sibling, 'secret.txt'), 'top secret');
      const app = make(base);
      const res = await app.request('/..%2Fdist-secret%2Fsecret.txt');
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('top secret');
      expect(await (await app.request('/')).text()).toContain('<h1>app</h1>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
