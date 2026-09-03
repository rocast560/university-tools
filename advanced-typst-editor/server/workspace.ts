import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, FileEntry, TypstAsset, WorkspaceJson } from '../src/types';
import { ALLOWED_EXTENSIONS, extensionOf, mimeFor } from './assets';
import { readJson, writeAtomic } from './fsx';
import { HttpError } from './http';
import { normalizeRel, resolveInside } from './paths';

export const META_FILE = 'workspace.json';
export const ASSETS_DIR = 'assets';
export const FONTS_DIR = 'fonts';
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '__pycache__']);

export const EMPTY_META: WorkspaceJson = { version: 1, assets: {}, fonts: {} };

export function etagOf(st: fs.Stats): string {
  return `${Math.round(st.mtimeMs)}-${st.size}`;
}

export interface WorkspaceFs {
  readonly root: string;
  listFiles(): FileEntry[];
  typFiles(): string[];
  readFile(rel: string): { bytes: Uint8Array; etag: string } | null;
  /** Throws HttpError(400) on a bad path; never writes workspace.json (use writeMeta). */
  writeFile(rel: string, bytes: Uint8Array): FileEntry;
  deleteFile(rel: string): boolean;
  readMeta(): WorkspaceJson;
  writeMeta(meta: WorkspaceJson): void;
  listAssets(): TypstAsset[];
  listFolders(): AssetFolder[];
  /** Absolute path for a validated relative path, or throws HttpError(400). */
  abs(rel: string): string;
  // Task 5 adds the mutation methods below this line.
}

function walk(root: string, rel: string, out: FileEntry[]): void {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (e.name.endsWith('.tmp')) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, child, out);
    else if (e.isFile()) {
      if (child.toLowerCase() === META_FILE) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* vanished mid-walk */ }
    }
  }
}

function normaliseMeta(raw: Partial<WorkspaceJson>): WorkspaceJson {
  return {
    version: 1,
    assets: raw.assets && typeof raw.assets === 'object' ? raw.assets : {},
    fonts: raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {},
  };
}

export function openWorkspace(root: string, opts: { now?: () => number } = {}): WorkspaceFs {
  const now = opts.now ?? (() => Date.now());
  const rootAbs = path.resolve(root);

  const abs = (rel: string): string => {
    const n = normalizeRel(rel);
    if (n === null || n === '') throw new HttpError(400, `invalid path: ${rel}`);
    const a = resolveInside(rootAbs, n);
    if (!a) throw new HttpError(400, `path escapes the workspace: ${rel}`);
    return a;
  };

  const readMeta = (): WorkspaceJson => normaliseMeta(readJson<Partial<WorkspaceJson>>(path.join(rootAbs, META_FILE), {}));

  const listFiles = (): FileEntry[] => { const out: FileEntry[] = []; walk(rootAbs, '', out); return out; };

  const listAssets = (): TypstAsset[] => {
    const meta = readMeta();
    const out: TypstAsset[] = [];
    for (const f of listFiles()) {
      const top = f.path.split('/')[0];
      const kind = top === ASSETS_DIR ? 'image' : top === FONTS_DIR ? 'font' : null;
      if (!kind) continue;
      const ext = extensionOf(f.path);
      if (!ALLOWED_EXTENSIONS[kind].includes(ext)) continue;
      const filename = path.posix.basename(f.path);
      const dirRel = path.posix.dirname(f.path);
      const folderId = kind === 'image' && dirRel !== ASSETS_DIR ? dirRel.slice(ASSETS_DIR.length + 1) : null;
      let createdAt = f.mtime;
      try { createdAt = Math.round(fs.statSync(path.join(rootAbs, ...f.path.split('/'))).birthtimeMs) || f.mtime; } catch { /* keep mtime */ }
      const m = kind === 'image' ? meta.assets[f.path] : undefined;
      const fm = kind === 'font' ? meta.fonts[f.path] : undefined;
      out.push({
        id: f.path,
        kind,
        filename,
        mime: mimeFor(kind, filename) ?? 'application/octet-stream',
        size: f.size,
        etag: `${f.mtime}-${f.size}`,
        width: m?.width ?? null,
        height: m?.height ?? null,
        crop: m?.crop ?? null,
        blurs: m?.blurs ?? null,
        fontFamily: fm?.family ?? null,
        folderId,
        createdAt,
        updatedAt: f.mtime,
      });
    }
    return out;
  };

  const listFolders = (): AssetFolder[] => {
    const out: AssetFolder[] = [];
    const base = path.join(rootAbs, ASSETS_DIR);
    const visit = (rel: string) => {
      const dir = rel ? path.join(base, ...rel.split('/')) : base;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const id = rel ? `${rel}/${e.name}` : e.name;
        let t = now();
        try { t = Math.round(fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* keep now */ }
        out.push({ id, name: e.name, parentId: rel || null, createdAt: t, updatedAt: t });
        visit(id);
      }
    };
    visit('');
    return out;
  };

  return {
    root: rootAbs,
    abs,
    listFiles,
    typFiles: () => listFiles().map((f) => f.path).filter((p) => p.endsWith('.typ')).sort(),
    readFile(rel) {
      const n = normalizeRel(rel);
      if (n === null || n === '') return null;
      const a = resolveInside(rootAbs, n);
      if (!a) return null;
      try {
        const st = fs.statSync(a);
        if (!st.isFile()) return null;
        return { bytes: new Uint8Array(fs.readFileSync(a)), etag: etagOf(st) };
      } catch { return null; }
    },
    writeFile(rel, bytes) {
      const n = normalizeRel(rel);
      if (n && n.toLowerCase() === META_FILE) throw new HttpError(400, 'workspace.json is managed by the app');
      const a = abs(rel);
      writeAtomic(a, bytes);
      const st = fs.statSync(a);
      return { path: n as string, size: st.size, mtime: Math.round(st.mtimeMs) };
    },
    deleteFile(rel) {
      const a = abs(rel);
      try { fs.unlinkSync(a); return true; } catch { return false; }
    },
    readMeta,
    writeMeta(meta) { writeAtomic(path.join(rootAbs, META_FILE), JSON.stringify(normaliseMeta(meta), null, 2)); },
    listAssets,
    listFolders,
  };
}
