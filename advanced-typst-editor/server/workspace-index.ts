// ─────────────────────────────────────────────────────────────────────────
// In-memory index of a workspace folder.
//
// The detail route used to walk the folder with synchronous stat calls on
// every request, and on a Docker bind mount each call costs milliseconds
// and blocks Bun's single event loop while it runs. This module builds the
// listing once, asynchronously, and keeps it until something says the
// folder changed: the server's own writes and the watcher both report
// through the event bus, and the service forwards them here as `touch`
// (one plain file) or `invalidate` (anything structural). A snapshot older
// than `maxAgeMs` is rebuilt anyway, as a safety net for edits the watcher
// never sees.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AssetFolder, FileEntry, TypstAsset, WorkspaceJson } from '../src/types';
import { readJsonAsync } from './fsx';
import { ASSETS_DIR, FONTS_DIR, META_FILE, SKIP_DIRS, assetFromFile, normaliseMeta } from './workspace';

export interface WorkspaceSnapshot {
  files: FileEntry[];
  meta: WorkspaceJson;
  assets: TypstAsset[];
  folders: AssetFolder[];
  /** Changes whenever `files` or `meta` change; the detail route's ETag. */
  etag: string;
  builtAt: number;
}

export interface WorkspaceIndex {
  /** The current snapshot, building or refreshing it first when needed. */
  get(root: string): Promise<WorkspaceSnapshot>;
  /** Forget the snapshot; the next `get` rebuilds. */
  invalidate(root: string): void;
  /**
   * A path changed. A plain file is re-stated on the next `get` and patched
   * into the snapshot; anything under assets/ or fonts/, workspace.json, or a
   * directory invalidates the whole snapshot.
   */
  touch(root: string, rel: string): void;
  has(root: string): boolean;
  /** Full builds so far, for tests. */
  readonly builds: number;
}

/** Rebuild age, chosen so a missed watcher event costs at most this much staleness. */
export const DEFAULT_MAX_AGE_MS = 30_000;

interface Entry {
  snap: WorkspaceSnapshot | null;
  building: Promise<WorkspaceSnapshot> | null;
  /** Plain files to re-stat before the next read. */
  pending: Set<string>;
  stale: boolean;
}

const toRel = (rel: string): string => rel.replace(/\\/g, '/').replace(/^\/+/, '');

function isStructural(rel: string): boolean {
  const top = rel.split('/')[0];
  return top === ASSETS_DIR || top === FONTS_DIR || rel.toLowerCase() === META_FILE;
}

function etagOf(files: FileEntry[], meta: WorkspaceJson): string {
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(`${f.path}\0${f.size}\0${f.mtime}\n`);
  h.update(JSON.stringify(meta));
  return h.digest('hex').slice(0, 16);
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Walked { files: FileEntry[]; folders: AssetFolder[]; birth: Map<string, number> }

/**
 * List the folder. Stats within one directory run concurrently: on a bind
 * mount the cost is latency per call, not bandwidth.
 */
async function walk(root: string, rel: string, out: Walked): Promise<void> {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  let entries: Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const dirs: string[] = [];
  await Promise.all(entries.map(async (e) => {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name.endsWith('.tmp')) return;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      dirs.push(child);
      if (child.startsWith(`${ASSETS_DIR}/`)) {
        let t = Date.now();
        try { t = Math.round((await fsp.stat(path.join(dir, e.name))).mtimeMs); } catch { /* keep now */ }
        const id = child.slice(ASSETS_DIR.length + 1);
        const parent = path.posix.dirname(id);
        out.folders.push({ id, name: e.name, parentId: parent === '.' ? null : parent, createdAt: t, updatedAt: t });
      }
      return;
    }
    if (!e.isFile() || child.toLowerCase() === META_FILE) return;
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      out.files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      out.birth.set(child, st.birthtimeMs);
    } catch { /* vanished mid-walk */ }
  }));
  for (const d of dirs) await walk(root, d, out);
}

