import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createHandler } from './router';
import { browse } from './fs-browse';
import { createLogoStore } from './logos';
import { MAX_LOGO_BYTES, isLogoName } from '../src/lib/logo';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

describe('logo store', () => {
  it('writes a logo under data/logos with a generated safe name', () => {
    const d = tmpDir(); dirs.push(d);
    const store = createLogoStore(d);
    const name = store.save(PNG, 'image/png');
    expect(isLogoName(name)).toBe(true);
    expect(name.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(path.join(d, 'logos', name))).toEqual(Buffer.from(PNG));
    expect(store.save(PNG, 'image/png')).not.toBe(name);
  });

  it('accepts png, jpeg, webp and svg', () => {
    const d = tmpDir(); dirs.push(d);
    const store = createLogoStore(d);
    expect(store.save(PNG, 'image/jpeg').endsWith('.jpg')).toBe(true);
    expect(store.save(PNG, 'image/webp').endsWith('.webp')).toBe(true);
    expect(store.save(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml').endsWith('.svg')).toBe(true);
  });

  it('rejects other types, empty bodies and anything over 512 KB, writing nothing', () => {
    const d = tmpDir(); dirs.push(d);
    const store = createLogoStore(d);
    expect(() => store.save(PNG, 'image/gif')).toThrow(/PNG, JPEG, WebP or SVG/);
    expect(() => store.save(PNG, 'text/html')).toThrow(/PNG, JPEG, WebP or SVG/);
    expect(() => store.save(new Uint8Array(0), 'image/png')).toThrow(/empty/);
    expect(() => store.save(new Uint8Array(MAX_LOGO_BYTES + 1), 'image/png')).toThrow(/512 KB/);
    expect(fs.existsSync(path.join(d, 'logos')) ? fs.readdirSync(path.join(d, 'logos')) : []).toEqual([]);
    expect(store.save(new Uint8Array(MAX_LOGO_BYTES), 'image/png')).toBeTruthy();
  });

  it('reads back only a safe name that exists', () => {
    const d = tmpDir(); dirs.push(d);
    const store = createLogoStore(d);
    const name = store.save(PNG, 'image/png');
    expect(store.read(name)).toEqual(Buffer.from(PNG));
    expect(store.read('missing.png')).toBeNull();
    expect(store.read('../settings.json')).toBeNull();
  });
});

function app() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T\n' });
  const handler = createHandler({ settings, service, bus, token: null, staticDir: null, dataDir, backup: null, compile: null, mcp: null, browse });
  const call = (method: string, url: string, body?: Uint8Array, type?: string) =>
    handler(new Request(`http://127.0.0.1:8090${url}`, { method, headers: type ? { 'content-type': type } : {}, body }));
  return { call, dataDir };
}

describe('logo routes', () => {
  it('uploads and serves back with sandboxing headers', async () => {
    const { call, dataDir } = app();
    const up = await call('POST', '/api/logos', PNG, 'image/png');
    expect(up.status).toBe(201);
    const { logo } = await up.json() as { logo: string };
    expect(isLogoName(logo)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'logos', logo))).toBe(true);
    const got = await call('GET', `/api/logos/${logo}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  it('serves an svg as image/svg+xml, sandboxed', async () => {
    const { call } = app();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { logo } = await (await call('POST', '/api/logos', svg, 'image/svg+xml')).json() as { logo: string };
    const got = await call('GET', `/api/logos/${logo}`);
    expect(got.headers.get('content-type')).toBe('image/svg+xml');
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('ignores content-type parameters', async () => {
    const { call } = app();
    expect((await call('POST', '/api/logos', PNG, 'Image/PNG; charset=binary')).status).toBe(201);
  });

  it('rejects a bad type with 415 and an oversize body with 413', async () => {
    const { call, dataDir } = app();
    const bad = await call('POST', '/api/logos', PNG, 'image/gif');
    expect(bad.status).toBe(415);
    expect(((await bad.json()) as { error: string }).error).toMatch(/PNG, JPEG, WebP or SVG/);
    expect((await call('POST', '/api/logos', PNG)).status).toBe(415);
    const big = await call('POST', '/api/logos', new Uint8Array(MAX_LOGO_BYTES + 1), 'image/png');
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/512 KB/);
    expect((await call('POST', '/api/logos', new Uint8Array(0), 'image/png')).status).toBe(400);
    expect(fs.existsSync(path.join(dataDir, 'logos')) ? fs.readdirSync(path.join(dataDir, 'logos')) : []).toEqual([]);
  });

  it('404s an unsafe or unknown name and cannot be used to read other files', async () => {
    const { call } = app();
    expect((await call('GET', '/api/logos/nope.png')).status).toBe(404);
    expect((await call('GET', '/api/logos/..%2Fsettings.json')).status).toBe(404);
    expect((await call('GET', '/api/logos/x.gif')).status).toBe(404);
  });
});
