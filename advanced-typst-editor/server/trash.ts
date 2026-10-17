import fs from 'node:fs';
import path from 'node:path';
import type { FolderMeta } from '../src/types';
import { readJson, uniqueDirName, writeAtomic } from './fsx';
import { HttpError } from './http';
import { normalizeRel, resolveInside } from './paths';

/**
 * The app trash, `data/trash/<stamp>/<item>/`. Everything here only ever moves
 * things in or back out; nothing deletes trash content except the clean-up of
 * a copy that has already been verified at its new home (cross-drive restore),
 * and the non-recursive `rmdir` of folders that are already empty.
 *
 * Two kinds of item sit under a stamp folder:
 *  - a document: a whole workspace folder (it has `workspace.json` at its top);
 *  - files: `<workspace folder name>/<relative path>` for deleted files or assets.
 *
 * `.trash.json` beside the items records what went in (see `TrashRecord`).
 * Items without a record (made before it existed) are still listed and
 * restored from their shape alone.
 */

/** A workspace's own metadata file; a folder with one at its top is a document. */
export const WORKSPACE_META = 'workspace.json';
export const SIDECAR = '.trash.json';

/** An asset's record from workspace.json at delete time (crop, blurs, size, font family), kept so a restore can re-apply it. */
export interface TrashAssetMeta { kind: 'assets' | 'fonts'; record: unknown }

export interface TrashDocumentRecord {
  kind: 'document';
  /** The folder's name inside the stamp folder. */
  name: string;
  originalPath: string;
  deletedAt: number;
  /** The full registry entry at delete time. */
  entry: { id: string; name: string; group: string | null; parent?: string | null; appearance?: FolderMeta; library: boolean };
}
export interface TrashFilesRecord {
  kind: 'files';
  /** The workspace folder name inside the stamp folder. */
  name: string;
  workspaceId?: string;
  deletedAt: number;
  /** `original`: the path in the workspace; `stored`: where it sits under the item folder (differs after a name clash). */
  files: Array<{ original: string; stored: string; meta?: TrashAssetMeta }>;
}
export type TrashRecord = TrashDocumentRecord | TrashFilesRecord;

export interface TrashItem {
  /** `<stamp>/<name>`. Only ever matched against the listing, never turned into a path. */
  id: string;
  stamp: string;
  name: string;
  kind: 'document' | 'files';
  deletedAt: number;
  size: number;
  fileCount: number;
  /** Absolute path of the item folder. */
  dir: string;
  /** Null for an item made before the sidecar existed. */
  record: TrashRecord | null;
  /** Every file under the item, with the path it had in the workspace. */
  files: Array<{ original: string; stored: string; meta?: TrashAssetMeta }>;
}

/** The moves a restore or a delete makes; tests swap these to simulate another drive. */
export interface MoveOps {
  rename: (from: string, to: string) => void;
  copyDir: (from: string, to: string) => void;
  copyFile: (from: string, to: string) => void;
}
const DEFAULT_OPS: MoveOps = {
  rename: (a, b) => fs.renameSync(a, b),
  copyDir: (a, b) => fs.cpSync(a, b, { recursive: true, errorOnExist: true, force: false }),
  copyFile: (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL),
};
const opsOf = (o?: Partial<MoveOps>): MoveOps => ({ ...DEFAULT_OPS, ...o });
const isExdev = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'EXDEV';

// ---- sidecar -------------------------------------------------------------

const sidecarFile = (trashDir: string, st: string): string => path.join(trashDir, st, SIDECAR);

const validRecord = (r: unknown): r is TrashRecord => {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name) return false;
  if (o.kind === 'document') return typeof o.originalPath === 'string' && !!o.entry && typeof o.entry === 'object';
  if (o.kind === 'files') return Array.isArray(o.files);
  return false;
};

function readRecords(trashDir: string, st: string): TrashRecord[] {
  const raw = readJson<{ items?: unknown }>(sidecarFile(trashDir, st), {});
  return Array.isArray(raw.items) ? raw.items.filter(validRecord) : [];
}
function writeRecords(trashDir: string, st: string, items: TrashRecord[]): void {
  writeAtomic(sidecarFile(trashDir, st), JSON.stringify({ version: 1, items }, null, 2));
}

