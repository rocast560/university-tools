import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalise a client-supplied workspace-relative path to forward slashes.
 * Returns null for anything that could escape: absolute paths, drive
 * letters, `..`, NUL. The empty string (the root) normalises to ''.
 */
export function normalizeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

/** Absolute path of `rel` under `root`, or null when it escapes (symlinks included, when it exists). */
export function resolveInside(root: string, rel: unknown): string | null {
  const n = normalizeRel(rel);
  if (n === null) return null;
  const rootAbs = path.resolve(root);
  const target = n === '' ? rootAbs : path.resolve(rootAbs, ...n.split('/'));
  const inside = (p: string) => p === rootAbs || p.startsWith(rootAbs + path.sep);
  if (!inside(target)) return null;
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(rootAbs);
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return null;
  } catch { /* does not exist yet */ }
  return target;
}

export function isAbsoluteWindowsOrPosix(p: string): boolean {
  return path.isAbsolute(p) && !p.includes('\0');
}