async function build(root: string, now: () => number): Promise<WorkspaceSnapshot> {
  const walked: Walked = { files: [], folders: [], birth: new Map() };
  const [meta] = await Promise.all([
    readJsonAsync<Partial<WorkspaceJson>>(path.join(root, META_FILE), {}).then(normaliseMeta),
    walk(root, '', walked),
  ]);
  return finish(walked.files, meta, walked.folders, walked.birth, now());
}

function finish(
  files: FileEntry[], meta: WorkspaceJson, folders: AssetFolder[], birth: Map<string, number>, builtAt: number, assets?: TypstAsset[],
): WorkspaceSnapshot {
  files.sort(byPath);
  folders.sort(byId);
  if (!assets) {
    assets = [];
    for (const f of files) {
      const a = assetFromFile(f, meta, birth.get(f.path) ?? null);
      if (a) assets.push(a);
    }
  }
  return { files, meta, assets, folders, etag: etagOf(files, meta), builtAt };
}

export function createWorkspaceIndex(opts: { maxAgeMs?: number; now?: () => number } = {}): WorkspaceIndex {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  let builds = 0;

  const entryFor = (root: string): Entry => {
    const key = path.resolve(root);
    let e = entries.get(key);
    if (!e) { e = { snap: null, building: null, pending: new Set(), stale: false }; entries.set(key, e); }
    return e;
  };

  /** Re-stat the touched files and patch them into the snapshot; null if a rebuild is needed. */
  const patch = async (root: string, e: Entry, snap: WorkspaceSnapshot): Promise<WorkspaceSnapshot | null> => {
    const rels = [...e.pending];
    e.pending.clear();
    const files = snap.files.slice();
    for (const rel of rels) {
      let st: Awaited<ReturnType<typeof fsp.stat>> | null;
      try { st = await fsp.stat(path.join(path.resolve(root), ...rel.split('/'))); } catch { st = null; }
      const i = files.findIndex((f) => f.path === rel);
      if (st === null) {
        if (i !== -1) files.splice(i, 1);
        continue;
      }
      if (st.isDirectory()) return null;
      const next: FileEntry = { path: rel, size: st.size, mtime: Math.round(st.mtimeMs) };
      if (i === -1) files.push(next);
      else files[i] = next;
    }
    // Assets never take this path (a touch under assets/ or fonts/ rebuilds),
    // so the previous records stay valid and keep their identity.
    return finish(files, snap.meta, snap.folders, new Map(), snap.builtAt, snap.assets);
  };

  const rebuild = (root: string, e: Entry): Promise<WorkspaceSnapshot> => {
    if (e.building) return e.building;
    builds += 1;
    e.stale = false;
    e.pending.clear();
    const p = build(path.resolve(root), now)
      .then((snap) => { e.snap = snap; return snap; })
      .finally(() => { if (e.building === p) e.building = null; });
    e.building = p;
    return p;
  };

  return {
    get builds() { return builds; },
    has: (root) => !!entries.get(path.resolve(root))?.snap,
    invalidate(root) {
      const e = entries.get(path.resolve(root));
      if (!e) return;
      e.stale = true;
      e.pending.clear();
    },
    touch(root, rel) {
      const e = entryFor(root);
      const r = toRel(rel);
      if (!r) return;
      if (isStructural(r)) { e.stale = true; e.pending.clear(); return; }
      if (!e.stale) e.pending.add(r);
    },
    async get(root) {
      const e = entryFor(root);
      if (e.building) return e.building;
      const snap = e.snap;
      if (!snap || e.stale || now() - snap.builtAt > maxAgeMs) return rebuild(root, e);
      if (e.pending.size === 0) return snap;
      const patched = await patch(root, e, snap);
      if (patched === null) return rebuild(root, e);
      // A touch that arrived while we were patching stays pending for the next read.
      if (e.snap === snap) e.snap = patched;
      return e.snap ?? patched;
    },
  };
}