/** Add a record to a stamp folder's sidecar. Files of the same workspace in one stamp share a record. */
export function recordTrash(trashDir: string, st: string, rec: TrashRecord): void {
  const items = readRecords(trashDir, st);
  const same = rec.kind === 'files' ? items.find((r): r is TrashFilesRecord => r.kind === 'files' && r.name === rec.name) : undefined;
  if (same && rec.kind === 'files') {
    same.files.push(...rec.files);
    if (!same.workspaceId && rec.workspaceId) same.workspaceId = rec.workspaceId;
  } else {
    items.push(rec);
  }
  writeRecords(trashDir, st, items);
}

// ---- listing -------------------------------------------------------------

/** `2026-09-03T01-02-03-456Z` (what `stamp()` writes) as epoch ms, or null. */
function parseStamp(st: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(st);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}

function walkFiles(root: string, rel: string, out: Array<{ rel: string; size: number }>): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, child, out);
    else if (e.isFile()) {
      try { out.push({ rel: child, size: fs.statSync(path.join(root, ...child.split('/'))).size }); } catch { /* vanished */ }
    }
  }
}

/** Every item in the trash, newest first. Read-only. */
export function scanTrash(trashDir: string): TrashItem[] {
  let stamps: fs.Dirent[];
  try { stamps = fs.readdirSync(trashDir, { withFileTypes: true }); } catch { return []; }
  const out: TrashItem[] = [];
  for (const s of stamps) {
    if (!s.isDirectory()) continue;
    const stampDir = path.join(trashDir, s.name);
    const records = readRecords(trashDir, s.name);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(stampDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === SIDECAR) continue;
      const dir = path.join(stampDir, e.name);
      const record = records.find((r) => r.name === e.name) ?? null;
      const kind: 'document' | 'files' = record ? record.kind : fs.existsSync(path.join(dir, WORKSPACE_META)) ? 'document' : 'files';
      const found: Array<{ rel: string; size: number }> = [];
      walkFiles(dir, '', found);
      const originals = new Map<string, { original: string; meta?: TrashAssetMeta }>();
      if (record?.kind === 'files') for (const f of record.files) originals.set(f.stored, { original: f.original, meta: f.meta });
      let deletedAt = record && Number.isFinite(record.deletedAt) ? record.deletedAt : parseStamp(s.name);
      if (deletedAt === null) { try { deletedAt = Math.round(fs.statSync(dir).mtimeMs); } catch { deletedAt = 0; } }
      out.push({
        id: `${s.name}/${e.name}`,
        stamp: s.name,
        name: e.name,
        kind,
        deletedAt,
        size: found.reduce((n, f) => n + f.size, 0),
        fileCount: found.length,
        dir,
        record,
        files: found.map((f) => {
          const o = originals.get(f.rel);
          return { stored: f.rel, original: o?.original ?? f.rel, ...(o?.meta ? { meta: o.meta } : {}) };
        }),
      });
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? 1 : -1));
}

// ---- moves ---------------------------------------------------------------

/**
 * Move a folder to a path that must not exist yet. Across drives it copies
 * first and removes the source only after the copy finished; a failed copy
 * removes the half-made copy (the path was free, so it is ours) and leaves the
 * source as it was.
 */
function moveDir(src: string, dest: string, ops: MoveOps): void {
  if (fs.existsSync(dest)) throw new HttpError(409, `${dest} already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    ops.rename(src, dest);
    return;
  } catch (err) {
    if (!isExdev(err)) throw err;
  }
  try {
    ops.copyDir(src, dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(src, { recursive: true, force: true });
}

function moveFile(src: string, dest: string, ops: MoveOps): void {
  if (fs.existsSync(dest)) throw new HttpError(409, `${dest} already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    ops.rename(src, dest);
    return;
  } catch (err) {
    if (!isExdev(err)) throw err;
  }
  try {
    ops.copyFile(src, dest);
  } catch (err) {
    // EEXIST means the destination is someone else's file that appeared after our check: leave it.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { try { fs.unlinkSync(dest); } catch { /* nothing was written */ } }
    throw err;
  }
  fs.unlinkSync(src);
}

