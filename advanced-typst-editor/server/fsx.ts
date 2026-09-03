import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Write-then-rename so readers only ever see a complete file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch { return fallback; }
}

export function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function ensureDir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

/** A workspace/group name as a folder name safe on every filesystem. */
export function safeDirName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 80);
  return safe || 'report';
}

/** `base`, or `base (2)`, `base (3)`, ... whichever does not yet exist under `parent`. */
export function uniqueDirName(parent: string, base: string): string {
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(parent, candidate)); n++) candidate = `${base} (${n})`;
  return candidate;
}

/** Timestamp usable in a folder name: 2026-09-03T01-02-03-456Z */
export function stamp(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}
