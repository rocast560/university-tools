// kicad-cli wrapper. Every export is cached under cacheDir by the SHA-256 of
// the schematic's content, so reopening an unchanged file costs nothing and
// a changed file always re-exports.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class KicadError extends Error {}

export interface KicadCli {
  netlist(sch: string): Promise<string>;
  svg(sch: string): Promise<string>;
  erc(sch: string): Promise<unknown>;
  available(): Promise<boolean>;
}

export async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function createKicadCli(opts: { exe: string; cacheDir: string }): KicadCli {
  const { exe, cacheDir } = opts;

  async function exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(exe, args, { timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (err.code === 'ENOENT') throw new KicadError(`kicad-cli not found at "${exe}". Install KiCad 9 or set KICAD_CLI to the path of kicad-cli.exe.`);
      throw new KicadError(`kicad-cli ${args.slice(0, 3).join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim()}`);
    }
  }

  async function cached(sch: string, ext: string, produce: (out: string) => Promise<void>): Promise<string> {
    await mkdir(cacheDir, { recursive: true });
    const key = path.join(cacheDir, `${await fileHash(sch)}${ext}`);
    try {
      return await readFile(key, 'utf8');
    } catch {
      /* not cached */
    }
    const tmp = path.join(tmpdir(), `circuit-${process.pid}-${randomUUID()}${ext}`);
    try {
      await produce(tmp);
      const text = await readFile(tmp, 'utf8');
      await writeFile(key, text);
      return text;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  return {
    async available() {
      try {
        await access(exe);
        return true;
      } catch {
        return false;
      }
    },
    netlist: (sch) => cached(sch, '.net', async (out) => void (await exec(['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch]))),
    svg: (sch) =>
      cached(sch, '.svg', async (out) => {
        const dir = `${out}-dir`;
        await mkdir(dir, { recursive: true });
        try {
          await exec(['sch', 'export', 'svg', '--no-background-color', '-o', dir, sch]);
          const produced = path.join(dir, `${path.basename(sch, '.kicad_sch')}.svg`);
          await writeFile(out, await readFile(produced));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
    erc: async (sch) => JSON.parse(await cached(sch, '.erc.json', async (out) => void (await exec(['sch', 'erc', '--format', 'json', '--units', 'mm', '--severity-all', '-o', out, sch])))),
  };
}
