import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, DirListing } from '../src/types';
import { MARKER_FILE } from './backup/mirror';
import { HttpError } from './http';

function drives(): DirEntry[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/', isEmpty: false, isBackupRoot: false }];
  const out: DirEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`;
    try { if (fs.statSync(p).isDirectory()) out.push({ name: p.slice(0, 2), path: p, isEmpty: false, isBackupRoot: false }); } catch { /* no such drive */ }
  }
  return out;
}

export function browse(p: string): DirListing {
  if (!p) return { path: '', parent: null, entries: drives() };
  if (!path.isAbsolute(p) || p.includes('\0')) throw new HttpError(400, 'path must be absolute');
  const abs = path.resolve(p);
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { throw new HttpError(404, 'no such folder'); }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const child = path.join(abs, d.name);
    let children: string[];
    try { children = fs.readdirSync(child); } catch { continue; }
    entries.push({ name: d.name, path: child, isEmpty: children.length === 0, isBackupRoot: children.includes(MARKER_FILE) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, entries };
}
