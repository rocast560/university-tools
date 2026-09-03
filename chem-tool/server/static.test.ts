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
});
