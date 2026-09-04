import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, WorkspaceEntry } from '../../src/types';
import { safeDirName, stamp } from '../fsx';
import { HttpError } from '../http';

export const MARKER_FILE = '.typst-studio-backup.json';
export const TRASH_DIR = '_trash';
export const SNAPSHOTS_DIR = 'snapshots';
const RESERVED = new Set([TRASH_DIR.toLowerCase(), SNAPSHOTS_DIR.toLowerCase(), MARKER_FILE.toLowerCase(), 'readme.txt']);

export interface MirrorItem { entry: WorkspaceEntry; files: FileEntry[] }
export interface MirrorFile { path: string; source: { root: string; rel: string } | { text: string } }
export interface MirrorPlan { dirs: string[]; files: MirrorFile[]; dirOf: Map<string, string> }

function uniqueNames<T>(items: T[], nameOf: (t: T) => string, taken: Set<string>): Map<T, string> {
  const out = new Map<T, string>();
  for (const it of items) {
    const base = safeDirName(nameOf(it));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
    taken.add(candidate.toLowerCase());
    out.set(it, candidate);
  }
  return out;
}

function readme(groups: number, workspaces: number): string {
  return [
    'Typst Studio backup (mirror).',
    '',
    'This folder is rewritten automatically whenever a workspace changes. Every',
    'workspace is a folder holding main.typ, assets/, fonts/ and workspace.json,',
    'grouped by the groups you made in the app. Loose workspaces sit at the top level.',
    '',
    `${groups} group${groups === 1 ? '' : 's'}, ${workspaces} workspace${workspaces === 1 ? '' : 's'}.`,
    '',
    'Images here are the ORIGINAL uploads. Crop and blur are applied by the app when',
    'it renders, so redactions are NOT baked into these files; workspace.json records',
    'them. Treat this folder as sensitive, or export a PDF from the app.',
    '',
    `Nothing here is ever deleted. Stale files move to ${TRASH_DIR}/<timestamp>/.`,
    `Timed snapshots live in ${SNAPSHOTS_DIR}/.`,
    '',
    'Compile any workspace with the Typst CLI from its folder:',
    '    typst compile --root . --font-path fonts main.typ',
    '',
  ].join('\n');
}

export function planMirror(items: MirrorItem[]): MirrorPlan {
  const taken = new Set<string>(RESERVED);
  const sorted = [...items].sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.entry.id.localeCompare(b.entry.id));
  const groups = [...new Set(sorted.map((i) => i.entry.group).filter((g): g is string => !!g))].sort();
  const groupDirs = uniqueNames(groups, (g) => g, taken);
  const loose = sorted.filter((i) => !i.entry.group);
  const looseDirs = uniqueNames(loose, (i) => i.entry.name, taken);
  const dirs: string[] = [...groupDirs.values()];
  const files: MirrorFile[] = [];
  const dirOf = new Map<string, string>();
  const emit = (it: MirrorItem, dir: string) => {
    dirs.push(dir);
    dirOf.set(it.entry.id, dir);
    for (const f of it.files) files.push({ path: `${dir}/${f.path}`, source: { root: it.entry.path, rel: f.path } });
    if (fs.existsSync(path.join(it.entry.path, 'workspace.json'))) files.push({ path: `${dir}/workspace.json`, source: { root: it.entry.path, rel: 'workspace.json' } });
  };
  for (const it of loose) emit(it, looseDirs.get(it)!);
  for (const g of groups) {
    const members = sorted.filter((i) => i.entry.group === g);
    const memberDirs = uniqueNames(members, (i) => i.entry.name, new Set());
    for (const it of members) emit(it, `${groupDirs.get(g)!}/${memberDirs.get(it)!}`);
  }
  files.push({ path: 'README.txt', source: { text: readme(groups.length, items.length) } });
  return { dirs, files, dirOf };
}

/** Ours to reconcile: missing, empty, or carrying the marker. */
export function claimable(dir: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return true; }
  return entries.length === 0 || entries.includes(MARKER_FILE);
}

export function runMirror(dest: string, plan: MirrorPlan, opts: { now?: () => number; log?: (...a: unknown[]) => void } = {}): { written: number; trashed: number } {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((...a: unknown[]) => console.error('[mirror]', ...a));
  if (!claimable(dest)) throw new HttpError(409, `${dest} already has files this app did not write; pick an empty folder or one used for a previous backup`);
  fs.mkdirSync(dest, { recursive: true });

  const expectedFiles = new Set(plan.files.map((f) => f.path));
  const expectedDirs = new Set(plan.dirs);
  const keepAtRoot = new Set([TRASH_DIR, SNAPSHOTS_DIR, MARKER_FILE]);
  const trashStamp = stamp(now());
  let trashed = 0;
  const moveToTrash = (rel: string) => {
    const from = path.join(dest, ...rel.split('/'));
    const to = path.join(dest, TRASH_DIR, trashStamp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); trashed += 1; } catch (err) { log(`could not move ${rel} to ${TRASH_DIR}:`, err instanceof Error ? err.message : err); }
  };
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(rel ? path.join(dest, ...rel.split('/')) : dest, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && keepAtRoot.has(e.name)) continue;
      if (e.isDirectory()) {
        if (expectedDirs.has(child) || plan.files.some((f) => f.path.startsWith(`${child}/`))) walk(child);
        else moveToTrash(child);
      } else if (!expectedFiles.has(child)) moveToTrash(child);
    }
  };
  walk('');

  let written = 0;
  for (const f of plan.files) {
    const target = path.join(dest, ...f.path.split('/'));
    let bytes: Buffer;
    if ('text' in f.source) bytes = Buffer.from(f.source.text, 'utf8');
    else { try { bytes = fs.readFileSync(path.join(f.source.root, ...f.source.rel.split('/'))); } catch { continue; } }
    try { const existing = fs.readFileSync(target); if (existing.equals(bytes)) continue; } catch { /* new */ }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    written += 1;
  }
  fs.writeFileSync(path.join(dest, MARKER_FILE), `${JSON.stringify({ app: 'typst-studio', writtenAt: now(), workspaces: plan.dirOf.size }, null, 2)}\n`);
  return { written, trashed };
}
