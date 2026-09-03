// Where KiCad keeps symbol libraries: the global sym-lib-table, the global
// symbol directory, and the project directory for project-local libraries.

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractLibSymbol } from '../src/kicad/libsymbol.ts';
import { atom, child, children, isList, parse } from '../src/sexpr.ts';

export interface LibraryLookup {
  symbolText(libId: string): Promise<string>;
}

export class LibraryError extends Error {}

export function parseSymLibTable(text: string, symbolDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parse(text).items[0];
  if (!isList(root)) return out;
  for (const lib of children(root, 'lib')) {
    const name = child(lib, 'name');
    const uri = child(lib, 'uri');
    if (!name || !uri) continue;
    const resolved = (atom(uri, 1) ?? '').replace(/\$\{KICAD\d*_SYMBOL_DIR\}/g, symbolDir).replace(/\\/g, '/');
    out.set(atom(name, 1) ?? '', resolved);
  }
  return out;
}

const exists = (p: string) => access(p).then(() => true, () => false);

export async function findLibraryFile(nickname: string, opts: { symbolDir: string; tableFile?: string; projectDir?: string }): Promise<string | null> {
  const table = opts.tableFile ?? path.join(process.env.APPDATA ?? '', 'kicad', '9.0', 'sym-lib-table');
  try {
    const map = parseSymLibTable(await readFile(table, 'utf8'), opts.symbolDir);
    const hit = map.get(nickname);
    if (hit && (await exists(hit))) return hit;
  } catch {
    /* no table */
  }
  for (const candidate of [path.join(opts.symbolDir, `${nickname}.kicad_sym`), opts.projectDir ? path.join(opts.projectDir, `${nickname}.kicad_sym`) : '']) if (candidate && (await exists(candidate))) return candidate;
  return null;
}

export function createLibraryLookup(opts: { symbolDir: string; tableFile?: string; projectDir?: string }): LibraryLookup {
  const cache = new Map<string, string>();
  return {
    async symbolText(libId: string) {
      const i = libId.indexOf(':');
      if (i <= 0) throw new LibraryError(`"${libId}" is not a lib_id; use the form Library:Symbol, for example Device:R`);
      const nickname = libId.slice(0, i);
      const name = libId.slice(i + 1);
      const file = await findLibraryFile(nickname, opts);
      if (!file) throw new LibraryError(`library "${nickname}" not found (looked in the sym-lib-table, ${opts.symbolDir}${opts.projectDir ? ` and ${opts.projectDir}` : ''})`);
      let text = cache.get(file);
      if (!text) {
        text = await readFile(file, 'utf8');
        cache.set(file, text);
      }
      return extractLibSymbol(text, name, nickname);
    },
  };
}
