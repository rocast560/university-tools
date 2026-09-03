import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { SnapshotInfo } from '../../src/types';
import { ensureDir, safeDirName, stamp, uniqueDirName } from '../fsx';
import { HttpError } from '../http';
import type { SettingsStore } from '../settings';
import { planMirror, SNAPSHOTS_DIR, type MirrorItem } from './mirror';

export type { MirrorItem };

export interface ManifestFile { path: string; size: number; sha256: string }
export interface ManifestWorkspace { id: string; name: string; group: string | null; library: boolean; dir: string; files: ManifestFile[] }
export interface Manifest { app: 'typst-studio'; version: string; createdAt: number; workspaces: ManifestWorkspace[] }

const NAME_RE = /^typst-snapshot-(\d{8})-(\d{6})\.zip$/;

export function snapshotName(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `typst-snapshot-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.zip`;
}

/** Cheap fingerprint of every workspace's file list (path, size, mtime): changes whenever anything changed. */
export function stateDigest(items: MirrorItem[]): string {
  const h = crypto.createHash('sha256');
  for (const it of [...items].sort((a, b) => a.entry.id.localeCompare(b.entry.id))) {
    h.update(`${it.entry.id}|${it.entry.name}|${it.entry.group ?? ''}\n`);
    for (const f of [...it.files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}|${f.size}|${f.mtime}\n`);
    try { const st = fs.statSync(path.join(it.entry.path, 'workspace.json')); h.update(`workspace.json|${st.size}|${Math.round(st.mtimeMs)}\n`); } catch { /* none */ }
  }
  return h.digest('hex');
}

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const STORE_ONLY = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|ttc|zip|pdf)$/i;

export function buildSnapshot(items: MirrorItem[], opts: { now: number; version: string }): { zip: Uint8Array; manifest: Manifest } {
  const plan = planMirror(items);
  const zippable: Zippable = {};
  const manifest: Manifest = { app: 'typst-studio', version: opts.version, createdAt: opts.now, workspaces: [] };
  for (const it of items) {
    const dir = plan.dirOf.get(it.entry.id);
    if (!dir) continue;
    const files: ManifestFile[] = [];
    const rels = it.files.map((f) => f.path);
    if (fs.existsSync(path.join(it.entry.path, 'workspace.json'))) rels.push('workspace.json');
    for (const rel of rels) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(fs.readFileSync(path.join(it.entry.path, ...rel.split('/')))); } catch { continue; }
      zippable[`${dir}/${rel}`] = [bytes, { level: STORE_ONLY.test(rel) ? 0 : 6 }];
      files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    }
    manifest.workspaces.push({ id: it.entry.id, name: it.entry.name, group: it.entry.group, library: it.entry.library, dir, files });
  }
  zippable['manifest.json'] = [new TextEncoder().encode(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return { zip: zipSync(zippable), manifest };
}

export function writeSnapshot(dest: string, items: MirrorItem[], opts: { now: number; version: string; destinationId: string }): SnapshotInfo {
  const dir = path.join(dest, SNAPSHOTS_DIR);
  ensureDir(dir);
  const name = snapshotName(opts.now);
  const { zip, manifest } = buildSnapshot(items, opts);
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, path.join(dir, name));
  return { destinationId: opts.destinationId, name, createdAt: opts.now, bytes: zip.length, workspaces: manifest.workspaces.length };
}

export function listSnapshots(dest: string, destinationId: string): SnapshotInfo[] {
  const dir = path.join(dest, SNAPSHOTS_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)); } catch { return []; }
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name)!;
    const d = m[1]!, t = m[2]!;
    const createdAt = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
    let bytes = 0, workspaces = 0;
    try {
      const st = fs.statSync(path.join(dir, name)); bytes = st.size;
      const entries = unzipSync(fs.readFileSync(path.join(dir, name)), { filter: (f) => f.name === 'manifest.json' });
      const man = entries['manifest.json'];
      if (man) workspaces = (JSON.parse(new TextDecoder().decode(man)) as Manifest).workspaces.length;
    } catch { /* unreadable: still listed */ }
    out.push({ destinationId, name, createdAt, bytes, workspaces });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function pruneSnapshots(dest: string, keep: number): number {
  const list = listSnapshots(dest, '');
  let removed = 0;
  for (const s of list.slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dest, SNAPSHOTS_DIR, s.name)); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

export async function restoreSnapshot(deps: { zipPath: string; dataDir: string; workspacesDir: string; settings: SettingsStore; now: () => number }): Promise<{ restored: number }> {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(fs.readFileSync(deps.zipPath)); } catch { throw new HttpError(400, 'snapshot is not a readable zip'); }
  const manRaw = entries['manifest.json'];
  if (!manRaw) throw new HttpError(400, 'snapshot has no manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manRaw)) as Manifest;
  if (manifest.app !== 'typst-studio') throw new HttpError(400, 'not a Typst Studio snapshot');
  for (const w of manifest.workspaces) for (const f of w.files) {
    const bytes = entries[`${w.dir}/${f.path}`];
    if (!bytes || sha256(bytes) !== f.sha256) throw new HttpError(400, `checksum mismatch for ${w.dir}/${f.path}; the snapshot is damaged`);
  }
  const t = stamp(deps.now());
  ensureDir(deps.workspacesDir);
  const pre = path.join(deps.dataDir, `pre-restore-${t}`);
  fs.cpSync(deps.workspacesDir, pre, { recursive: true });
  let restoredRoot: string | null = null;
  let restored = 0;
  for (const w of manifest.workspaces) {
    const base = safeDirName(w.name);
    let target: string;
    if (w.library) {
      const existing = deps.settings.listWorkspaces().find((e) => e.library && e.name === w.name);
      target = existing?.path ?? path.join(deps.workspacesDir, uniqueDirName(deps.workspacesDir, base));
    } else {
      restoredRoot ??= path.join(deps.workspacesDir, `restored-${t}`);
      target = path.join(restoredRoot, uniqueDirName(restoredRoot, base));
    }
    ensureDir(target);
    for (const f of w.files) {
      const abs = path.join(target, ...f.path.split('/'));
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, entries[`${w.dir}/${f.path}`]!);
    }
    if (!deps.settings.findByPath(target)) deps.settings.addWorkspace({ path: target, name: w.name, group: w.group, library: true });
    restored += 1;
  }
  return { restored };
}