/** `<stem> (restored)<ext>`, then `(restored 2)`, ... whichever is free under `dir`. */
function restoredName(dir: string, base: string, ext: string): string {
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  for (let n = 1; ; n++) {
    const candidate = `${stem} (restored${n === 1 ? '' : ` ${n}`})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** Move a library document's folder into `<trash>/<stamp>/` and record it. Returns the folder it now sits in. */
export function trashDocument(trashDir: string, st: string, srcDir: string, record: TrashDocumentRecord, ops?: Partial<MoveOps>): string {
  const stampDir = path.join(trashDir, st);
  fs.mkdirSync(stampDir, { recursive: true });
  const name = uniqueDirName(stampDir, record.name);
  const dest = path.join(stampDir, name);
  moveDir(srcDir, dest, opsOf(ops));
  try {
    recordTrash(trashDir, st, { ...record, name });
  } catch (err) {
    // The folder is already safe in the trash; without a record it still lists and restores.
    console.warn(`could not write ${SIDECAR} for ${dest}: ${err instanceof Error ? err.message : err}`);
  }
  return dest;
}

// ---- restore -------------------------------------------------------------

/** Remove directories under `dir` that hold nothing, deepest first. `rmdir` only, so a directory with anything in it stays. */
function pruneEmptyDirs(dir: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name));
  try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
}

/**
 * After something left the trash: drop its record, remove emptied folders and,
 * when the stamp folder is then empty, the stamp folder itself (`rmdir`,
 * never recursive). `moved` are the stored paths of a files item that did move.
 */
function settle(trashDir: string, item: TrashItem, moved?: string[]): void {
  if (item.kind === 'files') pruneEmptyDirs(item.dir);
  const stampDir = path.join(trashDir, item.stamp);
  if (fs.existsSync(sidecarFile(trashDir, item.stamp))) {
    const gone = new Set(moved ?? []);
    const remaining: TrashRecord[] = [];
    for (const r of readRecords(trashDir, item.stamp)) {
      if (!fs.existsSync(path.join(stampDir, r.name))) continue; // its folder is gone: nothing left to describe
      if (r.name === item.name && r.kind === 'files') r.files = r.files.filter((f) => !gone.has(f.stored));
      remaining.push(r);
    }
    // A sidecar that describes nothing is dropped so the stamp folder can go; it holds no user content.
    if (remaining.length === 0) { try { fs.unlinkSync(sidecarFile(trashDir, item.stamp)); } catch { /* already gone */ } }
    else writeRecords(trashDir, item.stamp, remaining);
  }
  try { fs.rmdirSync(stampDir); } catch { /* still has something in it */ }
}

/** The folder name a restored document goes back to: its original, else a free "(restored)" name next to it. */
export function restoreDocument(trashDir: string, item: TrashItem, workspacesDir: string, ops?: Partial<MoveOps>): { dir: string; folderName: string; suffix: string } {
  if (item.kind !== 'document') throw new HttpError(400, 'that item is not a document');
  const original = (item.record?.kind === 'document' ? item.record.originalPath.split(/[\\/]/).filter(Boolean).pop() : undefined) ?? item.name;
  const base = original && original !== '.' && original !== '..' ? original : item.name;
  fs.mkdirSync(workspacesDir, { recursive: true });
  const folderName = fs.existsSync(path.join(workspacesDir, base)) ? restoredName(workspacesDir, base, '') : base;
  const dir = path.join(workspacesDir, folderName);
  moveDir(item.dir, dir, opsOf(ops));
  settle(trashDir, item);
  return { dir, folderName, suffix: folderName.slice(base.length) };
}

/** Put each file of a files item back under `wsRoot`, at its original path or a free "(restored)" name beside it. */
export function restoreFiles(trashDir: string, item: TrashItem, wsRoot: string, ops?: Partial<MoveOps>): Array<{ from: string; to: string; renamed: boolean; meta?: TrashAssetMeta }> {
  if (item.kind !== 'files') throw new HttpError(400, 'that item is not a set of files');
  const o = opsOf(ops);
  const done: Array<{ from: string; to: string; renamed: boolean; meta?: TrashAssetMeta }> = [];
  const movedStored: string[] = [];
  try {
    for (const f of item.files) {
      const rel = normalizeRel(f.original);
      const target = rel ? resolveInside(wsRoot, rel) : null;
      if (!rel || !target) throw new HttpError(400, `cannot restore to ${f.original}`);
      let dest = target;
      let destRel = rel;
      if (fs.existsSync(dest)) {
        const name = restoredName(path.dirname(dest), path.basename(dest), path.extname(dest));
        dest = path.join(path.dirname(dest), name);
        destRel = rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/'))}/${name}` : name;
      }
      moveFile(path.join(item.dir, ...f.stored.split('/')), dest, o);
      movedStored.push(f.stored);
      done.push({ from: rel, to: destRel, renamed: destRel !== rel, ...(f.meta ? { meta: f.meta } : {}) });
    }
  } finally {
    // Runs on a failure too, so the record always matches what is still in the trash.
    settle(trashDir, item, movedStored);
  }
  return done;
}
