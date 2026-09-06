import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCloudflared } from '../server/tunnel.ts';

const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

describe('findCloudflared', () => {
  test('prefers the downloaded copy, then PATH, else null', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cf-'));
    expect(await findCloudflared(dir, () => null)).toBeNull();
    expect(await findCloudflared(dir, () => '/usr/local/bin/cloudflared')).toBe('/usr/local/bin/cloudflared');
    writeFileSync(path.join(dir, exe), '');
    expect(await findCloudflared(dir, () => '/usr/local/bin/cloudflared')).toBe(path.join(dir, exe));
  });
});
