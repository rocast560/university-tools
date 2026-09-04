import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KICAD_CLI } from '../server/config.ts';
import { createKicadCli, KicadError } from '../server/kicad-cli.ts';
import { FIXTURES } from './smoke.test.ts';

const sch = path.join(FIXTURES, 'PL1_1.kicad_sch');

describe('createKicadCli', () => {
  test('a missing executable fails with a message naming KICAD_CLI', async () => {
    const cli = createKicadCli({ exe: 'C:/definitely/missing/kicad-cli.exe', cacheDir: mkdtempSync(path.join(tmpdir(), 'kc-')) });
    expect(await cli.available()).toBe(false);
    await expect(cli.netlist(sch)).rejects.toBeInstanceOf(KicadError);
    await expect(cli.netlist(sch)).rejects.toThrow(/KICAD_CLI/);
  });

  const have = existsSync(KICAD_CLI);
  test.skipIf(!have)('exports a netlist through the real kicad-cli and caches it by content hash', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'kc-'));
    const cli = createKicadCli({ exe: KICAD_CLI, cacheDir });
    expect(await cli.available()).toBe(true);
    const t0 = performance.now();
    const text = await cli.netlist(sch);
    const first = performance.now() - t0;
    expect(text.startsWith('(export')).toBe(true);
    expect(readdirSync(cacheDir).some((f) => f.endsWith('.net'))).toBe(true);
    const t1 = performance.now();
    await cli.netlist(sch);
    expect(performance.now() - t1).toBeLessThan(first / 4);
    const svg = await cli.svg(sch);
    expect(svg).toContain('<svg');
    const erc = (await cli.erc(sch)) as { violations?: unknown[]; sheets?: unknown[] };
    expect(typeof erc).toBe('object');
  }, 60000);
});
