import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createHandler } from './router';
import { createBackup } from './backup/index';
import { browse } from './fs-browse';
import { tmpDir, rmDir, OLD } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function app(token: string | null = null) {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T\n' });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), version: '0.1.0', quietMs: 50 });
  const handler = createHandler({ settings, service, bus, token, staticDir: null, dataDir, backup, compile: null, mcp: null, browse });
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://127.0.0.1:8090${url}`, {
      method,
      headers: { ...(body instanceof Uint8Array ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined,
    }));
  return { call, service, bus };
}

describe('router', () => {
  it('health, create, detail, file round trip, asset upload and patch', async () => {
    const { call } = app();
    expect((await call('GET', '/api/health')).status).toBe(200);
    const created = await (await call('POST', '/api/workspaces', { name: 'R', group: 'G' })).json() as { workspace: { id: string } };
    const id = created.workspace.id;
    const list = await (await call('GET', '/api/workspaces')).json() as { workspaces: Array<{ id: string; status: string }> };
    expect(list.workspaces[0]).toMatchObject({ id, status: 'ok' });

    const put = await call('PUT', `/api/workspaces/${id}/files/main.typ`, new TextEncoder().encode('= New'), { 'x-client-id': 'c1' });
    expect(put.status).toBe(200);
    const got = await call('GET', `/api/workspaces/${id}/files/main.typ`);
    expect(await got.text()).toBe('= New');
    expect(got.headers.get('etag')).toMatch(/^"\d+-\d+"$/);
    expect((await call('GET', `/api/workspaces/${id}/files/../x`)).status).toBe(404);

    const up = await call('POST', `/api/workspaces/${id}/assets?filename=shot.png&folder=f1&kind=image`, new Uint8Array(PNG));
    expect(up.status).toBe(201);
    const { asset } = await up.json() as { asset: { id: string } };
    expect(asset.id).toBe('assets/f1/shot.png');
    const patched = await call('PATCH', `/api/workspaces/${id}/assets/assets/f1/shot.png`, { crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    expect(((await patched.json()) as { asset: { crop: unknown } }).asset.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    const renamed = await call('PATCH', `/api/workspaces/${id}/assets/assets/f1/shot.png`, { stem: 'better' });
    expect(((await renamed.json()) as { asset: { id: string } }).asset.id).toBe('assets/f1/better.png');

    const fontUp = await call('POST', `/api/workspaces/${id}/assets?filename=DejaVuSansMono.ttf&kind=font`, fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')));
    expect(fontUp.status).toBe(201);
    const { asset: fontAsset } = await fontUp.json() as { asset: { id: string; fontFamily: string } };
    expect(fontAsset.fontFamily).toBe('DejaVu Sans Mono');
    await call('DELETE', `/api/workspaces/${id}/assets/${fontAsset.id}`);

    const detail = await (await call('GET', `/api/workspaces/${id}`)).json() as { assets: unknown[]; folders: Array<{ id: string }>; meta: unknown };
    expect(detail.assets).toHaveLength(1);
    expect(detail.folders.map((f) => f.id)).toEqual(['f1']);
    expect((await call('DELETE', `/api/workspaces/${id}/asset-folders?path=f1`)).status).toBe(200);
    expect((await call('DELETE', `/api/workspaces/${id}/assets/assets/better.png`)).status).toBe(200);
    expect((await call('GET', '/api/workspaces/nope')).status).toBe(404);
    expect((await call('GET', '/api/backup')).status).toBe(200);
  });

  it('requires the bearer token when one is set, except for health', async () => {
    const { call } = app('secret');
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/workspaces')).status).toBe(401);
    expect((await call('GET', '/api/workspaces', undefined, { authorization: 'Bearer secret' })).status).toBe(200);
  });

  it('streams events over SSE', async () => {
    const { call, service } = app();
    const res = await call('GET', '/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: hello');
    service.create({ name: 'A', group: null, source: undefined });
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(next).toContain('workspaces.changed');
    await reader.cancel();
  });

  it('configures, runs, lists and browses backups', async () => {
    const { call } = app();
    const dest = tmpDir(); dirs.push(dest);
    const cfg = await call('PATCH', '/api/backup', { destinations: [{ path: dest, mirror: true, snapshots: true }] });
    expect(cfg.status).toBe(200);
    await call('POST', '/api/workspaces', { name: 'R' });
    const ran = await (await call('POST', '/api/backup/run')).json() as { backup: { destinations: Array<{ id: string }>; lastSnapshotAt: number } };
    expect(ran.backup.lastSnapshotAt).toBeTruthy();
    const snaps = await (await call('GET', `/api/backup/snapshots?destination=${ran.backup.destinations[0]!.id}`)).json() as { snapshots: unknown[] };
    expect(snaps.snapshots).toHaveLength(1);
    const browse = await (await call('GET', `/api/fs/browse?path=${encodeURIComponent(dest)}`)).json() as { entries: Array<{ name: string }> };
    expect(browse.entries.map((e) => e.name)).toContain('snapshots');
  });
});
